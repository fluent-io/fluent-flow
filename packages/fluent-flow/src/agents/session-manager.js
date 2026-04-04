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
 * Scoped by org_id and agent_id for tenant isolation.
 * @param {string} orgId
 * @param {string} agentId
 * @param {number} sessionId
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 */
export async function touchSession(orgId, agentId, sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await query(
    `UPDATE agent_sessions SET last_seen_at = NOW(), expires_at = $4
     WHERE id = $3 AND org_id = $1 AND agent_id = $2 AND status != 'offline'`,
    [orgId, agentId, sessionId, expiresAt]
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
  // 1. Previous session affinity (gracefully handle missing agent_claims table)
  try {
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
  } catch (err) {
    if (err?.code === '42P01') {
      // agent_claims table doesn't exist yet — skip affinity
    } else {
      throw err;
    }
  }

  // 2. First available
  // Note: concurrent claims for different PRs could select the same session.
  // This is benign — the session receives both payloads and processes them sequentially.
  // True atomic allocation would require a transaction wrapping resolve + claim insert.
  const avail = await query(
    `SELECT id FROM agent_sessions
     WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()
     ORDER BY last_seen_at DESC LIMIT 1`,
    [orgId, agentId]
  );
  return avail.rows[0]?.id ?? null;
}

/**
 * Find any available session across all agents that can handle this repo.
 * Priority: previous session for this PR → first available session with repo scope match.
 * @param {string} orgId
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @returns {Promise<{agentId: string, sessionId: number}|null>}
 */
export async function findAvailableSession(orgId, repo, prNumber) {
  // 1. PR affinity — check if a prior claim used a session still online
  try {
    const prev = await query(
      `SELECT c.session_id FROM agent_claims c
       WHERE c.org_id = $1 AND c.repo = $2 AND c.pr_number = $3
         AND c.status IN ('completed', 'expired')
       ORDER BY c.attempt DESC LIMIT 1`,
      [orgId, repo, prNumber]
    );
    if (prev.rows[0]?.session_id) {
      const check = await query(
        `SELECT s.id, s.agent_id FROM agent_sessions s
         WHERE s.id = $1 AND s.status = 'online' AND s.expires_at > NOW()`,
        [prev.rows[0].session_id]
      );
      if (check.rows[0]) {
        return { agentId: check.rows[0].agent_id, sessionId: check.rows[0].id };
      }
    }
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  }

  // 2. Any available session — join sessions with agents, filter by repo scope
  const avail = await query(
    `SELECT s.id, s.agent_id FROM agent_sessions s
     JOIN agents a ON a.org_id = s.org_id AND a.id = s.agent_id
     WHERE s.org_id = $1 AND s.status = 'online' AND s.expires_at > NOW()
       AND (a.repos = '{}' OR $2 = ANY(a.repos))
     ORDER BY s.last_seen_at DESC LIMIT 1`,
    [orgId, repo]
  );
  if (avail.rows[0]) {
    return { agentId: avail.rows[0].agent_id, sessionId: avail.rows[0].id };
  }

  return null;
}

/**
 * Update session status. Scoped by org_id and agent_id for tenant isolation.
 * @param {string} orgId
 * @param {string} agentId
 * @param {number} sessionId
 * @param {string} status
 */
export async function setSessionStatus(orgId, agentId, sessionId, status) {
  await query(
    `UPDATE agent_sessions SET status = $4 WHERE id = $3 AND org_id = $1 AND agent_id = $2`,
    [orgId, agentId, sessionId, status]
  );
}
