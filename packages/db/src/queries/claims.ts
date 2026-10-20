import { query } from '../pool.js';
import { claimSchema } from '../schemas/claims.js';
import type { Claim } from '../schemas/claims.js';

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
  // Empty orgIds without superadmin means no org access, not global scope
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
  // Empty orgIds without superadmin means no org access, not global scope
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
