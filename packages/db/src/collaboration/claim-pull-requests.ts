import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { CollabServiceError } from './errors.js';
import { resolveClaimEvidenceAuthority, resolveClaimCompletionAuthority } from './claim-reporting.js';
import { authorize } from './authorize.js';
import { readClaimWorkspaceHeads } from './claim-workspace-state.js';
import { deliveryLinkView } from './delivery-links.js';
import { insertPendingClaim, type PendingClaimInput, type PendingClaimRow } from '../queries/claims.js';
import { cancelOpenClaimInteractionsForClaims } from '../queries/claim-interactions.js';

type Executor = Pick<PoolClient, 'query'>;
const HEAD_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type PipelineSource = {
  claimId: number; claimType: string; bindingId: string; taskId: string; projectId: string;
  rootClaimId: number; principalId: string; sessionVersion: number;
};
const sourceSelect = `SELECT claim.id AS claim_id,claim.claim_type,token.id AS binding_id,execution.task_id AS task_id,execution.project_id AS project_id,
  execution.root_claim_id AS root_claim_id,execution.created_by_principal_id AS principal_id,execution.created_by_session_version AS session_version
  FROM agent_claims claim
  JOIN collab_claim_executions execution ON execution.claim_id=claim.id
  JOIN collab_scoped_tokens token ON token.claim_id=claim.id AND token.claimed_at=claim.claimed_at
    AND token.runner_session_id=claim.session_id AND token.revoked_at IS NULL`;
const repository = z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), node_id: z.string().min(1).max(200) });
export const nativePullRequestSchema = z.object({
  node_id: z.string().min(1).max(200), number: z.number().int().positive(),
  base: z.object({ repo: repository }),
  head: z.object({ repo: repository, ref: z.string().min(1).max(1024), sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }),
});
export type NativePullRequest = z.infer<typeof nativePullRequestSchema>;
const sourceSchema = z.object({ taskId: z.string().uuid(), claimId: z.number().int().positive(), reportingBindingId: z.string().uuid() }).strict();
type SourceInput = z.infer<typeof sourceSchema>;

type LinkRow = {
  id: string; task_id: string; project_id: string; org_id: string; repo: string; pr_number: number;
  claim_id: string; native_binding_id: string; producer_binding_id: string; producer_claim_id: number;
  head_sha: string; head_branch: string; github_pr_node_id: string; root_claim_id: number;
  created_by_principal_id: string; created_at: Date;
  producer_root_claim_id: number; producer_principal_id: string; producer_session_version: number;
};
const nativeLinkSelect = `SELECT link.*,producer.claim_id AS producer_claim_id,
  execution.root_claim_id AS producer_root_claim_id,execution.created_by_principal_id AS producer_principal_id,
  execution.created_by_session_version AS producer_session_version
  FROM collab_delivery_links link JOIN collab_scoped_tokens producer ON producer.id=link.producer_binding_id
  JOIN collab_claim_executions execution ON execution.claim_id=producer.claim_id`;

function unavailable(status = 409): CollabServiceError {
  return new CollabServiceError(status, 'pull_request_unavailable', 'The pull request could not be associated with this task.');
}

export async function lockPullRequestPipeline(tx: Executor, input: { orgId: string; repo: string; prNumber: number }) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`native-pr:${input.orgId}:${input.repo}:${input.prNumber}`]);
}

export async function readNativePullRequestLink(input: { orgId: string; repo: string; prNumber: number }, tx: Executor = getPool()): Promise<LinkRow | null> {
  return (await tx.query<LinkRow>(`${nativeLinkSelect} WHERE link.org_id=$1 AND link.repo=$2 AND link.pr_number=$3`,
    [input.orgId, input.repo, input.prNumber])).rows[0] ?? null;
}


