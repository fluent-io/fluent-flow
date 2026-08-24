import { Router } from 'express';
import { z } from 'zod';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession, setSessionStatus } from '../agents/session-manager.js';
import {
  completeClaim,
  failClaim,
  getClaimByAttempt,
  getClaimById,
  completeClaimById,
  failClaimById,
  extendClaim,
  redispatchClaim,
  createClaim,
} from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
import { sql } from 'drizzle-orm';
import { db } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';
import { getInstallationToken } from '../providers/github/token-cache.js';
import { installationCtxForRepo } from '../config/loader.js';

const router = Router();

const PollSchema = z.object({
  session_id: z.number().int().positive(),
});

const ClaimResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  repo: z.string().min(1),
  pr_number: z.number().int().positive().nullable(),
  attempt: z.number().int().positive(),
  verdict: z.enum(['pass', 'fail']).optional(), // review verdict for chaining
  claim_id: z.number().int().positive().optional(), // unambiguous claim identity
  failure_kind: z.enum(['transient', 'terminal']).optional(), // transient → server re-dispatches
});

const HeartbeatSchema = z.object({
  session_id: z.number().int().positive(),
  claim_id: z.number().int().positive().optional(),
});

/** How far a heartbeat extends a claimed claim's expiry. Env: CLAIM_TTL_MS. */
const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_MS) || 15 * 60 * 1000;

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
 * Resolve GitHub App installation token for a repo.
 * Returns the token string or undefined if resolution fails.
 */
