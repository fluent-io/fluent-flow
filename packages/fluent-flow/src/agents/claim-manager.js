import { and, desc, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import { resolveSession, setSessionStatus, findAvailableSession } from './session-manager.js';
import logger from '../logger.js';

const { agentClaims, agentSessions } = schema;

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Normalize a Drizzle camelCase claim row to the snake_case shape the rest of
 * the app (engine hooks, route handlers, webhook payloads) reads. Consumers
 * like `handleClaimResult` rely on `claim.claim_type` for spec→build chaining
 * and `claim.head_sha` / `claim.check_run_external_id` for check-run updates;
 * leaking camelCase rows silently breaks those flows.
 */
function toSnakeClaim(row) {
  if (!row) return row;
  return {
    id: row.id,
    org_id: row.orgId,
    repo: row.repo,
    pr_number: row.prNumber,
    attempt: row.attempt,
    session_id: row.sessionId,
    claim_type: row.claimType,
    status: row.status,
    payload: row.payload,
    claimed_at: row.claimedAt,
    completed_at: row.completedAt,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    check_run_external_id: row.checkRunExternalId,
    head_sha: row.headSha,
  };
}

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

  const insertValues = {
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
  };

  // Insert only — never overwrite an existing claim.
  // The unique constraint (org_id, repo, pr_number, attempt) ensures
  // each claim is immutable once created.
  const conflictTarget = prNumber == null
    ? { target: 'agent_claims_org_repo_attempt_no_pr_key' }
    : { target: [agentClaims.orgId, agentClaims.repo, agentClaims.prNumber, agentClaims.attempt] };

  const [claim] = await db
    .insert(agentClaims)
    .values(insertValues)
    .onConflictDoNothing({ ...conflictTarget })
    .returning();

  if (!claim) {
    logger.info({ msg: 'Claim already exists, skipping', orgId, repo, prNumber, attempt, claimType });
    return null;
  }

  if (sessionId && resolvedAgentId) {
    await setSessionStatus(orgId, resolvedAgentId, sessionId, 'busy');
  }

  audit('claim_created', {
    repo,
    data: { claimId: claim.id, prNumber, attempt, sessionId, status, claimType },
  });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status, claimType });
  return toSnakeClaim(claim);
}

async function finalizeClaim(orgId, repo, prNumber, attempt, finalStatus) {
  // Fold the session-agent lookup into the UPDATE's RETURNING so the hot
  // path (claim completion/failure) stays a single round-trip.
  const [row] = await db
    .update(agentClaims)
    .set({ status: finalStatus, completedAt: sql`NOW()` })
    .where(
      and(
        eq(agentClaims.orgId, orgId),
        eq(agentClaims.repo, repo),
        prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
        eq(agentClaims.attempt, attempt),
        inArray(agentClaims.status, ['claimed', 'pending']),
      ),
    )
    .returning({
      ...getTableColumns(agentClaims),
      sessionAgentId: sql`(SELECT ${agentSessions.agentId} FROM ${agentSessions} WHERE ${agentSessions.id} = ${agentClaims.sessionId})`.as('session_agent_id'),
    });
  if (!row) return null;
  const { sessionAgentId, ...claim } = row;
  await freeSession(orgId, claim.sessionId, sessionAgentId, 'online');
  return toSnakeClaim(claim);
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
  return claims.map(toSnakeClaim);
}

/**
 * Get the active claim (pending or claimed) for a PR.
 */
export async function getActiveClaim(orgId, repo, prNumber) {
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
    inArray(agentClaims.status, ['pending', 'claimed']),
  ];
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(and(...conditions))
    .orderBy(desc(agentClaims.attempt))
    .limit(1);
  return toSnakeClaim(row) ?? null;
}

/**
 * Get a specific claim by org, repo, PR, and attempt.
 */
export async function getClaimByAttempt(orgId, repo, prNumber, attempt) {
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
    eq(agentClaims.attempt, attempt),
  ];
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(and(...conditions))
    .limit(1);
  return toSnakeClaim(row) ?? null;
}
