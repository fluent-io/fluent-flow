import { query, audit } from '../db/client.js';
import { resolveSession, setSessionStatus } from './session-manager.js';
import logger from '../logger.js';

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Look up the agent_id for a session (needed for scoped setSessionStatus).
 * @param {number} sessionId
 * @returns {Promise<string|null>}
 */
async function getSessionAgentId(sessionId) {
  const result = await query(
    `SELECT agent_id FROM agent_sessions WHERE id = $1`,
    [sessionId]
  );
  return result.rows[0]?.agent_id ?? null;
}

/**
 * Free a session back to online after a claim resolves.
 * @param {string} orgId
 * @param {number} sessionId
 * @param {string} targetStatus
 */
async function freeSession(orgId, sessionId, targetStatus = 'online') {
  if (!sessionId) return;
  const agentId = await getSessionAgentId(sessionId);
  if (agentId) {
    await setSessionStatus(orgId, agentId, sessionId, targetStatus);
  }
}

/**
 * Create a claim for a review attempt. Resolves a session and assigns if available.
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {string} opts.agentId
 * @param {object} opts.payload
 * @param {string} [opts.claimType='review_fix']
 * @param {number} [opts.ttlMs]
 * @returns {Promise<object>}
 */
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  const sessionId = await resolveSession(orgId, agentId, repo, prNumber);
  const status = sessionId ? 'claimed' : 'pending';
  const claimedAt = sessionId ? new Date().toISOString() : null;
  const expiresAt = sessionId ? new Date(Date.now() + ttlMs).toISOString() : null;

  const result = await query(
    `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload, claimed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, repo, pr_number, attempt)
     DO UPDATE SET session_id = $5, claim_type = $6, status = $7, payload = $8, claimed_at = $9, expires_at = $10
     RETURNING *`,
    [orgId, repo, prNumber, attempt, sessionId, claimType, status, JSON.stringify(payload), claimedAt, expiresAt]
  );

  if (sessionId) {
    await setSessionStatus(orgId, agentId, sessionId, 'busy');
  }

  const claim = result.rows[0];
  audit('claim_created', { repo, data: { claimId: claim.id, prNumber, attempt, sessionId, status, claimType } });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status, claimType });
  return claim;
}

/**
 * Mark a claim as completed. Frees the session.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} attempt
 * @returns {Promise<object|null>}
 */
export async function completeClaim(orgId, repo, prNumber, attempt) {
  const result = await query(
    `UPDATE agent_claims SET status = 'completed', completed_at = NOW()
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3 AND attempt = $4
       AND status IN ('claimed', 'pending')
     RETURNING *`,
    [orgId, repo, prNumber, attempt]
  );
  const claim = result.rows[0];
  if (claim) await freeSession(orgId, claim.session_id, 'online');
  return claim ?? null;
}

/**
 * Mark a claim as failed. Frees the session.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} attempt
 * @returns {Promise<object|null>}
 */
export async function failClaim(orgId, repo, prNumber, attempt) {
  const result = await query(
    `UPDATE agent_claims SET status = 'failed', completed_at = NOW()
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3 AND attempt = $4
       AND status IN ('claimed', 'pending')
     RETURNING *`,
    [orgId, repo, prNumber, attempt]
  );
  const claim = result.rows[0];
  if (claim) await freeSession(orgId, claim.session_id, 'online');
  return claim ?? null;
}

/**
 * Expire all overdue claims. Sets associated sessions to offline.
 * @returns {Promise<Array>}
 */
export async function expireClaims() {
  const result = await query(
    `UPDATE agent_claims SET status = 'expired'
     WHERE status = 'claimed' AND expires_at < NOW()
     RETURNING *`,
    []
  );
  for (const claim of result.rows) {
    await freeSession(claim.org_id, claim.session_id, 'offline');
  }
  if (result.rows.length > 0) {
    logger.info({ msg: 'Claims expired', count: result.rows.length });
  }
  return result.rows;
}

/**
 * Get the active claim (pending or claimed) for a PR.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<object|null>}
 */
export async function getActiveClaim(orgId, repo, prNumber) {
  const result = await query(
    `SELECT * FROM agent_claims
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3
       AND status IN ('pending', 'claimed')
     ORDER BY attempt DESC LIMIT 1`,
    [orgId, repo, prNumber]
  );
  return result.rows[0] ?? null;
}