async function resolveGitHubToken(fullRepo) {
  if (!fullRepo?.includes('/')) return undefined;
  try {
    const [owner, repoName] = fullRepo.split('/');
    const ctx = await installationCtxForRepo(owner, repoName);
    if (ctx?.installation_id) {
      const token = await getInstallationToken(ctx.installation_id);
      logger.info({ msg: 'Resolved GitHub App token for runner', repo: fullRepo, installationId: ctx.installation_id });
      return token;
    }
    logger.info({ msg: 'No installation context for repo', repo: fullRepo });
  } catch (err) {
    logger.warn({ msg: 'Could not resolve GitHub App token for runner', repo: fullRepo, error: err.message });
  }
  return undefined;
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

  // Resolve the agent's type once for inclusion in work payloads
  let agentType = 'claude-code'; // default
  try {
    const agentRows = await db.execute(sql`SELECT agent_type FROM agents WHERE org_id = ${org_id} AND id = ${agent_id}`);
    if (agentRows.rows?.[0]?.agent_type) agentType = agentRows.rows[0].agent_type;
  } catch {
    // Safe to continue: agent_type lookup failure — fall back to
    // the default 'claude-code'. Non-critical metadata.
  }

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

    // Long-poll hints are wake-up signals only — the dequeued payload lacks
    // attempt/claim_type/message and cannot be reported back by the runner.
    // Drain the hint and let claimPendingWork() hand out the real DB row.
    if (hasPending(sessionId)) {
      dequeue(sessionId);
    }

    // Check for unassigned pending claims in the DB
    const pendingClaim = await claimPendingWork(org_id, agent_id, sessionId);
    if (pendingClaim) {
      const payload = typeof pendingClaim.payload === 'string'
        ? JSON.parse(pendingClaim.payload)
        : pendingClaim.payload;

      const githubToken = await resolveGitHubToken(pendingClaim.repo);

      respond({
        work: {
          repo: pendingClaim.repo,
          pr_number: pendingClaim.pr_number,
          attempt: pendingClaim.attempt,
          claim_id: pendingClaim.id,
          claim_type: pendingClaim.claim_type,
          agentType,
          ...(githubToken ? { githubToken } : {}),
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
        dequeue(sessionId); // wake-up signal only — claim from the DB below
      }
      const loopClaim = await claimPendingWork(org_id, agent_id, sessionId);
      if (loopClaim) {
        await touchSession(org_id, agent_id, sessionId);
        const lp = typeof loopClaim.payload === 'string' ? JSON.parse(loopClaim.payload) : loopClaim.payload;
        const githubToken = await resolveGitHubToken(loopClaim.repo);
        respond({
          work: {
            repo: loopClaim.repo,
            pr_number: loopClaim.pr_number,
            attempt: loopClaim.attempt,
            claim_id: loopClaim.id,
            claim_type: loopClaim.claim_type,
            agentType,
            ...(githubToken ? { githubToken } : {}),
            ...lp,
          },
        });
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
    const { status, repo, pr_number, attempt, claim_id, failure_kind } = parsed.data;

    if (status === 'completed') {
      // Resolve the claim by id when the runner sent one — the id path can
      // never collide two claim types sharing an attempt number. Fall back
      // to the natural key only for older runners.
      let claim;
      let alreadyResolved = null;
      if (claim_id != null) {
        claim = await completeClaimById(org_id, claim_id);
        if (!claim) {
          const existing = await getClaimById(org_id, claim_id);
          if (existing?.status === 'completed' || existing?.status === 'failed') {
            alreadyResolved = existing;
          }
        }
      } else {
        const existingClaim = await getClaimByAttempt(org_id, repo, pr_number, attempt);
        claim = await completeClaim(org_id, repo, pr_number, attempt, existingClaim?.claim_type ?? 'review_fix');
        if (!claim && (existingClaim?.status === 'completed' || existingClaim?.status === 'failed')) {
          alreadyResolved = existingClaim;
        }
      }
      if (!claim) {
        if (alreadyResolved) {
          // Claim may already be completed via webhook (pull_request_review) — treat as success
          return res.json({ ok: true, claim_id: alreadyResolved.id, status: alreadyResolved.status, note: 'already_resolved' });
        }
        return res.status(404).json({ error: 'Claim not found or already resolved' });
      }
      const claimType = claim.claim_type ?? 'review_fix';

      // Verdict fallback: review agents that post via `gh api` put the marker
      // in the GitHub review body, not stdout. Fetch the latest review and
      // parse it before treating this result as verdict-less — otherwise the
      // review→review_fix chain and auto-merge silently never fire.
      let verdict = parsed.data.verdict;
      if (claimType === 'review' && !verdict && pr_number != null) {
        try {
          const [owner, repoName] = repo.split('/');
          const { fetchLatestReviewVerdict } = await import('../engine/review-manager.js');
          verdict = await fetchLatestReviewVerdict({ owner, repo: repoName, prNumber: pr_number });
          if (verdict) {
            logger.info({ msg: 'Review verdict resolved from GitHub review body', repo, prNumber: pr_number, verdict });
          }
        } catch (err) {
          // Safe to continue: the posted review is already on the PR; the
          // auto-chain simply doesn't fire for this attempt.
          logger.warn({ msg: 'Verdict fallback failed', repo, prNumber: pr_number, error: err.message });
        }
      }

      audit('claim_result', { repo, data: { claimId: claim.id, pr_number, attempt, status, claimType, verdict: verdict ?? null } });

      // Auto-chain: review FAIL → review_fix
      if (claimType === 'review' && verdict === 'fail') {
        try {
          await createClaim({
            orgId: org_id,
            repo,
            prNumber: pr_number,
            attempt: attempt + 1,
            claimType: 'review_fix',
            payload: { source_claim_id: claim.id, branch: claim.payload?.branch },
          });
          logger.info({ msg: 'Auto-created review_fix claim after FAIL review', repo, prNumber: pr_number, attempt: attempt + 1 });
        } catch (err) {
          // Safe to continue: review_fix claim creation failure — the
          // original review result is already recorded. The agent can
          // manually pick up the work via polling.
          logger.error({ msg: 'Failed to create review_fix claim', error: err.message });
        }
      }

      // Auto-chain: spec → build (only if payload.auto_chain !== false)
      if (claimType === 'spec' && claim.payload?.auto_chain !== false) {
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
          // Safe to continue: build claim creation failure — the spec
          // completion is already recorded. The build can be manually
          // triggered via the API.
          logger.error({ msg: 'Failed to create follow-on build claim', error: err.message });
        }
      }

      // Auto-chain: test_verify → re-review
      if (claimType === 'test_verify') {
        try {
          const [owner, repoName] = repo.split('/');
          const { dispatchReview } = await import('../engine/review-manager.js');
          // test_verify claim stores the PR head branch in payload.branch (see check-run-handler);
          // fall back to 'main' only if it's missing for some reason.
          const headBranch = claim.payload?.branch ?? 'main';
          const headSha = claim.head_sha;
          const issueNumber = claim.payload?.issueNumber;
          await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, headSha, attempt: attempt + 1, issueNumber });
          logger.info({ msg: 'Triggered re-review after test_verify completion', repo, prNumber: pr_number, ref: headBranch, headSha });
        } catch (err) {
          // Safe to continue: re-review dispatch failure — the test_verify
          // completion is already recorded. A manual review can be
          // triggered via the API.
          logger.error({ msg: 'Failed to trigger re-review after test_verify', error: err.message });
        }
      }

      res.json({ ok: true, claim_id: claim.id, status: claim.status });
    } else {
      // Failed claim — transient failures are re-dispatched at attempt + 1;
      // terminal failures (default) stay final, as before.
      let claim;
      if (claim_id != null) {
        claim = await failClaimById(org_id, claim_id);
      } else {
        // Narrow the natural-key update by claim type so a failure report
        // can't mark BOTH claim types sharing this attempt number as failed.
        const existing = await getClaimByAttempt(org_id, repo, pr_number, attempt);
        claim = await failClaim(org_id, repo, pr_number, attempt, existing?.claim_type ?? null);
      }
      if (!claim) {
        const existingClaim = claim_id != null
          ? await getClaimById(org_id, claim_id)
          : await getClaimByAttempt(org_id, repo, pr_number, attempt);
        if (existingClaim?.status === 'completed' || existingClaim?.status === 'failed') {
          return res.json({ ok: true, claim_id: existingClaim.id, status: existingClaim.status, note: 'already_resolved' });
        }
        return res.status(404).json({ error: 'Claim not found or already resolved' });
      }
      audit('claim_result', { repo, data: { claimId: claim.id, pr_number, attempt, status: 'failed', failure_kind: failure_kind ?? 'terminal' } });
      if (failure_kind === 'transient') {
        try {
          const redispatched = await redispatchClaim(claim);
          logger.info({
            msg: 'Re-dispatched transient-failed claim',
            repo,
            prNumber: pr_number,
            oldAttempt: claim.attempt,
            newAttempt: redispatched ? claim.attempt + 1 : null,
            claimId: redispatched?.id ?? null,
          });
        } catch (err) {
          // Safe to continue: the failure is already durably recorded; a lost
          // re-dispatch leaves the pipeline paused for manual dispatch rather
          // than corrupting state.
          logger.error({ msg: 'Failed to re-dispatch transient-failed claim', error: err.message, claimId: claim.id });
        }
      }
      res.json({ ok: true, claim_id: claim.id, status: claim.status });
    }
  } catch (err) {
    logger.error({ msg: 'Failed to report claim result', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/runner/heartbeat — keep a session and its active claim alive
 * while a runner executes a long agent run. Touches the session (same
 * semantics as the poll touch); when claim_id is present and currently
 * claimed by this session, extends the claim's expires_at by CLAIM_TTL_MS.
 */
export async function handleHeartbeat(req, res) {
  const parsed = HeartbeatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  try {
    const { org_id, agent_id } = req.tokenInfo;
    const { session_id: sessionId, claim_id: claimId } = parsed.data;

    const alive = await touchSession(org_id, agent_id, sessionId);
    if (!alive) {
      return res.status(410).json({ error: 'Session expired or offline — re-register' });
    }

    if (claimId != null) {
      const extended = await extendClaim({ orgId: org_id, claimId, sessionId, ttlMs: CLAIM_TTL_MS });
      if (extended) {
        // Audit only actual claim extensions — session-only heartbeats fire
        // every FLUENT_FLOW_HEARTBEAT_MS and would flood the audit log.
        audit('claim_heartbeat', { data: { claimId, sessionId } });
        return res.json({ ok: true, claim: { id: claimId } });
      }
      return res.json({ ok: true, claim: null });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ msg: 'Failed to process runner heartbeat', error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

router.use('/runner', authenticateRunner);
router.post('/runner/register', handleRegister);
router.post('/runner/poll', handlePoll);
router.post('/runner/heartbeat', handleHeartbeat);
router.post('/runner/claim', handleClaimResult);

export default router;
