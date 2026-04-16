import { Router } from 'express';
import { z } from 'zod';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession, setSessionStatus } from '../agents/session-manager.js';
import { completeClaim, failClaim, getClaimByAttempt, createClaim } from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
import { sql } from 'drizzle-orm';
import { db } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const router = Router();

const PollSchema = z.object({
  session_id: z.number().int().positive(),
});

const ClaimResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  attempt: z.number().int().positive(),
});

/**
 * Authenticate runner requests via agent token.
 */
export async function authenticateRunner(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const tokenInfo = await validateToken(auth.slice(7));
    if (!tokenInfo) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.tokenInfo = tokenInfo;
    next();
  } catch (err) {
    logger.error({ msg: 'Failed to validate runner token', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/runner/register — register a new session.
 */
export async function handleRegister(req, res) {
  try {
    const { org_id, agent_id } = req.tokenInfo;
    const meta = req.body?.meta ?? {};
    const session = await registerSession(org_id, agent_id, meta);
    res.json({ ok: true, session_id: session.id, status: session.status });
  } catch (err) {
    logger.error({ msg: 'Failed to register session', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check for unassigned pending claims that match this agent's repo scope.
 * Atomically claims the first match.
 */
export async function claimPendingWork(orgId, agentId, sessionId, ttlMs = 15 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + ttlMs);
  // UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) — the canonical
  // atomic claim pattern. Kept as raw SQL because drizzle doesn't express
  // UPDATE-from-locked-subselect ergonomically.
  const result = await db.execute(sql`
    UPDATE agent_claims SET
      session_id = ${sessionId},
      status = 'claimed',
      claimed_at = NOW(),
      expires_at = ${expiresAt}
    WHERE id = (
      SELECT c.id FROM agent_claims c
      JOIN agents a ON a.org_id = c.org_id AND a.id = ${agentId}
      WHERE c.org_id = ${orgId}
        AND c.status = 'pending'
        AND c.session_id IS NULL
        AND (a.repos = '{}' OR c.repo = ANY(a.repos))
      ORDER BY c.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = result.rows ?? result;
  const claim = rows[0] ?? null;
  if (claim) {
    await setSessionStatus(orgId, agentId, sessionId, 'busy');
  }
  return claim;
}

/**
 * POST /api/runner/poll — long-poll for work.
 */
export async function handlePoll(req, res, opts = {}) {
  const parsed = PollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const { org_id, agent_id } = req.tokenInfo;
  const sessionId = parsed.data.session_id;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30000;

  let sent = false;
  const respond = (data) => {
    if (sent || res.headersSent) return;
    sent = true;
    res.json(data);
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    const sessionAlive = await touchSession(org_id, agent_id, sessionId);
    if (!sessionAlive) {
      return res.status(410).json({ error: 'Session expired or offline — re-register' });
    }

    if (hasPending(sessionId)) {
      respond({ work: dequeue(sessionId) });
      return;
    }

    // Check for unassigned pending claims in the DB
    const pendingClaim = await claimPendingWork(org_id, agent_id, sessionId);
    if (pendingClaim) {
      const payload = typeof pendingClaim.payload === 'string'
        ? JSON.parse(pendingClaim.payload)
        : pendingClaim.payload;
      respond({
        work: {
          repo: pendingClaim.repo,
          pr_number: pendingClaim.pr_number,
          attempt: pendingClaim.attempt,
          claim_id: pendingClaim.id,
          ...payload,
        },
      });
      return;
    }

    if (pollTimeoutMs === 0) {
      respond({ work: null });
      return;
    }

    const start = Date.now();
    while (!closed && !sent) {
      if (hasPending(sessionId)) {
        await touchSession(org_id, agent_id, sessionId);
        respond({ work: dequeue(sessionId) });
        return;
      }
      const loopClaim = await claimPendingWork(org_id, agent_id, sessionId);
      if (loopClaim) {
        await touchSession(org_id, agent_id, sessionId);
        const lp = typeof loopClaim.payload === 'string' ? JSON.parse(loopClaim.payload) : loopClaim.payload;
        respond({ work: { repo: loopClaim.repo, pr_number: loopClaim.pr_number, attempt: loopClaim.attempt, claim_id: loopClaim.id, ...lp } });
        return;
      }
      if (Date.now() - start >= pollTimeoutMs) {
        await touchSession(org_id, agent_id, sessionId);
        respond({ work: null });
        return;
      }
      await sleep(1000);
      if (closed) return;
    }
  } catch (err) {
    logger.error({ msg: 'Failed to poll', error: err.message });
    if (!sent && !res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

/**
 * POST /api/runner/claim — report claim result.
 */
export async function handleClaimResult(req, res) {
  const parsed = ClaimResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  try {
    const { org_id } = req.tokenInfo;
    const { status, repo, pr_number, attempt } = parsed.data;

    if (status === 'completed') {
      // Look up claim_type before completing (for chaining)
      const existingClaim = await getClaimByAttempt(org_id, repo, pr_number, attempt);
      const claimType = existingClaim?.claim_type ?? 'review_fix';

      const claim = await completeClaim(org_id, repo, pr_number, attempt);
      if (!claim) {
        return res.status(404).json({ error: 'Claim not found or already resolved' });
      }

      audit('claim_result', { repo, data: { claimId: claim.id, pr_number, attempt, status, claimType } });

      // Auto-chain: spec → build
      if (claimType === 'spec') {
        try {
          await createClaim({
            orgId: org_id,
            repo,
            prNumber: pr_number,
            attempt: attempt + 1,
            claimType: 'build',
            payload: { source_claim_id: claim.id },
          });
          logger.info({ msg: 'Auto-created build claim after spec completion', repo, prNumber: pr_number, attempt: attempt + 1 });
        } catch (err) {
          logger.error({ msg: 'Failed to create follow-on build claim', error: err.message });
        }
      }

      // Auto-chain: test_verify → re-review
      if (claimType === 'test_verify') {
        try {
          const [owner, repoName] = repo.split('/');
          const { dispatchReview } = await import('../engine/review-manager.js');
          await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: 'main', attempt: attempt + 1 });
          logger.info({ msg: 'Triggered re-review after test_verify completion', repo, prNumber: pr_number });
        } catch (err) {
          logger.error({ msg: 'Failed to trigger re-review after test_verify', error: err.message });
        }
      }

      res.json({ ok: true, claim_id: claim.id, status: claim.status });
    } else {
      // Failed claim — no chaining
      const claim = await failClaim(org_id, repo, pr_number, attempt);
      if (!claim) {
        return res.status(404).json({ error: 'Claim not found or already resolved' });
      }
      audit('claim_result', { repo, data: { claimId: claim.id, pr_number, attempt, status: 'failed' } });
      res.json({ ok: true, claim_id: claim.id, status: claim.status });
    }
  } catch (err) {
    logger.error({ msg: 'Failed to report claim result', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.use('/runner', authenticateRunner);
router.post('/runner/register', handleRegister);
router.post('/runner/poll', handlePoll);
router.post('/runner/claim', handleClaimResult);

export default router;
