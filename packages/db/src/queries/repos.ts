import { query, getPool } from '../pool.js';

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

export async function listRepos(orgIds: string[]): Promise<RepoListItem[]> {
  const isSuper = orgIds.length === 0;

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
}: {
  repoId: string;
  claimType: string;
  description: string;
  prNumber: number;
}): Promise<CreatedClaim | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const repoResult = await client.query(
      'SELECT id, org_id, repo_full_name FROM repos WHERE id = $1 FOR SHARE',
      [repoId],
    );
    if (repoResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const repo = repoResult.rows[0] as { id: string; org_id: string; repo_full_name: string };

    // Lock the repo row to serialize per (org, repo, pr) and prevent race conditions
    // on attempt allocation. Two concurrent requests for the same PR will contend
    // on this row lock, so only one computes MAX(attempt)+1 at a time.
    await client.query(
      'SELECT 1 FROM repos WHERE id = $1 FOR UPDATE',
      [repoId],
    );
    const attemptResult = await client.query(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
       FROM agent_claims
       WHERE org_id = $1 AND repo = $2 AND pr_number = $3`,
      [repo.org_id, repo.repo_full_name, prNumber],
    );
    const attempt = (attemptResult.rows[0] as { next_attempt: number }).next_attempt;

    const claimResult = await client.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, org_id, repo, claim_type, status`,
      [repo.org_id, repo.repo_full_name, prNumber, attempt, claimType, JSON.stringify({ message: description })],
    );

    await client.query('COMMIT');
    return claimResult.rows[0] as CreatedClaim;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
