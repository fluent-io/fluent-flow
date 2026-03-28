import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Register a new session for an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @param {object} [sessionMeta={}]
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 * @returns {Promise<object>}
 */
export async function registerSession(orgId, agentId, sessionMeta = {}, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const result = await query(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [orgId, agentId, JSON.stringify(sessionMeta), expiresAt]
  );
  audit('session_registered', { data: { orgId, agentId, sessionId: result.rows[0].id } });
  logger.info({ msg: 'Session registered', orgId, agentId, sessionId: result.rows[0].id });
  return result.rows[0];
}

/**
 * Touch a session — refresh last_seen_at and extend expiry.
 * @param {number} sessionId
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 */
export async function touchSession(sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await query(
    `UPDATE agent_sessions SET last_seen_at = NOW(), expires_at = $2
     WHERE id = $1 AND status != 'offline'`,
    [sessionId, expiresAt]
  );
}

/**
 * Expire all sessions past their TTL. Returns expired session IDs.
 * @returns {Promise<Array>}
 */
export async function expireSessions() {
  const result = await query(
    `UPDATE agent_sessions SET status = 'offline'
     WHERE status != 'offline' AND expires_at < NOW()
     RETURNING id, org_id, agent_id`,
    []
  );
  if (result.rows.length > 0) {
    logger.info({ msg: 'Sessions expired', count: result.rows.length });
  }
  return result.rows;
}

/**
 * Get active (online) sessions for an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
export async function getActiveSessions(orgId, agentId) {
  const result = await query(
    `SELECT * FROM agent_sessions
     WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()
     ORDER BY last_seen_at DESC`,
    [orgId, agentId]
  );
  return result.rows;
}

/**
 * Resolve the best session for a claim.
 * Priority: previous session for this PR → first available online session → null.
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<number|null>} session ID or null
 */
export async function resolveSession(orgId, agentId, repo, prNumber) {
  // 1. Previous session affinity
  const prev = await query(
    `SELECT session_id FROM agent_claims
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3
       AND status IN ('completed', 'expired')
     ORDER BY attempt DESC LIMIT 1`,
    [orgId, repo, prNumber]
  );
  if (prev.rows[0]?.session_id) {
    const check = await query(
      `SELECT id FROM agent_sessions
       WHERE id = $1 AND status = 'online' AND expires_at > NOW()`,
      [prev.rows[0].session_id]
    );
    if (check.rows[0]) return check.rows[0].id;
  }

  // 2. First available
  const avail = await query(
    `SELECT id FROM agent_sessions
     WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()
     ORDER BY last_seen_at DESC LIMIT 1`,
    [orgId, agentId]
  );
  return avail.rows[0]?.id ?? null;
}

/**
 * Update session status.
 * @param {number} sessionId
 * @param {string} status
 */
export async function setSessionStatus(sessionId, status) {
  await query(
    `UPDATE agent_sessions SET status = $2 WHERE id = $1`,
    [sessionId, status]
  );
}
