import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { resolveClaimWorkspaceReport } from './claim-reporting.js';
import { CollabServiceError } from './errors.js';

type Executor = Pick<PoolClient, 'query'>;
export type ClaimWorkspaceState = {
  seq: string;
  state: 'known' | 'not_repository' | 'unavailable' | 'unobserved';
  headCommit: string | null;
  dirty: boolean | null;
  final: boolean;
  repository: string | null;
  taskBranch: string | null;
  taskBranchHead: string | null;
};

type WorkspaceRow = {
  reporting_binding_id: string;
  last_seq: string;
  state: 'known' | 'not_repository' | 'unavailable';
  head_commit: string | null;
  dirty: boolean | null;
  final: boolean;
  proof_hash: string;
  repository: string | null;
  task_branch: string | null;
  task_branch_head: string | null;
};

function view(row: WorkspaceRow | undefined): ClaimWorkspaceState {
  return row ? { seq: row.last_seq, state: row.state, headCommit: row.head_commit, dirty: row.dirty, final: row.final,
    repository: row.repository, taskBranch: row.task_branch, taskBranchHead: row.task_branch_head }
    : { seq: '0', state: 'unobserved', headCommit: null, dirty: null, final: false, repository: null, taskBranch: null, taskBranchHead: null };
}

export async function readClaimWorkspaceState(bindingId: string, executor: Executor = getPool()): Promise<ClaimWorkspaceState> {
  const { rows } = await executor.query<WorkspaceRow>('SELECT *,last_seq::text FROM collab_claim_workspace_state WHERE reporting_binding_id=$1', [bindingId]);
  return view(rows[0]);
}

export async function recordClaimWorkspaceObservation(input: {
  taskId: string;
  claimId: number;
  reportingBindingId: string;
  proof: unknown;
}, tx?: PoolClient): Promise<ClaimWorkspaceState> {
  if (!tx) return withClientTransaction((client) => recordClaimWorkspaceObservation(input, client));
  const observed = await resolveClaimWorkspaceReport(input, tx);
  const { rows } = await tx.query<WorkspaceRow>('SELECT *,last_seq::text FROM collab_claim_workspace_state WHERE reporting_binding_id=$1', [input.reportingBindingId]);
  const current = rows[0];
  if (current && current.last_seq === observed.seq && current.proof_hash === observed.proofHash) return view(current);
  if (BigInt(observed.seq) !== BigInt(current?.last_seq ?? '0') + 1n) {
    throw new CollabServiceError(409, 'workspace_conflict', 'Workspace state changed. Refresh before reporting again.');
  }
  const values = [input.reportingBindingId, observed.seq, observed.state, observed.headCommit, observed.dirty, observed.final,
    observed.proofHash, observed.repository, observed.taskBranch, observed.taskBranchHead];
  const written = await tx.query<WorkspaceRow>(`INSERT INTO collab_claim_workspace_state(reporting_binding_id,last_seq,state,head_commit,dirty,final,proof_hash,repository,task_branch,task_branch_head)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(reporting_binding_id) DO UPDATE SET last_seq=EXCLUDED.last_seq,state=EXCLUDED.state,
      head_commit=EXCLUDED.head_commit,dirty=EXCLUDED.dirty,final=EXCLUDED.final,proof_hash=EXCLUDED.proof_hash,observed_at=now(),
      repository=EXCLUDED.repository,task_branch=EXCLUDED.task_branch,task_branch_head=EXCLUDED.task_branch_head
    RETURNING *,last_seq::text`, values);
  return view(written.rows[0]);
}

export type ClaimWorkspaceHead = WorkspaceRow & { same_acquisition: boolean; claim_status: string };

export async function readClaimWorkspaceHeads(bindingIds: string[], executor: Executor = getPool()): Promise<Map<string, ClaimWorkspaceHead>> {
  if (!bindingIds.length) return new Map();
  const { rows } = await executor.query<ClaimWorkspaceHead>(`SELECT workspace.*,workspace.last_seq::text,
    claim.status AS claim_status,
    COALESCE(claim.claimed_at=token.claimed_at AND (claim.session_id=token.runner_session_id
      OR (claim.session_id IS NULL AND claim.status NOT IN ('pending','claimed'))),false) AS same_acquisition
    FROM collab_claim_workspace_state workspace
    JOIN collab_scoped_tokens token ON token.id=workspace.reporting_binding_id
    JOIN agent_claims claim ON claim.id=token.claim_id
    WHERE workspace.reporting_binding_id=ANY($1::uuid[])`, [bindingIds]);
  const result = new Map<string, ClaimWorkspaceHead>();
  for (const row of rows) result.set(row.reporting_binding_id, row);
  return result;
}