async function sourceInTransaction(input: SourceInput, tx: PoolClient) {
  await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [input.taskId]);
  const authority = await resolveClaimEvidenceAuthority(input, tx);
  if (!authority.capabilities.includes('report.progress')) throw unavailable(403);
  const row = (await tx.query<{ repo: string; pr_number: number | null; claim_type: string; branch: string | null; root_claim_id: number }>(
    `SELECT claim.repo,claim.pr_number,claim.claim_type,claim.payload->>'branch' AS branch,execution.root_claim_id
     FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id
     WHERE claim.id=$1 AND execution.task_id=$2 AND claim.org_id=$3`, [input.claimId, input.taskId, authority.orgId])).rows[0];
  if (!row || !['build','review_fix'].includes(row.claim_type) || !row.repo || !row.branch) throw unavailable(403);
  if (row.claim_type === 'review_fix') {
    if (row.pr_number === null) throw unavailable();
    const origin = await readNativePullRequestLink({ orgId: authority.orgId, repo: row.repo, prNumber: row.pr_number }, tx);
    const mapped = origin ? await tx.query('SELECT root_claim_id FROM collab_pull_request_roots WHERE root_claim_id=$1 AND delivery_link_id=$2', [row.root_claim_id,origin.id]) : null;
    if (!origin || origin.task_id !== input.taskId || !mapped?.rows[0]) throw unavailable();
  }
  const observed = (await readClaimWorkspaceHeads([input.reportingBindingId], tx)).get(input.reportingBindingId);
  if (!observed || !observed.same_acquisition || observed.state !== 'known' || observed.dirty !== false
    || observed.repository?.toLowerCase() !== row.repo.toLowerCase() || observed.task_branch !== row.branch
    || observed.task_branch_head !== observed.head_commit) throw unavailable(422);
  const associated = (await tx.query<{ pr_number: number }>(`SELECT link.pr_number FROM collab_pull_request_roots root
    JOIN collab_delivery_links link ON link.id=root.delivery_link_id WHERE link.org_id=$1 AND root.root_claim_id=$2`,
    [authority.orgId,row.root_claim_id])).rows[0];
  return { ...authority, repo: row.repo, branch: row.branch, prNumber: row.pr_number ?? associated?.pr_number ?? null, claimType: row.claim_type,
    rootClaimId: row.root_claim_id, headCommit: observed.head_commit! };
}

export async function getClaimPullRequestSource(input: SourceInput) {
  const parsed = sourceSchema.parse(input);
  return withClientTransaction(tx => sourceInTransaction(parsed, tx));
}

function sameRepository(repo: string, pr: NativePullRequest) {
  return pr.base.repo.full_name.toLowerCase() === repo.toLowerCase()
    && pr.head.repo.full_name.toLowerCase() === repo.toLowerCase()
    && pr.head.repo.node_id === pr.base.repo.node_id;
}

export async function observeNativePullRequest(input: { orgId: string; repo: string; pullRequest: unknown }) {
  const parsed = nativePullRequestSchema.safeParse(input.pullRequest);
  if (!parsed.success) return null;
  const pr = parsed.data;
  if (!sameRepository(input.repo, pr)) return null;
  return withClientTransaction(async tx => {
    await lockPullRequestPipeline(tx, { ...input, prNumber: pr.number });
    const existing = (await tx.query<{ id: string; github_pr_node_id: string }>(
      'SELECT id,github_pr_node_id FROM collab_pull_request_candidates WHERE org_id=$1 AND repo=$2 AND pr_number=$3',
      [input.orgId, input.repo, pr.number])).rows[0];
    if (existing && existing.github_pr_node_id !== pr.node_id) throw unavailable();
    if (!existing) {
      const root = await tx.query<{ observed: boolean }>(`SELECT EXISTS(SELECT 1 FROM agent_claims claim
        JOIN collab_claim_executions execution ON execution.claim_id=claim.id
        JOIN collab_tasks task ON task.id=execution.task_id
        JOIN collab_projects project ON project.id=task.project_id AND project.id=execution.project_id
        JOIN collab_workspaces workspace ON workspace.id=project.workspace_id AND workspace.org_id=claim.org_id
        WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.claim_type='build' AND claim.status IN ('pending','claimed')
          AND claim.payload->>'branch'=$3 AND execution.created_by_session_version IS NOT NULL) AS observed`,
      [input.orgId, input.repo, pr.head.ref]);
      if (!root.rows[0].observed) return null;
    }
    const candidate = await tx.query<{ id: string }>(`INSERT INTO collab_pull_request_candidates(org_id,repo,pr_number,github_pr_node_id,head_branch,head_sha)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,repo,pr_number) DO UPDATE
      SET head_branch=EXCLUDED.head_branch,head_sha=EXCLUDED.head_sha RETURNING id`,
    [input.orgId, input.repo, pr.number, pr.node_id, pr.head.ref, pr.head.sha]);
    return candidate.rows[0].id;
  });
}

