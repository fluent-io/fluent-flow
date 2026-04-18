import crypto from 'node:crypto';
import { getPool, query } from '../pool.js';

const TOKEN_PREFIX = 'ff_';

function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export async function regenerateKey(orgId: string, agentId: string): Promise<{ plaintext: string; id: number }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
      [orgId, agentId],
    );

    const plaintext = generateToken();
    const hash = hashToken(plaintext);

    const result = await client.query(
      `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label) VALUES ($1, $2, $3, $4) RETURNING id, org_id, agent_id, created_at`,
      [orgId, agentId, hash, 'default'],
    );

    await client.query('COMMIT');
    return { plaintext, ...result.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getKeyInfo(orgId: string, agentId: string): Promise<{ id: number; created_at: Date } | null> {
  const result = await query(
    `SELECT id, created_at FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}

const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface CreateTokenInput {
  orgId: string;
  agentId: string;
  label: string;
  expiresAt?: Date;
}

/**
 * Insert a new long-lived agent token row and return the plaintext (shown
 * once). Used by the dashboard's "+ New agent" flow and by the fluent-flow
 * server's MCP admin API. Plaintext is SHA-256-hashed before storage — only
 * the hash lives in the DB.
 */
export async function createToken(input: CreateTokenInput): Promise<{ plaintext: string; id: number }> {
  const plaintext = generateToken();
  const hash = hashToken(plaintext);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS);

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.orgId, input.agentId, hash, input.label, expiresAt],
  );
  return { plaintext, id: result.rows[0].id };
}
