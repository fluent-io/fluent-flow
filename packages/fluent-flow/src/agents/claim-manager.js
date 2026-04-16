import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import { resolveSession, setSessionStatus, findAvailableSession } from './session-manager.js';
import logger from '../logger.js';

const { agentClaims, agentSessions } = schema;

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function getSessionAgentId(sessionId) {
  if (!sessionId) return null;
  const [row] = await db
    .select({ agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row?.agentId ?? null;
}

async function freeSession(orgId, sessionId, agentId, targetStatus = 'online') {
  if (!sessionId || !agentId) return;
  await setSessionStatus(orgId, agentId, sessionId, targetStatus);
}

/**
 * Create a claim for a review attempt. Resolves a session and assigns if available.
 */
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  let sessionId = null;
  let resolvedAgentId = agentId;

  if (agentId) {
    sessionId = await resolveSession(orgId, agentId, repo, prNumber);
  } else {
    const available = await findAvailableSession(orgId, repo, prNumber);
    if (available) {
      sessionId = available.sessionId;
      resolvedAgentId = available.agentId;
    }
  }

  const status = sessionId ? 'claimed' : 'pending';
  const claimedAt = sessionId ? new Date() : null;
  const expiresAt = sessionId ? new Date(Date.now() + ttlMs) : null;

  const [claim] = await db
    .insert(agentClaims)
    .values({
      orgId,
      repo,
      prNumber,
      attempt,
      sessionId,
      claimType,
      status,
      payload,
      claimedAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [agentClaims.orgId, agentClaims.repo, agentClaims.prNumber, agentClaims.attempt],
      set: {
        sessionId,
        claimType,
        status,
        payload,
        claimedAt,
        expiresAt,
      },
    })
    .returning();

  if (sessionId && resolvedAgentId) {
    await setSessionStatus(orgId, resolvedAgentId, sessionId, 'busy');
  }

  audit('claim_created', {
    repo,
    data: { claimId: claim.id, prNumber, attempt, sessionId, status, claimType },
  });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status, claimType });
  return claim;
}

async function finalizeClaim(orgId, repo, prNumber, attempt, finalStatus) {
  const [claim] = await db
    .update(agentClaims)
    .set({ status: finalStatus, completedAt: sql`NOW()` })
    .where(
      and(
        eq(agentClaims.orgId, orgId),
        eq(agentClaims.repo, repo),
        eq(agentClaims.prNumber, prNumber),
        eq(agentClaims.attempt, attempt),
        inArray(agentClaims.status, ['claimed', 'pending']),
      ),
    )
    .returning();
  if (!claim) return null;
  const sessionAgentId = await getSessionAgentId(claim.sessionId);
  await freeSession(orgId, claim.sessionId, sessionAgentId, 'online');
  return claim;
}

/**
 * Mark a claim as completed. Frees the session.
 */
export async function completeClaim(orgId, repo, prNumber, attempt) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'completed');
}

/**
 * Mark a claim as failed. Frees the session.
 */
export async function failClaim(orgId, repo, prNumber, attempt) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'failed');
}

/**
 * Expire all overdue claims. Sets associated sessions to offline.
 */
export async function expireClaims() {
  const claims = await db
    .update(agentClaims)
    .set({ status: 'expired' })
    .where(and(eq(agentClaims.status, 'claimed'), lt(agentClaims.expiresAt, sql`NOW()`)))
    .returning();
  for (const claim of claims) {
    try {
      const agentId = await getSessionAgentId(claim.sessionId);
      await freeSession(claim.orgId, claim.sessionId, agentId, 'offline');
    } catch (err) {
      logger.warn({
        msg: 'Failed to free session on claim expiration',
        error: err.message,
        sessionId: claim.sessionId,
      });
    }
  }
  if (claims.length > 0) logger.info({ msg: 'Claims expired', count: claims.length });
  return claims;
}

/**
 * Get the active claim (pending or claimed) for a PR.
 */
export async function getActiveClaim(orgId, repo, prNumber) {
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(
      and(
        eq(agentClaims.orgId, orgId),
        eq(agentClaims.repo, repo),
        eq(agentClaims.prNumber, prNumber),
        inArray(agentClaims.status, ['pending', 'claimed']),
      ),
    )
    .orderBy(desc(agentClaims.attempt))
    .limit(1);
  return row ?? null;
}

/**
 * Get a specific claim by org, repo, PR, and attempt.
 */
export async function getClaimByAttempt(orgId, repo, prNumber, attempt) {
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(
      and(
        eq(agentClaims.orgId, orgId),
        eq(agentClaims.repo, repo),
        eq(agentClaims.prNumber, prNumber),
        eq(agentClaims.attempt, attempt),
      ),
    )
    .limit(1);
  return row ?? null;
}