async function resolvePipelineSource(tx: PoolClient, input: { orgId: string; repo: string; prNumber: number; parentClaimId?: number; githubCheckId?: number }, link: LinkRow | null): Promise<PipelineSource> {
  let rows: Array<{ claim_id: number; claim_type: string; binding_id: string; task_id: string; project_id: string; root_claim_id: number; principal_id: string; session_version: number }>;
  if (input.parentClaimId !== undefined || link) {
    rows = link ? (await tx.query(`${sourceSelect}
      JOIN collab_pull_request_roots root ON root.root_claim_id=execution.root_claim_id AND root.delivery_link_id=$4
      WHERE claim.id=$1 AND claim.org_id=$2 AND claim.repo=$3 AND claim.claim_type IN ('build','review_fix','review','verify')
        AND (claim.pr_number=$5 OR claim.id=root.producer_claim_id OR claim.id=$8)
        AND execution.task_id=$6 AND execution.project_id=$7`,
      [input.parentClaimId ?? link.producer_claim_id, input.orgId, input.repo, link.id, input.prNumber, link.task_id, link.project_id, link.producer_claim_id])).rows
      : (await tx.query(`${sourceSelect}
      WHERE claim.id=$1 AND claim.org_id=$2 AND claim.repo=$3 AND claim.claim_type IN ('build','review_fix')
        AND claim.status='claimed' AND claim.expires_at>now()
        AND (claim.pr_number=$4 OR claim.pr_number IS NULL)`,
      [input.parentClaimId, input.orgId, input.repo, input.prNumber])).rows;
  } else {
    rows = (await tx.query(`${sourceSelect}
      JOIN agent_tokens origin ON origin.id=token.agent_token_id AND origin.org_id=claim.org_id
        AND origin.revoked_at IS NULL AND (origin.expires_at IS NULL OR origin.expires_at>now())
      JOIN agent_sessions runner ON runner.id=token.runner_session_id AND runner.org_id=claim.org_id
        AND runner.agent_id=origin.agent_id AND runner.status<>'offline' AND runner.expires_at>now()
      JOIN collab_principals principal ON principal.id=token.principal_id
        AND principal.disabled_at IS NULL AND principal.session_version=token.creator_session_version
      WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.claim_type IN ('build','review_fix')
        AND claim.status='claimed' AND claim.expires_at>now()
        AND (claim.pr_number=$3 OR claim.pr_number IS NULL)
        AND claim.payload->>'branch'='ff/task-'||execution.task_id::text
        AND execution.task_id=token.task_id AND execution.project_id=token.project_id
        AND execution.created_by_principal_id=token.principal_id AND execution.created_by_session_version=token.creator_session_version
        AND EXISTS (SELECT 1 FROM collab_pull_request_candidates candidate
          WHERE candidate.org_id=$1 AND candidate.repo=$2 AND candidate.pr_number=$3
            AND candidate.head_branch=claim.payload->>'branch')`,
      [input.orgId, input.repo, input.prNumber])).rows;
  }
  if (rows.length !== 1) throw unavailable(403);
  const source: PipelineSource = { claimId: rows[0].claim_id, claimType: rows[0].claim_type, bindingId: rows[0].binding_id, taskId: rows[0].task_id,
    projectId: rows[0].project_id, rootClaimId: rows[0].root_claim_id, principalId: rows[0].principal_id, sessionVersion: rows[0].session_version };
  await authorize({ principalId: source.principalId, sessionVersion: source.sessionVersion }, { projectId: source.projectId }, ['internal.read', 'run.start'], tx);
  return source;
}

