import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withClientTransaction } from './tx.js';
import { authorize } from './authorize.js';
import { CollabServiceError } from './errors.js';
import { reportingServerKey } from './runs.js';
import { resolveClaimEvidenceAuthority } from './claim-reporting.js';
import { insertPullRequestPipelineClaim, lockPullRequestPipeline, nativePullRequestSchema, readNativePullRequestLink } from './claim-pull-requests.js';
import type { PendingClaimRow } from '../queries/claims.js';

const findingSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  file: z.string().min(1).max(1024).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(1).max(4000).optional(),
  issue: z.string().min(1).max(4000).optional(),
}).refine(value => value.message !== undefined || value.issue !== undefined);
export const nativeReviewVerdictSchema = z.object({
  status: z.enum(['PASS','FAIL']),
  blocking: z.array(findingSchema).max(100).default([]),
  advisory: z.array(findingSchema).max(100).default([]),
});
type Verdict = z.infer<typeof nativeReviewVerdictSchema>;
type Publication = {
  id: string; reporting_binding_id: string; head_sha: string; result_json: string; result_hash: string;
  applied_at: Date | null; claim_id: number; attempt: number; runner_session_id: number; acquired_at_key: string;
  task_id: string; project_id: string; created_by_principal_id: string; created_by_session_version: number;
};

function unavailable(status = 409) {
  return new CollabServiceError(status, 'review_unavailable', 'The review result could not be applied.');
}

function publicationTicket(row: Publication): string {
  return `ffrv_${createHmac('sha256', reportingServerKey()).update(JSON.stringify([
    'fluent-flow:claim-review-publication:v1', row.id, row.reporting_binding_id, row.claim_id,
    row.acquired_at_key, row.runner_session_id, row.head_sha, row.result_hash,
  ])).digest('base64url')}`;
}

