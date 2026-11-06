import pg from 'pg';
import { query } from '../pool.js';
import { claimSchema } from '../schemas/claims.js';
import type { Claim } from '../schemas/claims.js';
import { withClientTransaction } from '../collaboration/tx.js';
import type { QueryExecutor } from './claim-interactions.js';

export type PendingClaimInput = {
  orgId: string;
  repo: string;
  prNumber: number | null;
  claimType: string;
  payload: Record<string, unknown>;
  headSha?: string | null;
  attempt?: number;
};

export type PendingClaimRow = {
  id: number;
  org_id: string;
  repo: string;
  pr_number: number | null;
  attempt: number;
  session_id: number | null;
  claim_type: string;
  status: string;
  payload: Record<string, unknown>;
  claimed_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  check_run_external_id: number | null;
  head_sha: string | null;
};

async function insertAtAttempt(
  input: PendingClaimInput,
  attempt: number,
  executor: QueryExecutor,
): Promise<PendingClaimRow | null> {
  const result = await executor.query<PendingClaimRow>(
    `INSERT INTO agent_claims
       (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload,
        claimed_at, expires_at, head_sha)
     VALUES ($1, $2, $3, $4, NULL, $5, 'pending', $6, NULL, NULL, $7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.orgId,
      input.repo,
      input.prNumber,
      attempt,
      input.claimType,
      input.payload,
      input.headSha ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertPendingClaimWithExecutor(
  input: PendingClaimInput,
  executor: QueryExecutor,
): Promise<PendingClaimRow | null> {
  if (input.attempt !== undefined) {
    return insertAtAttempt(input, input.attempt, executor);
  }
  const lockKey = `claim-attempt:${JSON.stringify([
    input.orgId,
    input.repo,
    input.prNumber,
    input.claimType,
  ])}`;
  await executor.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
  for (let retry = 0; retry < 4; retry += 1) {
    const allocated = await executor.query<{ attempt: number }>(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
       FROM agent_claims
       WHERE org_id = $1
         AND repo = $2
         AND pr_number IS NOT DISTINCT FROM $3
         AND claim_type = $4`,
      [input.orgId, input.repo, input.prNumber, input.claimType],
    );
    const inserted = await insertAtAttempt(input, allocated.rows[0].attempt, executor);
    if (inserted !== null) return inserted;
  }
  return null;
}

export async function insertPendingClaim(
  input: PendingClaimInput,
  executor?: QueryExecutor,
): Promise<PendingClaimRow | null> {
  if (executor === undefined) {
    return withClientTransaction((client) => insertPendingClaimWithExecutor(input, client));
  }
  if (!(executor instanceof pg.Pool)) {
    return insertPendingClaimWithExecutor(input, executor);
  }
  const client = await executor.connect();
  try {
    await client.query('BEGIN');
    const claim = await insertPendingClaimWithExecutor(input, client);
    await client.query('COMMIT');
    return claim;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAgentClaims(orgId: string, agentId: string): Promise<Claim[]> {
  const sql = `
    SELECT c.* FROM agent_claims c
    JOIN agent_sessions s ON c.session_id = s.id
    WHERE c.org_id = $1 AND s.agent_id = $2
    ORDER BY c.created_at DESC
    LIMIT 100
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => claimSchema.parse(row));
}

/**
 * Dismiss a single claim: set status to cancelled, archived_at and completed_at to NOW().
 */
export async function dismissClaim(id: number): Promise<void> {
  await query(
    `UPDATE agent_claims
     SET status = 'cancelled', archived_at = NOW(), completed_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'claimed')`,
    [id],
  );
}

/**
 * Dismiss stale claims (pending, claimed, or expired) older than a threshold.
 * Cancels and archives matching claims. Defaults to 24 hours if olderThanMs not provided.
 */
export async function dismissStaleClaims(orgIds: string[], olderThanMs = 86_400_000, isSuperadmin = false): Promise<number> {
  if (orgIds.length === 0 && !isSuperadmin) return 0;
  const isSuper = isSuperadmin && orgIds.length === 0;
  const sql = `
    UPDATE agent_claims
    SET status = 'cancelled', archived_at = NOW(), completed_at = NOW()
    WHERE status IN ('pending', 'claimed', 'expired')
      AND created_at < NOW() - ($1 || ' milliseconds')::interval
      ${isSuper ? '' : 'AND org_id = ANY($2)'}
  `;
  const params = isSuper ? [String(olderThanMs)] : [String(olderThanMs), orgIds];
  const result = await query(sql, params);
  return result.rowCount ?? 0;
}

/**
 * Dismiss all active (pending or claimed) claims in a pipeline (repo + optional pr_number).
 */
export async function dismissPipelineClaims(orgIds: string[], repo: string, prNumber?: number | null, isSuperadmin = false): Promise<number> {
  if (orgIds.length === 0 && !isSuperadmin) return 0;
  const isSuper = isSuperadmin && orgIds.length === 0;
  const params: unknown[] = ['cancelled', repo];
  let orgFilter = '';
  if (!isSuper) {
    params.push(orgIds);
    orgFilter = `AND org_id = ANY($${params.length})`;
  }
  let prFilter = '';
  if (prNumber != null) {
    params.push(prNumber);
    prFilter = `AND pr_number = $${params.length}`;
  } else if (prNumber === null) {
    prFilter = 'AND pr_number IS NULL';
  }

  const sql = `
    UPDATE agent_claims
    SET status = $1, archived_at = NOW(), completed_at = NOW()
    WHERE status IN ('pending', 'claimed')
      AND repo = $2
      ${orgFilter}
      ${prFilter}
  `;

  const result = await query(sql, params);
  return result.rowCount ?? 0;
}
