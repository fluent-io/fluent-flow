import { query, getPool } from '../pool.js';
import { insertPendingClaim } from './claims.js';

export interface RepoListItem {
  id: string;
  org_id: string;
  repo_full_name: string;
  provider: string;
  created_at: Date;
  installation_id: string | null;
  is_active: boolean | null;
  active_claims: number;
}

export async function listRepos(orgIds: string[], isSuperadmin = false): Promise<RepoListItem[]> {
  // Empty orgIds without superadmin means no org access, not global scope
  if (orgIds.length === 0 && !isSuperadmin) return [];
  const isSuper = isSuperadmin && orgIds.length === 0;

  const sql = `
    SELECT r.id, r.org_id, r.repo_full_name, r.provider, r.created_at,
      r.installation_id::text AS installation_id,
      CASE
        WHEN pi.id IS NULL THEN NULL
        WHEN pi.suspended_at IS NULL THEN TRUE
        ELSE FALSE
      END AS is_active,
      COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('pending', 'claimed')) AS active_claims
    FROM repos r
    LEFT JOIN provider_installations pi ON r.installation_id = pi.id
    LEFT JOIN agent_claims c ON c.org_id = r.org_id AND c.repo = r.repo_full_name
    ${isSuper ? '' : 'WHERE r.org_id = ANY($1)'}
    GROUP BY r.id, pi.id, pi.suspended_at
    ORDER BY r.repo_full_name
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: Record<string, unknown>) => ({
    ...row,
    active_claims: parseInt(row.active_claims as string, 10) || 0,
  })) as RepoListItem[];
}

export interface CreatedClaim {
  id: number;
  org_id: string;
  repo: string;
  claim_type: string;
  status: string;
}

export async function createClaim({
  repoId,
  claimType,
  description,
  prNumber,
  payload: extraPayload,
}: {
  repoId: string;
  claimType: string;
  description: string;
  prNumber?: number | null;
  payload?: Record<string, unknown>;
}): Promise<CreatedClaim | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const repoResult = await client.query(
      'SELECT id, org_id, repo_full_name FROM repos WHERE id = $1',
      [repoId],
    );
    if (repoResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const repo = repoResult.rows[0] as { id: string; org_id: string; repo_full_name: string };
    const claim = await insertPendingClaim({
      orgId: repo.org_id,
      repo: repo.repo_full_name,
      prNumber: prNumber ?? null,
      claimType,
      payload: { message: description, ...extraPayload },
    }, client);
    if (claim === null) {
      throw new Error('Claim allocation failed');
    }
    await client.query('COMMIT');

    return {
      id: claim.id,
      org_id: claim.org_id,
      repo: repo.repo_full_name,
      claim_type: claim.claim_type,
      status: claim.status,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
