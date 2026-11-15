import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { readClaimWorkspaceHeads } from './claim-workspace-state.js';
import { readArchivedRunWorkspace } from './execution-archives.js';

type Executor = Pick<PoolClient, 'query'>;
export type DeliveryWorkspaceSource = { kind: 'claim'; claimId: number };
export type DeliveryWorkspace = {
  source?: DeliveryWorkspaceSource;
  runId: string | null;
  headCommit: string | null;
  dirty: boolean | null;
  revision: string;
};

export async function readDeliveryWorkspace(taskId: string, executor: Executor): Promise<DeliveryWorkspace> {
  const { rows } = await executor.query<{ run_id: string | null; claim_id: number | null; archive_id: string | null }>(`SELECT run_id,claim_id,archive_id FROM (
    SELECT id AS run_id,NULL::integer AS claim_id,NULL::uuid AS archive_id,created_at AS started_at
      FROM collab_runs WHERE task_id=$1
    UNION ALL
    SELECT source_run_id,NULL::integer,id,source_created_at FROM collab_execution_archives archive
      WHERE task_id=$1 AND sealed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collab_runs run WHERE run.id=archive.source_run_id)
    UNION ALL
    SELECT NULL::uuid,c.id,NULL::uuid,GREATEST(c.created_at,c.claimed_at)
      FROM collab_claim_executions execution JOIN agent_claims c ON c.id=execution.claim_id
      JOIN collab_tasks task ON task.id=execution.task_id
      JOIN collab_projects project ON project.id=task.project_id
      JOIN collab_workspaces workspace ON workspace.id=project.workspace_id
      WHERE execution.task_id=$1 AND execution.project_id=project.id AND c.org_id=workspace.org_id AND c.repo IS NOT NULL
  ) sources ORDER BY started_at DESC,claim_id DESC NULLS LAST,run_id DESC LIMIT 1`, [taskId]);
  const selected = rows[0];
  if (!selected || selected.claim_id === null) {
    const run = selected?.run_id && !selected.archive_id ? (await executor.query<{ head_commit: string | null; dirty: boolean | null }>(
      'SELECT head_commit,dirty FROM collab_runs WHERE id=$1 AND task_id=$2', [selected.run_id, taskId])).rows[0] : undefined;
    const archived = selected?.archive_id ? await readArchivedRunWorkspace({ taskId, archiveId: selected.archive_id }, executor) : undefined;
    const result = { runId: selected?.run_id ?? null, headCommit: archived?.headCommit ?? run?.head_commit ?? null, dirty: archived?.dirty ?? run?.dirty ?? null };
    return { ...result, revision: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
  }
  const claim = (await executor.query<{ id: number; status: string; acquired_at: string | null }>(`SELECT id,status,
    to_char(claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired_at
    FROM agent_claims WHERE id=$1 FOR SHARE`, [selected.claim_id])).rows[0];
  const binding = (await executor.query<{ id: string }>(`SELECT token.id FROM collab_scoped_tokens token
    JOIN agent_claims claim ON claim.id=token.claim_id
    WHERE claim.id=$1 AND token.claimed_at=claim.claimed_at
      AND (token.runner_session_id=claim.session_id OR (claim.session_id IS NULL AND claim.status NOT IN ('pending','claimed')))
    ORDER BY token.created_at DESC,token.id DESC LIMIT 1`, [selected.claim_id])).rows[0];
  const workspace = binding ? (await readClaimWorkspaceHeads([binding.id], executor)).get(binding.id) : undefined;
  const known = workspace?.same_acquisition && workspace.state === 'known' && (claim.status === 'claimed' || workspace.final);
  const result = { source: { kind: 'claim' as const, claimId: claim.id }, runId: null,
    headCommit: known ? workspace.head_commit : null, dirty: known ? workspace.dirty : null };
  const revision = createHash('sha256').update(JSON.stringify([result,claim.acquired_at,claim.status,binding?.id ?? null,workspace?.final ?? null])).digest('hex');
  return { ...result, revision };
}