export async function attachPullRequestClaim(tx: PoolClient, input: { orgId: string; repo: string; prNumber: number; claimId: number;
  parentClaimId?: number; source?: PipelineSource; githubCheckId?: number }) {
  const link = await readNativePullRequestLink(input, tx);
  const claim = (await tx.query<{ head_sha: string | null }>('SELECT head_sha FROM agent_claims WHERE id=$1 AND org_id=$2 AND repo=$3 AND pr_number=$4',
    [input.claimId, input.orgId, input.repo, input.prNumber])).rows[0];
  if (!claim) throw unavailable();
  const source = input.source;
  const awaitsProducer = source && ['build','review_fix'].includes(source.claimType)
    && (!link || link.producer_binding_id !== source.bindingId || link.head_sha !== claim.head_sha);
  if (!link || awaitsProducer) {
    if (!source) throw unavailable(403);
    const head = claim.head_sha;
    if (!head || !HEAD_PATTERN.test(head)) throw unavailable(422);
    await tx.query(`INSERT INTO collab_claim_pr_reservations(claim_id,candidate_id,producer_binding_id,task_id,root_claim_id,github_check_id,head_sha)
      SELECT $1,candidate.id,$2,$3,$4,$5,$6 FROM collab_pull_request_candidates candidate
      WHERE candidate.org_id=$7 AND candidate.repo=$8 AND candidate.pr_number=$9
      ON CONFLICT(claim_id) DO NOTHING`,
      [input.claimId, source.bindingId, source.taskId, source.rootClaimId, input.githubCheckId ?? null, head,
        input.orgId, input.repo, input.prNumber]);
    return;
  }
  await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [link.task_id]);
  const parentClaimId = input.parentClaimId ?? (claim.head_sha === link.head_sha ? link.producer_claim_id : null);
  let owner = { root_claim_id: link.producer_root_claim_id, created_by_principal_id: link.producer_principal_id,
    created_by_session_version: link.producer_session_version };
  if (input.parentClaimId !== undefined) {
    const parent = (await tx.query<typeof owner>(`SELECT execution.root_claim_id,execution.created_by_principal_id,execution.created_by_session_version
      FROM collab_claim_executions execution JOIN agent_claims parent ON parent.id=execution.claim_id
      JOIN collab_pull_request_roots root ON root.root_claim_id=execution.root_claim_id AND root.delivery_link_id=$2
      WHERE execution.claim_id=$1 AND execution.task_id=$3 AND execution.project_id=$4 AND parent.org_id=$5 AND parent.repo=$6
        AND (parent.pr_number=$7 OR parent.id=root.producer_claim_id OR parent.id=$8)`,
    [input.parentClaimId,link.id,link.task_id,link.project_id,input.orgId,input.repo,input.prNumber,link.producer_claim_id])).rows[0];
    if (!parent) throw unavailable();
    owner = parent;
  }
  await authorize({ principalId: owner.created_by_principal_id, sessionVersion: owner.created_by_session_version },
    { projectId: link.project_id }, ['internal.read', 'run.start'], tx);
  await tx.query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version,parent_claim_id,delivery_link_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [link.task_id,link.project_id,input.claimId,owner.root_claim_id,
    owner.created_by_principal_id,owner.created_by_session_version,parentClaimId,link.id]);
}