function matchesTicket(row: Publication, ticket: unknown): boolean {
  if (typeof ticket !== 'string' || !/^ffrv_[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
  const expected = Buffer.from(publicationTicket(row));
  const received = Buffer.from(ticket);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const publicationSelect = `SELECT publication.*,binding.claim_id,binding.runner_session_id,claim.attempt,
  to_char(binding.claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired_at_key,
  execution.task_id,execution.project_id,execution.created_by_principal_id,execution.created_by_session_version
  FROM collab_claim_review_results publication JOIN collab_scoped_tokens binding ON binding.id=publication.reporting_binding_id
  JOIN agent_claims claim ON claim.id=binding.claim_id
  JOIN collab_claim_executions execution ON execution.claim_id=claim.id
  JOIN collab_tasks task ON task.id=execution.task_id
  JOIN collab_projects project ON project.id=task.project_id AND project.id=execution.project_id
  JOIN collab_workspaces workspace ON workspace.id=project.workspace_id AND workspace.org_id=claim.org_id`;

export async function publishNativeReviewResult(input: {
  taskId: string; claimId: number; reportingBindingId: string; result: unknown;
}) {
  const result = nativeReviewVerdictSchema.parse(input.result);
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 60000 || (result.status === 'FAIL' && result.blocking.length === 0)) {
    throw unavailable(422);
  }
  const hash = createHash('sha256').update(json).digest('hex');
  return withClientTransaction(async tx => {
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [input.taskId]);
    const authority = await resolveClaimEvidenceAuthority(input, tx);
    if (!authority.capabilities.includes('report.progress')) throw unavailable(403);
    const claim = (await tx.query<{ head_sha: string }>(`SELECT claim.head_sha FROM agent_claims claim
      JOIN collab_claim_executions execution ON execution.claim_id=claim.id
      WHERE claim.id=$1 AND claim.claim_type='review' AND claim.repo IS NOT NULL AND claim.pr_number IS NOT NULL
        AND claim.head_sha IS NOT NULL AND execution.delivery_link_id IS NOT NULL`, [input.claimId])).rows[0];
    if (!claim) throw unavailable(403);
    await tx.query(`INSERT INTO collab_claim_review_results(reporting_binding_id,head_sha,result_json,result_hash)
      VALUES($1,$2,$3,$4) ON CONFLICT(reporting_binding_id) DO NOTHING`, [input.reportingBindingId,claim.head_sha,json,hash]);
    const row = (await tx.query<Publication>(`${publicationSelect} WHERE publication.reporting_binding_id=$1`, [input.reportingBindingId])).rows[0];
    if (!row || row.result_hash !== hash || row.result_json !== json || row.head_sha !== claim.head_sha) throw unavailable();
    return { marker: { ...result, claim_id: row.claim_id, attempt: row.attempt,
      review_result_id: row.id, review_ticket: publicationTicket(row) } };
  });
}

type ReviewInput = {
  orgId: string; repo: string; prNumber: number; result: Record<string, unknown>; reviewSha: unknown;
  githubReviewNodeId: unknown; pullRequest: unknown; verification: Record<string, unknown>;
  onFailure?: unknown; issueNumber?: number | null; prBody?: string | null;
};
type AppliedReview = { action: 'PASS' | 'FAIL'; created: boolean; claimId: number; result: Verdict & { attempt: number };
  retryCount: number; claim: PendingClaimRow | null };

async function priorRedRecords(tx: PoolClient, input: ReviewInput, rootClaimId: number) {
  const records = await tx.query(`SELECT result.claim_id,result.phase,result.framework,result.outcome,result.manifest,
    result.test_hashes,result.artifact_sha,result.red_base_sha FROM verification_results result
    JOIN collab_claim_executions execution ON execution.claim_id=result.claim_id
    WHERE result.org_id=$1 AND result.repo=$2 AND result.pr_number=$3 AND result.phase='red'
      AND execution.root_claim_id=$4 ORDER BY result.created_at DESC,result.claim_id DESC`,
  [input.orgId,input.repo,input.prNumber,rootClaimId]);
  return records.rows.filter(row => row.manifest && Array.isArray(row.test_hashes) && row.test_hashes.length > 0)
    .map(row => ({ claim_id: row.claim_id, phase: row.phase, framework: row.framework, outcome: row.outcome,
      manifest: row.manifest, test_hashes: row.test_hashes, artifact_sha: row.artifact_sha, red_base_sha: row.red_base_sha }));
}

export async function applyNativeReviewResult(input: ReviewInput): Promise<AppliedReview | { action: 'ignored' } | undefined> {
  return withClientTransaction(async tx => {
    await lockPullRequestPipeline(tx, input);
    const link = await readNativePullRequestLink(input, tx);
    if (!link) return undefined;
    const current = nativePullRequestSchema.safeParse(input.pullRequest);
    const verdict = nativeReviewVerdictSchema.safeParse(input.result);
    if (!current.success || !verdict.success || typeof input.result.review_result_id !== 'string'
      || !z.string().uuid().safeParse(input.result.review_result_id).success
      || !Number.isSafeInteger(input.result.claim_id) || typeof input.githubReviewNodeId !== 'string'
      || input.githubReviewNodeId.length === 0 || input.githubReviewNodeId.length > 200
      || current.data.node_id !== link.github_pr_node_id || current.data.number !== input.prNumber
      || current.data.base.repo.full_name.toLowerCase() !== input.repo.toLowerCase()
      || current.data.head.repo.node_id !== current.data.base.repo.node_id
      || current.data.head.repo.full_name.toLowerCase() !== input.repo.toLowerCase()
      || current.data.head.sha !== input.reviewSha) return { action: 'ignored' };
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [link.task_id]);
    const row = (await tx.query<Publication>(`${publicationSelect}
      WHERE publication.id=$1 AND claim.id=$2 AND claim.org_id=$3 AND claim.repo=$4 AND claim.pr_number=$5
        AND publication.head_sha=$6 AND claim.head_sha=publication.head_sha AND claim.claim_type='review'
        AND binding.claimed_at=claim.claimed_at AND binding.runner_session_id=claim.session_id AND binding.revoked_at IS NULL
        AND execution.delivery_link_id=$7 AND execution.task_id=$8 AND execution.root_claim_id=$9
        AND binding.task_id=execution.task_id AND binding.project_id=execution.project_id
        AND binding.principal_id=execution.created_by_principal_id AND binding.creator_session_version=execution.created_by_session_version
        AND (claim.status='completed' OR (claim.status='claimed' AND claim.expires_at>now()))
      FOR UPDATE OF publication FOR SHARE OF claim`,
    [input.result.review_result_id,input.result.claim_id,input.orgId,input.repo,input.prNumber,input.reviewSha,
      link.id,link.task_id,link.producer_root_claim_id])).rows[0];
    if (!row || !matchesTicket(row, input.result.review_ticket)
      || JSON.stringify(verdict.data) !== row.result_json) return { action: 'ignored' };
    const canonical = verdict.data;
    if (createHash('sha256').update(row.result_json).digest('hex') !== row.result_hash) throw unavailable(503);
    await authorize({ principalId: row.created_by_principal_id, sessionVersion: row.created_by_session_version },
      { projectId: row.project_id }, ['internal.read','run.start'], tx);
    if (row.applied_at !== null) return { action: canonical.status, created: false, claimId: row.claim_id,
      result: { ...canonical, attempt: row.attempt }, retryCount: 0, claim: null };
    const issues = [...canonical.blocking.map(finding => ({ ...finding, severity: 'blocking' })),
      ...canonical.advisory.map(finding => ({ ...finding, severity: 'advisory' }))];
    const retry = (await tx.query<{ retry_count: number }>(`INSERT INTO review_retries(repo,pr_number,retry_count,last_issues,last_review_sha)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(repo,pr_number) DO UPDATE SET
        retry_count=review_retries.retry_count+$3,
        last_issues=CASE WHEN $3=1 THEN EXCLUDED.last_issues ELSE review_retries.last_issues END,
        last_review_sha=EXCLUDED.last_review_sha,updated_at=now() RETURNING retry_count`,
    [input.repo,input.prNumber,canonical.status === 'FAIL' ? 1 : 0,JSON.stringify(issues),row.head_sha])).rows[0];
    let claim: PendingClaimRow | null = null;
    if (canonical.status === 'FAIL' || canonical.advisory.length > 0) {
      const verify = canonical.status === 'FAIL' && input.verification.enabled === true;
      const findings = (canonical.status === 'PASS' ? canonical.advisory : canonical.blocking)
        .map((finding,index) => ({ id: finding.id ?? `F${index + 1}`, message: finding.message ?? finding.issue! }));
      const payload = verify ? {
        phase: 'red', findings, pr_body: input.prBody ?? null, issue_number: input.issueNumber ?? null,
        red_base_sha: row.head_sha, branch: current.data.head.ref, verification: input.verification,
        prior_red_records: await priorRedRecords(tx, input, link.producer_root_claim_id),
      } : { message: JSON.stringify(issues), findings, issues, onFailure: input.onFailure, branch: current.data.head.ref };
      claim = await insertPullRequestPipelineClaim({ orgId: input.orgId, repo: input.repo, prNumber: input.prNumber,
        claimType: verify ? 'verify' : 'review_fix', payload, headSha: row.head_sha, parentClaimId: row.claim_id }, tx);
      if (!claim) throw unavailable();
    }
    await tx.query(`UPDATE collab_claim_review_results SET applied_at=now(),github_review_node_id=$2,
      child_claim_id=$3,retry_count_after=$4 WHERE id=$1`, [row.id,input.githubReviewNodeId,claim?.id ?? null,retry.retry_count]);
    return { action: canonical.status, created: true, claimId: row.claim_id,
      result: { ...canonical, attempt: row.attempt }, retryCount: retry.retry_count, claim };
  });
}
