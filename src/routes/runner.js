import { Router } from 'express';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession } from '../agents/session-manager.js';
import { completeClaim, failClaim } from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const router = Router();

/**
 * Authenticate runner requests via agent token.
 */
export async function authenticateRunner(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const tokenInfo = await validateToken(auth.slice(7));
  if (!tokenInfo) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.tokenInfo = tokenInfo;
  next();
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

/**
 * POST /api/runner/poll — long-poll for work.
 */
export async function handlePoll(req, res, opts = {}) {
  const sessionId = req.body?.session_id;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30000;

  try {
    await touchSession(sessionId);

    if (hasPending(sessionId)) {
      return res.json({ work: dequeue(sessionId) });
    }

    if (pollTimeoutMs === 0) {
      return res.json({ work: null });
    }

    const start = Date.now();
    const interval = setInterval(async () => {
      if (hasPending(sessionId)) {
        clearInterval(interval);
        await touchSession(sessionId);
        return res.json({ work: dequeue(sessionId) });
      }
      if (Date.now() - start >= pollTimeoutMs) {
        clearInterval(interval);
        await touchSession(sessionId);
        return res.json({ work: null });
      }
    }, 1000);
  } catch (err) {
    logger.error({ msg: 'Failed to poll', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/runner/claim/:id — report claim result.
 */
export async function handleClaimResult(req, res) {
  try {
    const { org_id } = req.tokenInfo;
    const { status, repo, pr_number, attempt } = req.body;

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
router.post('/runner/claim/:id', handleClaimResult);

export default router;
