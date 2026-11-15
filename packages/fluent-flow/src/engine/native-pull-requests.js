import { CollabServiceError, getClaimPullRequestSource, recordClaimPullRequest, observeNativePullRequest, getPool, readNativePullRequestLink, applyNativeReviewResult } from '@fluent-flow/db';
import { installationCtxForRepo } from '../config/loader.js';
import { getPR, findPullRequestsByHead } from '../providers/github/rest.js';

export async function linkClaimPullRequest({ taskId, claimId, reportingBindingId, prNumber }) {
  const source = { taskId, claimId, reportingBindingId };
  const scope = await getClaimPullRequestSource(source);
  if (prNumber !== undefined && scope.prNumber !== null && prNumber !== scope.prNumber) {
    throw new CollabServiceError(409, 'pull_request_unavailable', 'The pull request could not be associated with this task.');
  }
  const [owner, repo] = scope.repo.split('/');
  const context = await installationCtxForRepo(owner, repo);
  const number = prNumber ?? scope.prNumber;
  let pullRequest;
  if (number !== null && number !== undefined) pullRequest = await getPR(owner, repo, number, context);
  else {
    const matches = await findPullRequestsByHead(owner, repo, scope.branch, context);
    if (!Array.isArray(matches) || matches.length !== 1) {
      throw new CollabServiceError(422, 'pull_request_required', 'Open one pull request for this task before completing the build.');
    }
    [pullRequest] = matches;
  }
  return recordClaimPullRequest({ ...source, pullRequest });
}

export async function prepareNativePullRequestClaim({ orgId, repo, prNumber, payload, headSha, parentClaimId, githubCheckId }) {
  if (prNumber === null || prNumber === undefined) return null;
  if (parentClaimId === undefined && githubCheckId === undefined) return null;
  if ([parentClaimId, githubCheckId].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
    throw new CollabServiceError(409, 'pull_request_unavailable', 'The pull request could not be associated with this task.');
  }
  const exists = await getPool().query(`SELECT 1 FROM collab_pull_request_candidates WHERE org_id=$1 AND repo=$2 AND pr_number=$3
    UNION ALL SELECT 1 FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id
      WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.claim_type='build' AND claim.status IN ('pending','claimed')
        AND claim.payload->>'branch'=$4 AND execution.created_by_session_version IS NOT NULL LIMIT 1`,
  [orgId, repo, prNumber, payload?.branch ?? null]);
  if (!exists.rows[0]) return null;
  const [owner, name] = repo.split('/');
  const context = await installationCtxForRepo(owner, name);
  const pullRequest = await getPR(owner, name, prNumber, context);
  const candidate = await observeNativePullRequest({ orgId, repo, pullRequest });
  if (!candidate) {
    const verified = await getPool().query('SELECT id FROM collab_delivery_links WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND native_binding_id IS NOT NULL', [orgId, repo, prNumber]);
    if (verified.rows[0]) throw new CollabServiceError(409, 'pull_request_unavailable', 'The pull request could not be associated with this task.');
  }
  return candidate === null ? null : { headSha: pullRequest.head.sha, branch: pullRequest.head.ref,
    stale: (headSha !== null && headSha !== undefined && headSha !== pullRequest.head.sha)
      || (payload?.branch !== undefined && payload.branch !== pullRequest.head.ref) };
}

export async function consumeNativeReviewResult(input) {
  const link = await readNativePullRequestLink(input);
  if (!link) return undefined;
  if (typeof input.result.review_result_id !== 'string' || typeof input.result.review_ticket !== 'string') return { action: 'ignored' };
  const [owner, repo] = input.repo.split('/');
  const context = input.ctx ?? await installationCtxForRepo(owner, repo);
  const pullRequest = await getPR(owner, repo, input.prNumber, context);
  return applyNativeReviewResult({ ...input, pullRequest });
}
