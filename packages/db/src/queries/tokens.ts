import crypto from 'node:crypto';
import { query } from '../pool.js';

const TOKEN_PREFIX = 'ff_';

function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export async function regenerateKey(orgId: string, agentId: string): Promise<{ plaintext: string; id: number }> {
  await query(
    `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
    [orgId, agentId],
  );

  const plaintext = generateToken();
  const hash = hashToken(plaintext);

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label) VALUES ($1, $2, $3, $4) RETURNING id, org_id, agent_id, created_at`,
    [orgId, agentId, hash, 'default'],
  );

  return { plaintext, ...result.rows[0] };
}

export async function getKeyInfo(orgId: string, agentId: string): Promise<{ id: number; created_at: Date } | null> {
  const result = await query(
    `SELECT id, created_at FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}
