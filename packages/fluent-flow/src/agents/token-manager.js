import { randomBytes, createHash } from 'crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { agentTokens } = schema;

const TOKEN_PREFIX = 'ff_';

export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Create a new agent token. Returns the plaintext token (only shown once).
 */
export async function createToken(orgId, agentId, label = null, expiresAt = null) {
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString('hex');
  const hash = hashToken(plaintext);

  const [row] = await db
    .insert(agentTokens)
    .values({ orgId, agentId, tokenHash: hash, label, expiresAt })
    .returning({
      id: agentTokens.id,
      org_id: agentTokens.orgId,
      agent_id: agentTokens.agentId,
      label: agentTokens.label,
      created_at: agentTokens.createdAt,
    });

  audit('agent_token_created', { data: { orgId, agentId, tokenId: row.id } });
  logger.info({ msg: 'Agent token created', orgId, agentId, tokenId: row.id });
  return { plaintext, ...row };
}

/**
 * Validate a plaintext token. Returns token record if valid, null otherwise.
 */
export async function validateToken(plaintext) {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX) || plaintext.length !== 67) {
    return null;
  }
  const hash = hashToken(plaintext);
  const [row] = await db
    .select({
      id: agentTokens.id,
      org_id: agentTokens.orgId,
      agent_id: agentTokens.agentId,
    })
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.tokenHash, hash),
        isNull(agentTokens.revokedAt),
        or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, sql`NOW()`)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Revoke a token by ID.
 */
export async function revokeToken(orgId, tokenId) {
  const result = await db
    .update(agentTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(agentTokens.orgId, orgId),
        eq(agentTokens.id, tokenId),
        isNull(agentTokens.revokedAt),
      ),
    );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) audit('agent_token_revoked', { data: { orgId, tokenId } });
  return revoked;
}

/**
 * List tokens for an agent (hashes redacted).
 */
export async function listTokens(orgId, agentId) {
  return db
    .select({
      id: agentTokens.id,
      org_id: agentTokens.orgId,
      agent_id: agentTokens.agentId,
      label: agentTokens.label,
      created_at: agentTokens.createdAt,
      expires_at: agentTokens.expiresAt,
      revoked_at: agentTokens.revokedAt,
    })
    .from(agentTokens)
    .where(and(eq(agentTokens.orgId, orgId), eq(agentTokens.agentId, agentId)))
    .orderBy(agentTokens.createdAt);
}
