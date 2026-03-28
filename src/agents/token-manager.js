import { randomBytes, createHash } from 'crypto';
import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const TOKEN_PREFIX = 'ff_';

/**
 * Hash a plaintext token using SHA-256.
 * @param {string} plaintext
 * @returns {string} hex hash
 */
export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Create a new agent token. Returns the plaintext token (only shown once).
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} [label]
 * @param {Date} [expiresAt]
 * @returns {Promise<{ plaintext: string, id: number }>}
 */
export async function createToken(orgId, agentId, label = null, expiresAt = null) {
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString('hex');
  const hash = hashToken(plaintext);

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, org_id, agent_id, label, created_at`,
    [orgId, agentId, hash, label, expiresAt]
  );

  audit('agent_token_created', { data: { orgId, agentId, tokenId: result.rows[0].id } });
  logger.info({ msg: 'Agent token created', orgId, agentId, tokenId: result.rows[0].id });

  return { plaintext, ...result.rows[0] };
}

/**
 * Validate a plaintext token. Returns token record if valid, null otherwise.
 * @param {string} plaintext
 * @returns {Promise<{ id: number, org_id: string, agent_id: string }|null>}
 */
export async function validateToken(plaintext) {
  const hash = hashToken(plaintext);
  const result = await query(
    `SELECT id, org_id, agent_id FROM agent_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash]
  );
  return result.rows[0] ?? null;
}

/**
 * Revoke a token by ID.
 * @param {string} orgId
 * @param {number} tokenId
 * @returns {Promise<boolean>}
 */
export async function revokeToken(orgId, tokenId) {
  const result = await query(
    `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [orgId, tokenId]
  );
  if (result.rowCount > 0) {
    audit('agent_token_revoked', { data: { orgId, tokenId } });
  }
  return result.rowCount > 0;
}

/**
 * List tokens for an agent (hashes redacted).
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
export async function listTokens(orgId, agentId) {
  const result = await query(
    `SELECT id, org_id, agent_id, label, created_at, expires_at, revoked_at
     FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 ORDER BY created_at`,
    [orgId, agentId]
  );
  return result.rows;
}
