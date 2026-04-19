import { createHash } from 'crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, schema, createToken as dbCreateToken } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { agentTokens } = schema;

const TOKEN_PREFIX = 'ff_';

export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Create a new agent token. Delegates the insert to @fluent-flow/db; keeps
 * audit + logging at the server boundary (dashboard calls the db version
 * directly with its own session-scoped auth).
 *
 * `expiresAt` semantics:
 *   - `undefined` → apply the db-layer default (1 year).
 *   - `null`      → persist NULL; token never expires.
 *   - `Date`      → explicit expiry.
 */
export async function createToken(orgId, agentId, label = null, expiresAt) {
  const effectiveLabel = label ?? 'default';
  const result = await dbCreateToken({
    orgId,
    agentId,
    label: effectiveLabel,
    expiresAt, // preserve undefined/null distinction for the db layer
  });

  audit('agent_token_created', { data: { orgId, agentId, tokenId: result.id } });
  logger.info({ msg: 'Agent token created', orgId, agentId, tokenId: result.id });
  return {
    plaintext: result.plaintext,
    id: result.id,
    org_id: orgId,
    agent_id: agentId,
    label: effectiveLabel,
  };
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
