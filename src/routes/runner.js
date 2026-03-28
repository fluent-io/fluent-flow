import { Router } from 'express';
import { z } from 'zod';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession } from '../agents/session-manager.js';
import { completeClaim, failClaim } from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
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
    await touchSession(org_id, agent_id, sessionId);

    if (hasPending(sessionId)) {
      respond({ work: dequeue(sessionId) });
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

    const claim = status === 'completed'
      ? await completeClaim(org_id, repo, pr_number, attempt)
      : await failClaim(org_id, repo, pr_number, attempt);

    if (!claim) {
      return res.status(404).json({ error: 'Claim not found or already resolved' });
    }

    audit('claim_result', { repo, data: { claimId: claim.id, status } });
    res.json({ ok: true, claim_id: claim.id, status: claim.status });
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
