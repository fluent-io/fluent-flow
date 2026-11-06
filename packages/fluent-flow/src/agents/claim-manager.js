import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { cancelOpenClaimInteractions, db, getPool, schema } from '@fluent-flow/db';
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
  if (row.org_id !== undefined) {
    const { session_agent_id: _sessionAgentId, ...claim } = row;
    return claim;
  }
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

async function freeSession(orgId, sessionId, agentId, targetStatus = 'online') {
  if (!sessionId || !agentId) return;
  await setSessionStatus(orgId, agentId, sessionId, targetStatus);
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

async function finalizeClaim(orgId, repo, prNumber, attempt, finalStatus, claimType = null) {
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
  const [row] = await db
    .update(agentClaims)
    .set({ status: finalStatus, completedAt: sql`NOW()` })
    .where(and(...conditions))
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
 * @param {string|null} [claimType] — narrow to a specific claim type to avoid ambiguity
 */
export async function completeClaim(orgId, repo, prNumber, attempt, claimType = null) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'completed', claimType);
}

/**
 * Mark a claim as failed. Frees the session.
 * @param {string|null} [claimType] — narrow to a specific claim type to avoid ambiguity
 */
export async function failClaim(orgId, repo, prNumber, attempt, claimType = null) {
  return finalizeClaim(orgId, repo, prNumber, attempt, 'failed', claimType);
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

export async function assertClaimOwner(
  { orgId, agentId, sessionId, claimId },
  executor = null,
  lockMode = null,
) {
  const client = executor ?? await getPool().connect();
  const ownsClient = executor == null;
  try {
    const lockClause = lockMode === 'share' ? ' FOR SHARE' : '';
    const owned = await client.query(
      `SELECT claim.*
       FROM agent_claims claim
       JOIN agent_sessions session
         ON session.id = claim.session_id
        AND session.org_id = claim.org_id
       WHERE claim.id = $4
         AND claim.org_id = $1
         AND session.agent_id = $2
         AND claim.session_id = $3
         AND claim.status = 'claimed'${lockClause}`,
      [orgId, agentId, sessionId, claimId],
    );
    if (owned.rows.length > 0) return toSnakeClaim(owned.rows[0]);
    const currentOrg = await client.query(
      'SELECT id FROM agent_claims WHERE id = $1 AND org_id = $2',
      [claimId, orgId],
    );
    const statusCode = currentOrg.rows.length === 0 ? 404 : 409;
    throw Object.assign(new Error(statusCode === 404 ? 'Claim not found' : 'Claim ownership is stale'), { statusCode });
  } finally {
    if (ownsClient) client.release();
  }
}

export async function withClaimOwner(input, operation) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await assertClaimOwner(input, client, 'share');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeClaimById(orgId, claimId, sessionId, finalStatus) {
  const client = await getPool().connect();
  let row;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE agent_claims claim
       SET status = $4, completed_at = NOW()
       WHERE claim.id = $2
         AND claim.org_id = $1
         AND claim.session_id = $3
         AND claim.status = 'claimed'
       RETURNING claim.*,
         (SELECT session.agent_id
            FROM agent_sessions session
           WHERE session.id = claim.session_id
             AND session.org_id = claim.org_id) AS session_agent_id`,
      [orgId, claimId, sessionId, finalStatus],
    );
    row = result.rows[0] ?? null;
    if (row) await cancelOpenClaimInteractions({ orgId, claimId }, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!row) return null;
  await freeSession(orgId, row.session_id, row.session_agent_id, 'online');
  return toSnakeClaim(row);
}

export async function completeClaimById(orgId, claimId, sessionId) {
  return finalizeClaimById(orgId, claimId, sessionId, 'completed');
}

export async function failClaimById(orgId, claimId, sessionId) {
  return finalizeClaimById(orgId, claimId, sessionId, 'failed');
}

export async function cancelClaimById(orgId, claimId, sessionId) {
  return finalizeClaimById(orgId, claimId, sessionId, 'cancelled');
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
  const client = await getPool().connect();
  let claims;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE agent_claims claim
       SET status = 'expired', completed_at = NOW()
       WHERE claim.status = 'claimed'
         AND claim.expires_at < NOW()
       RETURNING claim.*,
         (SELECT session.agent_id
            FROM agent_sessions session
           WHERE session.id = claim.session_id
             AND session.org_id = claim.org_id) AS session_agent_id`,
    );
    claims = result.rows;
    for (const claim of claims) {
      await cancelOpenClaimInteractions({ orgId: claim.org_id, claimId: claim.id }, client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const claim of claims) {
    try {
      await freeSession(claim.org_id, claim.session_id, claim.session_agent_id, 'offline');
    } catch (err) {
      logger.warn({
        msg: 'Failed to free session on claim expiration',
        error: err.message,
        sessionId: claim.session_id,
        safeToContinue: true,
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
