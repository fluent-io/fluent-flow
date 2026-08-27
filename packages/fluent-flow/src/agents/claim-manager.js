import { and, desc, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import { setSessionStatus } from './session-manager.js';
import logger from '../logger.js';

const { agentClaims, agentSessions } = schema;

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Cap on automatic re-dispatch attempts (expiry + transient-failure paths). */
export const MAX_RETRY_ATTEMPTS = 10;

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
    archived_at: row.archivedAt,
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

async function freeSession(orgId, sessionId, agentId, targetStatus = 'online', executor = db) {
  if (!sessionId || !agentId) return;
  await setSessionStatus(orgId, agentId, sessionId, targetStatus, executor);
}

/**
 * Create a claim for a review attempt. Always creates as `pending` —
 * runners claim via `claimPendingWork()`. The long-poll push (in
 * review-manager.js / dispatcher.js) is a notification hint only;
 * if lost, the runner picks it up on next poll.
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.repo
 * @param {number|null} opts.prNumber
 * @param {number} opts.attempt
 * @param {string|null} [opts.agentId] — kept for API compat but no longer used for pre-assignment
 * @param {object} opts.payload
 * @param {string} [opts.claimType='review_fix']
 * @param {number} [opts.ttlMs] — kept for API compat but unused (pending claims have no expiry)
 * @param {string|null} [opts.headSha] — stored for re-dispatch check-run creation
 */
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS, headSha = null }) {
  const insertValues = {
    orgId,
    repo,
    prNumber,
    attempt,
    sessionId: null,
    claimType,
    status: 'pending',
    payload,
    claimedAt: null,
    expiresAt: null,
    headSha,
  };

  // Insert only — never overwrite an existing claim.
  // The unique constraint (org_id, repo, pr_number, claim_type, attempt) ensures
  // each claim is immutable once created.
  const conflictTarget = prNumber == null
    ? { target: 'agent_claims_org_repo_attempt_no_pr_key' }
    : { target: [agentClaims.orgId, agentClaims.repo, agentClaims.prNumber, agentClaims.claimType, agentClaims.attempt] };

  const [claim] = await db
    .insert(agentClaims)
    .values(insertValues)
    .onConflictDoNothing({ ...conflictTarget })
    .returning();

  if (!claim) {
    logger.info({ msg: 'Claim already exists, skipping', orgId, repo, prNumber, attempt, claimType });
    return null;
  }

  audit('claim_created', {
    repo,
    data: { claimId: claim.id, prNumber, attempt, status: 'pending', claimType },
  });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, status: 'pending', claimType });
  return toSnakeClaim(claim);
}

async function finalizeClaim(orgId, repo, prNumber, attempt, finalStatus, claimType = null, executor = db) {
  // Fold the session-agent lookup into the UPDATE's RETURNING so the hot
  // path (claim completion/failure) stays a single round-trip.
  // claimType is optional: when provided, it narrows the update to a specific
  // claim type so that the per-type unique constraint (org_id, repo, pr_number,
  // claim_type, attempt) doesn't cause ambiguity.
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
    eq(agentClaims.attempt, attempt),
    inArray(agentClaims.status, ['claimed', 'pending']),
  ];
  if (claimType) {
    conditions.push(eq(agentClaims.claimType, claimType));
  }
  const [row] = await executor
    .update(agentClaims)
    .set({ status: finalStatus, completedAt: sql`NOW()` })
    .where(and(...conditions))
    .returning({
      ...getTableColumns(agentClaims),
      sessionAgentId: sql`(SELECT ${agentSessions.agentId} FROM ${agentSessions} WHERE ${agentSessions.id} = ${agentClaims.sessionId})`.as('session_agent_id'),
    });
  if (!row) return null;
  const { sessionAgentId, ...claim } = row;
  await freeSession(orgId, claim.sessionId, sessionAgentId, 'online', executor);
  return toSnakeClaim(claim);
}

/**
 * Mark a claim as completed. Frees the session.
 * @param {string|null} [claimType] — narrow to a specific claim type to avoid ambiguity
 */
