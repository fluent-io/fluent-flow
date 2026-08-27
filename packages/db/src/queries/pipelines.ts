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

export async function listPipelines(orgIds: string[], filter: 'active' | 'archived' | 'all' = 'active'): Promise<PipelineListItem[]> {
  const isSuper = orgIds.length === 0;

  const archiveFilter =
    filter === 'active' ? 'AND c.archived_at IS NULL'
    : filter === 'archived' ? 'AND c.archived_at IS NOT NULL'
    : '';

  const sql = `
    SELECT
      c.org_id,
      c.repo,
      MAX(c.pr_number) AS pr_number,
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
    WHERE 1=1
      ${archiveFilter}
      ${isSuper ? '' : 'AND c.org_id = ANY($1)'}
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

export interface PipelineVerificationResult {
  id: number;
  org_id: string;
  claim_id: number;
  repo: string;
  pr_number: number;
  phase: string;
  framework: string;
  outcome: string;
  matrix: unknown;
  manifest: unknown;
  test_hashes: unknown;
  artifact_sha: string | null;
  red_base_sha: string | null;
  green_sha: string | null;
  created_at: string;
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
  verification_result: PipelineVerificationResult | null;
}

export async function getPipelineDetail(orgIds: string[], repo: string, prNumber: number | null, filter: 'active' | 'archived' | 'all' = 'active'): Promise<PipelineDetailClaim[]> {
  const isSuper = orgIds.length === 0;
  const archivedFilter =
    filter === 'active' ? 'AND c.archived_at IS NULL'
    : filter === 'archived' ? 'AND c.archived_at IS NOT NULL'
    : '';

  const sql = `
    SELECT
      c.*,
      s.agent_id,
      s.session_meta,
      CASE WHEN vr.id IS NULL THEN NULL ELSE json_build_object(
        'id', vr.id,
        'org_id', vr.org_id,
        'claim_id', vr.claim_id,
        'repo', vr.repo,
        'pr_number', vr.pr_number,
        'phase', vr.phase,
        'framework', vr.framework,
        'outcome', vr.outcome,
        'matrix', vr.matrix,
        'manifest', vr.manifest,
        'test_hashes', vr.test_hashes,
        'artifact_sha', vr.artifact_sha,
        'red_base_sha', vr.red_base_sha,
        'green_sha', vr.green_sha,
        'created_at', vr.created_at
      ) END AS verification_result
    FROM agent_claims c
    LEFT JOIN agent_sessions s ON c.session_id = s.id
    LEFT JOIN verification_results vr ON vr.claim_id = c.id
    WHERE ${isSuper ? '' : 'c.org_id = ANY($1) AND '}c.repo = $${isSuper ? 1 : 2} AND c.pr_number ${prNumber != null ? `= $${isSuper ? 2 : 3}` : 'IS NULL'}
      ${archivedFilter}
    ORDER BY c.attempt ASC, c.created_at ASC
  `;

  const params = prNumber != null
    ? (isSuper ? [repo, prNumber] : [orgIds, repo, prNumber])
    : (isSuper ? [repo] : [orgIds, repo]);
  const result = await query(sql, params);
  return result.rows.map((row: Record<string, unknown>) => ({
    ...row,
    verification_result: typeof row.verification_result === 'string'
      ? JSON.parse(row.verification_result)
      : row.verification_result,
  })) as PipelineDetailClaim[];
}