export async function recordClaimPullRequest(input: SourceInput & { pullRequest: unknown }) {
  const parsed = sourceSchema.parse({ taskId: input.taskId, claimId: input.claimId, reportingBindingId: input.reportingBindingId });
  const pr = nativePullRequestSchema.parse(input.pullRequest);
  const context = await getClaimPullRequestSource(parsed);
  if (!sameRepository(context.repo, pr) || pr.head.ref !== context.branch || pr.head.sha !== context.headCommit
    || (context.prNumber !== null && context.prNumber !== pr.number)) throw unavailable(422);
  return withClientTransaction(async tx => {
    await lockPullRequestPipeline(tx, { orgId: context.orgId, repo: context.repo, prNumber: pr.number });
    const current = await sourceInTransaction(parsed, tx);
    if (current.repo !== context.repo || current.branch !== pr.head.ref || current.headCommit !== pr.head.sha
      || (current.prNumber !== null && current.prNumber !== pr.number)) throw unavailable();
    const existing = await readNativePullRequestLink({ orgId: current.orgId, repo: current.repo, prNumber: pr.number }, tx);
    if (existing && (existing.task_id !== current.taskId || existing.project_id !== current.projectId
      || existing.github_pr_node_id !== pr.node_id)) throw unavailable();
    const candidate = (await tx.query<{ id: string; github_pr_node_id: string }>(
      'SELECT id,github_pr_node_id FROM collab_pull_request_candidates WHERE org_id=$1 AND repo=$2 AND pr_number=$3 FOR UPDATE',
      [current.orgId, current.repo, pr.number])).rows[0];
    if (candidate && candidate.github_pr_node_id !== pr.node_id) throw unavailable();
    let linkId = existing?.id;
    if (!existing) {
      if (current.claimType !== 'build') throw unavailable();
      linkId = (await tx.query<{ id: string }>(`INSERT INTO collab_delivery_links(task_id,project_id,repo,pr_number,claim_id,created_by_principal_id,
        org_id,native_binding_id,producer_binding_id,github_pr_node_id,head_branch,head_sha,root_claim_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12) RETURNING id`,
      [current.taskId,current.projectId,current.repo,pr.number,String(current.claimId),current.authorId,current.orgId,
        parsed.reportingBindingId,pr.node_id,pr.head.ref,pr.head.sha,current.rootClaimId])).rows[0].id;
    }
    await tx.query(`INSERT INTO collab_pull_request_roots(root_claim_id,delivery_link_id,producer_claim_id)
      SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM collab_pull_request_roots WHERE root_claim_id=$1)
      ON CONFLICT(root_claim_id) DO NOTHING`, [current.rootClaimId,linkId,current.claimId]);
    const root = (await tx.query<{ delivery_link_id: string }>('SELECT delivery_link_id FROM collab_pull_request_roots WHERE root_claim_id=$1', [current.rootClaimId])).rows[0];
    if (!root || root.delivery_link_id !== linkId) throw unavailable();
    if (existing) {
      await tx.query('UPDATE collab_delivery_links SET producer_binding_id=$2,head_branch=$3,head_sha=$4 WHERE id=$1',
        [existing.id,parsed.reportingBindingId,pr.head.ref,pr.head.sha]);
    }
    const candidateId = (await tx.query<{ id: string }>(`INSERT INTO collab_pull_request_candidates(org_id,repo,pr_number,github_pr_node_id,head_branch,head_sha,delivery_link_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,repo,pr_number) DO UPDATE
      SET head_branch=EXCLUDED.head_branch,head_sha=EXCLUDED.head_sha,delivery_link_id=EXCLUDED.delivery_link_id RETURNING id`,
    [current.orgId,current.repo,pr.number,pr.node_id,pr.head.ref,pr.head.sha,linkId])).rows[0].id;
    const reserved = await tx.query<{ id: number; head_sha: string | null }>(`SELECT claim.id,claim.head_sha FROM collab_claim_pr_reservations reservation
      JOIN agent_claims claim ON claim.id=reservation.claim_id
      JOIN collab_scoped_tokens token ON token.id=reservation.producer_binding_id
      WHERE reservation.candidate_id=$1 AND reservation.producer_binding_id=$2 AND reservation.task_id=$3
        AND reservation.root_claim_id=$4 AND reservation.head_sha=$5 AND token.claim_id=$6
        AND claim.org_id=$7 AND claim.repo=$8 AND claim.pr_number=$9
        AND claim.status='pending' AND claim.session_id IS NULL
      ORDER BY claim.id FOR UPDATE OF claim`,
      [candidateId, parsed.reportingBindingId, current.taskId, current.rootClaimId, pr.head.sha, parsed.claimId, current.orgId, current.repo, pr.number]);
    for (const claim of reserved.rows) {
      if (claim.head_sha === pr.head.sha) {
        await attachPullRequestClaim(tx, { orgId: current.orgId, repo: current.repo, prNumber: pr.number, claimId: claim.id, parentClaimId: current.claimId });
      } else {
        await tx.query("UPDATE agent_claims SET status='cancelled',completed_at=now(),archived_at=now() WHERE id=$1", [claim.id]);
      }
      await tx.query('DELETE FROM collab_claim_pr_reservations WHERE claim_id=$1', [claim.id]);
    }
    const linked = await readNativePullRequestLink({ orgId: current.orgId, repo: current.repo, prNumber: pr.number }, tx);
    if (!linked) throw unavailable();
    return deliveryLinkView(linked);
  });
}