export async function completeClaim(orgId, repo, prNumber, attempt, claimType = null, executor = db) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'completed', claimType, executor);
}

/**
 * Mark a claim as failed. Frees the session.
 * @param {string|null} [claimType] — narrow to a specific claim type to avoid ambiguity
 */
export async function failClaim(orgId, repo, prNumber, attempt, claimType = null, executor = db) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'failed', claimType, executor);
}

/**
 * Extend a claimed claim's expiry — runner heartbeat support. Only applies
 * when the claim is currently `claimed` by the given session; anything else
 * (missing, pending, claimed by another session) returns null.
 * @returns {Promise<{ id: number } | null>}
 */
export async function extendClaim({ orgId, claimId, sessionId, ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const [row] = await db
    .update(agentClaims)
    .set({ expiresAt })
    .where(
      and(
        eq(agentClaims.id, claimId),
        eq(agentClaims.orgId, orgId),
        eq(agentClaims.sessionId, sessionId),
        eq(agentClaims.status, 'claimed'),
      ),
    )
    .returning({ id: agentClaims.id });
  return row ?? null;
}

/**
 * Get a claim by id, scoped to an org. Unambiguous — unlike the natural-key
 * lookup, two claim types sharing an attempt number can never collide.
 */
export async function getClaimById(orgId, claimId) {
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(and(eq(agentClaims.id, claimId), eq(agentClaims.orgId, orgId)))
    .limit(1);
  return toSnakeClaim(row) ?? null;
}

async function finalizeClaimById(orgId, claimId, finalStatus, executor = db) {
  const [row] = await executor
    .update(agentClaims)
    .set({ status: finalStatus, completedAt: sql`NOW()` })
    .where(
      and(
        eq(agentClaims.id, claimId),
        eq(agentClaims.orgId, orgId),
        inArray(agentClaims.status, ['claimed', 'pending']),
      ),
    )
    .returning({
      ...getTableColumns(agentClaims),
      sessionAgentId: sql`(SELECT ${agentSessions.agentId} FROM ${agentSessions} WHERE ${agentSessions.id} = ${agentClaims.sessionId})`.as('session_agent_id'),
    });
  if (!row) return null;
  const { sessionAgentId, ...claim } = row;
  await freeSession(orgId, claim.sessionId, sessionAgentId, 'online', executor);
  return toSnakeClaim(claim);
}

/**
 * Mark a claim completed by id. The only ambiguity-free finalization —
 * use whenever the caller knows the claim id.
 */
export async function completeClaimById(orgId, claimId, executor = db) {
  return finalizeClaimById(orgId, claimId, 'completed', executor);
}

/**
 * Mark a claim failed by id. The only ambiguity-free finalization.
 */
export async function failClaimById(orgId, claimId, executor = db) {
  return finalizeClaimById(orgId, claimId, 'failed', executor);
}

/**
 * Shared re-dispatch: create a follow-on claim at attempt + 1 for a claim
 * that expired or failed transiently. Preserves claim_type, payload, and
 * head_sha. Respects MAX_RETRY_ATTEMPTS. Returns the new claim, or null on
 * cap/conflict.
 */
export async function redispatchClaim(claim) {
  const newAttempt = claim.attempt + 1;
  if (newAttempt > MAX_RETRY_ATTEMPTS) {
    logger.warn({
      msg: 'Claim re-dispatch skipped — max retry attempts reached',
      repo: claim.repo,
      prNumber: claim.pr_number,
      attempt: claim.attempt,
      maxAttempts: MAX_RETRY_ATTEMPTS,
    });
    return null;
  }
  return createClaim({
    orgId: claim.org_id,
    repo: claim.repo,
    prNumber: claim.pr_number,
    attempt: newAttempt,
    claimType: claim.claim_type,
    payload: claim.payload,
    headSha: claim.head_sha,
  });
}

/**
 * Expire all overdue claims. Sets associated sessions to offline.
 */
export async function expireClaims() {
  const claims = await db
    .update(agentClaims)
    .set({ status: 'expired', completedAt: sql`NOW()` })
    .where(and(eq(agentClaims.status, 'claimed'), lt(agentClaims.expiresAt, sql`NOW()`)))
    .returning();
  for (const claim of claims) {
    try {
      const agentId = await getSessionAgentId(claim.sessionId);
      await freeSession(claim.orgId, claim.sessionId, agentId, 'offline');
    } catch (err) {
      // Safe to continue: per-claim iteration during expiry sweep — one
      // stale session shouldn't block expiry of other claims. The session
      // will time out naturally if this cleanup path fails.
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
 * Get a specific claim by org, repo, PR, attempt, and optionally claim type.
 * @param {string|null} [claimType] — narrow to a specific claim type to avoid ambiguity
 */
export async function getClaimByAttempt(orgId, repo, prNumber, attempt, claimType = null) {
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
    eq(agentClaims.attempt, attempt),
  ];
  if (claimType) {
    conditions.push(eq(agentClaims.claimType, claimType));
  }
  const [row] = await db
    .select()
    .from(agentClaims)
    .where(and(...conditions))
    .limit(1);
  return toSnakeClaim(row) ?? null;
}

/**
 * Compute the next attempt number for a PR, across all claim types.
 * Returns MAX(attempt) + 1 for the given org/repo/prNumber, or 1 if no claims exist.
 *
 * @param {string} orgId
 * @param {string} repo
 * @param {number|null} prNumber
 * @returns {Promise<number>}
 */
export async function nextChainAttempt(orgId, repo, prNumber) {
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    prNumber != null ? eq(agentClaims.prNumber, prNumber) : sql`${agentClaims.prNumber} IS NULL`,
  ];

  const [row] = await db
    .select({ max: sql`COALESCE(MAX(${agentClaims.attempt}), 0)` })
    .from(agentClaims)
    .where(and(...conditions))
    .limit(1);

  const maxAttempt = Number(row?.max ?? 0);
  return maxAttempt + 1;
}

/**
 * Count completed review_fix claims for a PR, for fix-loop cap enforcement.
 *
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<number>}
 */
export async function countCompletedFixIterations(orgId, repo, prNumber) {
  const conditions = [
    eq(agentClaims.orgId, orgId),
    eq(agentClaims.repo, repo),
    eq(agentClaims.prNumber, prNumber),
    eq(agentClaims.claimType, 'review_fix'),
    eq(agentClaims.status, 'completed'),
  ];

  const [row] = await db
    .select({ count: sql`COUNT(*)` })
    .from(agentClaims)
    .where(and(...conditions))
    .limit(1);

  return Number(row?.count ?? 0);
}

/**
 * Wrapper for createClaim that retries on Postgres unique violation (23505).
 * Recomputes the next attempt number after each conflict.
 * Throws after 3 total attempts.
 *
 * @param {object} opts - Options passed to createClaim
 * @param {Function} createClaimFn - The createClaim function to call
 * @returns {Promise<object|null>}
 */
export async function createClaimWithRetry(opts, createClaimFn) {
  const MAX_RETRIES = 3;
  const PG_UNIQUE_VIOLATION = '23505';

  for (let i = 0; i < MAX_RETRIES; i++) {
    const attempt = await nextChainAttempt(opts.orgId, opts.repo, opts.prNumber);

    try {
      const result = await createClaimFn({ ...opts, attempt });
      // Null return indicates conflict (onConflictDoNothing)
      if (result === null) {
        continue;
      }
      return result;
    } catch (err) {
      const isConflict = err.code === PG_UNIQUE_VIOLATION || err.cause?.code === PG_UNIQUE_VIOLATION;
      if (isConflict) {
        continue;
      }
      // Non-23505 errors fail immediately
      throw err;
    }
  }

  const finalError = new Error('Failed to create claim after multiple unique constraint violations');
  finalError.cause = new Error('Retry budget exhausted');
  finalError.cause.orgId = opts.orgId;
  finalError.cause.repo = opts.repo;
  finalError.cause.prNumber = opts.prNumber;

  logger.error({
    msg: 'Failed to create claim after multiple unique constraint violations',
    orgId: opts.orgId,
    repo: opts.repo,
    prNumber: opts.prNumber,
  });

  throw finalError;
}