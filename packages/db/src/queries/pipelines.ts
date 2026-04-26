import { query } from '../pool.js';

export interface PipelineStage {
  claim_type: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface PipelineListItem {
  org_id: string;
  repo: string;
  pr_number: number | null;
  latest_attempt: number;
  last_activity: Date;
  stages: PipelineStage[];
}

export async function listPipelines(orgIds: string[]): Promise<PipelineListItem[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT
      c.org_id,
      c.repo,
      c.pr_number,
      MAX(c.attempt) AS latest_attempt,
      MAX(c.created_at) AS last_activity,
      COALESCE(json_agg(
        json_build_object(
          'claim_type', c.claim_type,
          'status', c.status,
          'created_at', c.created_at,
          'claimed_at', c.claimed_at,
          'completed_at', c.completed_at
        ) ORDER BY c.created_at
      ), '[]'::json) AS stages
    FROM agent_claims c
    ${isSuper ? '' : 'WHERE c.org_id = ANY($1)'}
    GROUP BY c.org_id, c.repo, COALESCE(c.pr_number, 0)
    ORDER BY last_activity DESC
    LIMIT 100
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: Record<string, unknown>) => ({
    ...row,
    stages: typeof row.stages === 'string' ? JSON.parse(row.stages as string) : row.stages,
  })) as PipelineListItem[];
}

export interface PipelineDetailClaim {
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
  created_at: Date;
  agent_id: string | null;
  session_meta: Record<string, unknown> | null;
}

export async function getPipelineDetail(orgIds: string[], repo: string, prNumber: number | null): Promise<PipelineDetailClaim[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT
      c.*,
      s.agent_id,
      s.session_meta
    FROM agent_claims c
    LEFT JOIN agent_sessions s ON c.session_id = s.id
    WHERE ${isSuper ? '' : 'c.org_id = ANY($1) AND '}c.repo = $${isSuper ? 1 : 2} AND c.pr_number ${prNumber != null ? `= $${isSuper ? 2 : 3}` : 'IS NULL'}
      AND c.attempt = (
        SELECT MAX(c2.attempt)
        FROM agent_claims c2
        WHERE c2.org_id = c.org_id AND c2.repo = c.repo AND c2.pr_number ${prNumber != null ? '= c.pr_number' : 'IS NULL'}
      )
    ORDER BY c.created_at ASC
  `;

  const params = prNumber != null
    ? (isSuper ? [repo, prNumber] : [orgIds, repo, prNumber])
    : (isSuper ? [repo] : [orgIds, repo]);
  const result = await query(sql, params);
  return result.rows as PipelineDetailClaim[];
}