async function insertPipelineClaimInTransaction(input: PendingClaimInput & { parentClaimId?: number; githubCheckId?: number }, tx: PoolClient): Promise<PendingClaimRow | null> {
  if (input.repo === null || input.prNumber === null) throw unavailable();
  if (input.parentClaimId === undefined && input.githubCheckId === undefined) throw unavailable(403);
  for (const value of [input.parentClaimId, input.githubCheckId]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw unavailable();
  }
  const scope = { orgId: input.orgId, repo: input.repo, prNumber: input.prNumber };
  await lockPullRequestPipeline(tx, scope);
  const link = await readNativePullRequestLink(scope, tx);
  if (link) await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [link.task_id]);
  const source = await resolvePipelineSource(tx, { ...scope, parentClaimId: input.parentClaimId, githubCheckId: input.githubCheckId }, link);
  let claim = await insertPendingClaim(input, tx);
  if (!claim && input.attempt !== undefined) {
    const existing = (await tx.query<PendingClaimRow & { native: boolean }>(`SELECT claim.*,
      EXISTS(SELECT 1 FROM collab_claim_pr_reservations reservation WHERE reservation.claim_id=claim.id)
        OR EXISTS(SELECT 1 FROM collab_claim_executions execution WHERE execution.claim_id=claim.id AND execution.delivery_link_id=$6) AS native
      FROM agent_claims claim WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.pr_number=$3 AND claim.claim_type=$4 AND claim.attempt=$5 FOR UPDATE`,
    [scope.orgId,scope.repo,scope.prNumber,input.claimType,input.attempt,link?.id ?? null])).rows[0];
    if (!existing || (existing.native && existing.head_sha === (input.headSha ?? null))) return null;
    const sameHead = await tx.query(`SELECT claim.id FROM agent_claims claim
      WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.pr_number=$3 AND claim.claim_type=$4 AND claim.head_sha IS NOT DISTINCT FROM $5
        AND (EXISTS(SELECT 1 FROM collab_claim_pr_reservations reservation WHERE reservation.claim_id=claim.id)
          OR EXISTS(SELECT 1 FROM collab_claim_executions execution WHERE execution.claim_id=claim.id AND execution.delivery_link_id=$6))`,
    [scope.orgId,scope.repo,scope.prNumber,input.claimType,input.headSha ?? null,link?.id ?? null]);
    if (sameHead.rows[0]) return null;
    const pinned = (await tx.query<{ producer_binding_id: string; task_id: string; root_claim_id: number }>(
      'SELECT producer_binding_id,task_id,root_claim_id FROM collab_claim_pr_reservations WHERE claim_id=$1', [existing.id])).rows[0];
    if (pinned && pinned.producer_binding_id === source.bindingId && pinned.task_id === source.taskId
      && pinned.root_claim_id === source.rootClaimId && existing.status === 'pending' && existing.session_id === null) {
      claim = (await tx.query<PendingClaimRow>('UPDATE agent_claims SET payload=$2,head_sha=$3 WHERE id=$1 RETURNING *',
        [existing.id,input.payload,input.headSha ?? null])).rows[0];
      await tx.query('UPDATE collab_claim_pr_reservations SET head_sha=$2 WHERE claim_id=$1', [existing.id,input.headSha ?? null]);
    } else {
      claim = await insertPendingClaim({ ...input, attempt: undefined }, tx);
    }
  }
  if (claim) {
    await attachPullRequestClaim(tx, { ...scope, claimId: claim.id, parentClaimId: input.parentClaimId, source, githubCheckId: input.githubCheckId });
  }
  return claim;
}

export async function insertPullRequestPipelineClaim(input: PendingClaimInput & { parentClaimId?: number; githubCheckId?: number },
  executor?: PoolClient): Promise<PendingClaimRow | null> {
  return executor ? insertPipelineClaimInTransaction(input, executor) : withClientTransaction(async tx => insertPipelineClaimInTransaction(input, tx));
}

export async function cancelInvalidNativePrReservations(executor?: Executor): Promise<number> {
  const cancel = async (tx: Executor): Promise<number> => {
    const cancelled = await tx.query<{ id: number; org_id: string }>(`UPDATE agent_claims claim
      SET status='cancelled',completed_at=now(),archived_at=now()
      WHERE claim.status='pending' AND claim.session_id IS NULL
        AND EXISTS (SELECT 1 FROM collab_claim_pr_reservations reservation WHERE reservation.claim_id=claim.id)
        AND (
          EXISTS (SELECT 1 FROM collab_claim_pr_reservations reservation
            WHERE reservation.claim_id=claim.id AND reservation.producer_binding_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM collab_claim_pr_reservations reservation
            JOIN collab_scoped_tokens token ON token.id=reservation.producer_binding_id
            WHERE reservation.claim_id=claim.id AND (
              token.revoked_at IS NOT NULL
              OR NOT EXISTS (SELECT 1 FROM agent_claims source WHERE source.id=token.claim_id AND source.status='claimed'
                AND source.expires_at>now() AND source.claimed_at=token.claimed_at AND source.session_id=token.runner_session_id)
              OR NOT EXISTS (SELECT 1 FROM agent_sessions runner JOIN agent_tokens origin ON origin.id=token.agent_token_id
                WHERE runner.id=token.runner_session_id AND runner.org_id=claim.org_id AND runner.agent_id=origin.agent_id
                  AND runner.status<>'offline' AND runner.expires_at>now()
                  AND origin.org_id=claim.org_id AND origin.revoked_at IS NULL AND (origin.expires_at IS NULL OR origin.expires_at>now()))
              OR NOT EXISTS (SELECT 1 FROM collab_principals principal WHERE principal.id=token.principal_id
                AND principal.disabled_at IS NULL AND principal.session_version=token.creator_session_version)
            )
          )
        ) RETURNING claim.id,claim.org_id`);
    if (cancelled.rows.length === 0) return 0;
    await cancelOpenClaimInteractionsForClaims(cancelled.rows.map(row => ({ orgId: row.org_id, claimId: row.id })), tx);
    await tx.query('DELETE FROM collab_claim_pr_reservations WHERE claim_id=ANY($1)', [cancelled.rows.map(row => row.id)]);
    return cancelled.rows.length;
  };
  return executor ? cancel(executor) : withClientTransaction(async tx => cancel(tx));
}

export async function assertNativePullRequestCompletion(input: { orgId: string; claimId: number; replay?: boolean }, executor?: PoolClient): Promise<boolean> {
  return withClientTransaction(async tx => {
    const source = (await tx.query<{ task_id: string; created_by_session_version: number | null;
      root_claim_id: number; binding_id: string | null; repo: string; branch: string | null; status: string }>(
      `SELECT execution.task_id,execution.created_by_session_version,execution.root_claim_id,
        binding.id AS binding_id,claim.repo,claim.status,claim.payload->>'branch' AS branch
       FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id
       LEFT JOIN collab_scoped_tokens binding ON binding.claim_id=claim.id AND binding.claimed_at=claim.claimed_at
         AND binding.runner_session_id=claim.session_id AND binding.revoked_at IS NULL
       WHERE claim.id=$1 AND claim.org_id=$2 AND claim.claim_type IN ('build','review_fix')`,
      [input.claimId,input.orgId])).rows[0];
    if (!source || source.created_by_session_version === null) return false;
    if (input.replay) return source.status === 'completed';
    if (!source.binding_id || !source.branch) throw new CollabServiceError(409, 'native_output_not_ready', 'Work output is not ready for completion.');
    await resolveClaimCompletionAuthority({ taskId: source.task_id, claimId: input.claimId, reportingBindingId: source.binding_id }, tx);
    const workspace = (await readClaimWorkspaceHeads([source.binding_id], tx)).get(source.binding_id);
    const link = (await tx.query<{ head_sha: string; head_branch: string }>(
      `SELECT link.head_sha,link.head_branch FROM collab_delivery_links link
       JOIN collab_pull_request_roots root ON root.delivery_link_id=link.id
       WHERE link.org_id=$1 AND link.task_id=$2 AND link.repo=$3 AND link.producer_binding_id=$4 AND root.root_claim_id=$5`,
      [input.orgId,source.task_id,source.repo,source.binding_id,source.root_claim_id])).rows[0];
    if (!workspace || !workspace.same_acquisition || workspace.state !== 'known' || !workspace.final || workspace.dirty !== false
      || workspace.repository?.toLowerCase() !== source.repo.toLowerCase() || workspace.task_branch !== source.branch
      || workspace.task_branch_head !== workspace.head_commit || !link || link.head_sha !== workspace.head_commit || link.head_branch !== source.branch) {
      throw new CollabServiceError(409, 'native_output_not_ready', 'Work output is not ready for completion.');
    }
    return true;
  }, executor);
}
