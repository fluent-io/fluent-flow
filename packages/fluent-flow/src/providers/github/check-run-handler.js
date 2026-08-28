import { resolveAgentId, dispatch } from '../../notifications/dispatcher.js';
import { getPRsForCommit, getCheckRunsForCommit, getCheckRunAnnotations } from './rest.js';
import { dispatchReview, claimDispatch } from '../../engine/review-manager.js';
import { handleTestFailure, handleTestSuccess } from '../../engine/test-manager.js';
import { getActivePause } from '../../engine/pause-manager.js';
import { parseCheckAnnotations } from '../../engine/test-parser.js';
import { sql } from 'drizzle-orm';
import { db, getVerificationResultByClaim } from '@fluent-flow/db';
import { audit } from '../../db/client.js';
import { resolveOrgId } from '../../config/loader.js';
import { createClaimWithRetry, getClaimById } from '../../agents/claim-manager.js';
import { onClaimDispatched } from '../../engine/check-run.js';
import { getProvider } from '../index.js';
import logger from '../../logger.js';

const FLUENT_FLOW_APP_SLUGS = new Set(['fluent-flow', 'fluent-flow-ci[bot]']);
const GREEN_CLAIM_DUPLICATE = Symbol('green-claim-duplicate');

/**
 * Check if a check run belongs to Fluent Flow (should be excluded from dispatch).
 * Matches Fluent Flow App-owned checks by slug, or checks with names starting with "Fluent Flow".
 * @param {object} checkRun
 * @returns {boolean}
 */
function isFluentFlowCheckRun(checkRun) {
  const appSlug = checkRun?.app?.slug ?? '';
  return FLUENT_FLOW_APP_SLUGS.has(appSlug) || /^Fluent Flow/i.test(checkRun?.name ?? '');
}

/**
 * Check if a check run belongs to the review workflow (should be ignored).
 * @param {object} checkRun
 * @returns {boolean}
 */
function isReviewCheckRun(checkRun) {
  return checkRun.app?.slug === 'github-actions' && /\breview\b/i.test(checkRun.name);
}

/**
 * Extract issue number linked to a PR from PR body.
 * Looks for "Fixes #N", "Closes #N", "Resolves #N".
 * @param {string} body
 * @returns {number|null}
 */
function extractLinkedIssue(body) {
  if (!body) return null;
  const match = body.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Lookup the latest completed review_fix claim for a PR and extract its source_claim_id.
 * Extracted for testability; in production this is called by createGreenClaim.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<number|null>}
 */
export async function findRedClaimIdFromLatestReviewFix(orgId, repo, prNumber) {
  const result = await db.execute(sql`
    SELECT id, payload->'source_claim_id' AS source_claim_id
    FROM agent_claims
    WHERE org_id = ${orgId} AND repo = ${repo} AND pr_number = ${prNumber}
      AND claim_type = 'review_fix' AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `);
  const row = (result.rows ?? result)[0];
  return row?.source_claim_id ?? null;
}

function isMatchingRedClaim(claim, { orgId, repo, prNumber }) {
  const verification = claim?.payload?.verification;
  return claim?.org_id === orgId
    && claim?.repo === repo
    && claim?.pr_number === prNumber
    && claim?.claim_type === 'verify'
    && claim?.status === 'completed'
    && claim?.payload?.phase === 'red'
    && verification
    && typeof verification === 'object';
}

function isUsableRedRecord(record, { orgId, repo, prNumber }) {
  return record?.orgId === orgId
    && record?.repo === repo
    && record?.prNumber === prNumber
    && record?.phase === 'red'
    && record?.manifest
    && typeof record.manifest === 'object'
    && Array.isArray(record?.testHashes)
    && record.testHashes.length > 0;
}


/**
 * Create a green claim with inlined red record and config snapshot.
 * Exact linkage: latest completed review_fix → source_claim_id → red claim → verification result.
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {string} opts.headSha
 * @param {object} opts.checkRun
 * @param {object} opts.config
 * @param {Function} [linkageResolver] - Test hook: resolves source_claim_id
 * @returns {Promise<{status: 'created', claim: object}|{status: 'duplicate'}|null>} Outcome, or null when no green claim applies
 */
async function createGreenClaim({ orgId, repo, prNumber, headSha, branch, checkRun, config }, linkageResolver = findRedClaimIdFromLatestReviewFix) {
  // Exact linkage: latest completed review_fix → source_claim_id → red claim
  const redClaimId = await linkageResolver(orgId, repo, prNumber);
  if (!redClaimId) return null;

  const redClaim = await getClaimById(orgId, redClaimId);
  if (!isMatchingRedClaim(redClaim, { orgId, repo, prNumber })) return null;

  const redRecord = await getVerificationResultByClaim(orgId, redClaimId);
  if (!isUsableRedRecord(redRecord, { orgId, repo, prNumber })) return null;

  // Inline the full red record + config snapshot
  const payload = {
    phase: 'green',
    red_claim_id: redClaimId,
    green_sha: headSha,
    branch: branch ?? null,
    red_record: {
      phase: redRecord.phase,
      framework: redRecord.framework,
      outcome: redRecord.outcome,
      matrix: redRecord.matrix,
      manifest: redRecord.manifest,
      test_hashes: redRecord.testHashes,
      artifact_sha: redRecord.artifactSha,
      red_base_sha: redRecord.redBaseSha,
    },
    verification: redClaim.payload.verification,
    findings: redClaim.payload.findings ?? [],
  };

  const claim = await createClaimWithRetry(
    {
      orgId,
      repo,
      prNumber,
      claimType: 'verify',
      payload,
      headSha,
    },
    async (opts) => {
      const insertResult = await db.execute(sql`
        INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
        VALUES (
          ${opts.orgId}, ${opts.repo}, ${opts.prNumber}, ${opts.attempt},
          ${opts.claimType}, 'pending', ${JSON.stringify(opts.payload)}::jsonb, ${opts.headSha}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `);
      const created = (insertResult.rows ?? insertResult)[0];
      if (created) return created;

      const duplicateResult = await db.execute(sql`
        SELECT id FROM agent_claims
        WHERE org_id = ${opts.orgId} AND repo = ${opts.repo} AND pr_number = ${opts.prNumber}
          AND claim_type = 'verify' AND head_sha = ${opts.headSha}
          AND payload->>'phase' = 'green'
        LIMIT 1
      `);
      return (duplicateResult.rows ?? duplicateResult)[0] ? GREEN_CLAIM_DUPLICATE : null;
    },
  );

  return claim === GREEN_CLAIM_DUPLICATE ? { status: 'duplicate' } : { status: 'created', claim };
}

/**
 * Handle GitHub check_run events.
 * Routes to failure notifications or success-triggered review dispatch.
 * Ignores Fluent Flow and review workflow check runs on both paths.
 * @param {string} owner
 * @param {string} repoName
 * @param {object} payload - GitHub webhook payload
 * @param {object} config - Fluent Flow config for this repo
 */
export async function handleCheckRun(owner, repoName, payload, config) {
  const { action, check_run: checkRun } = payload;
  if (action !== 'completed') return;
  if (isFluentFlowCheckRun(checkRun) || isReviewCheckRun(checkRun)) return;

  // Resolve installation context for authenticated GitHub API calls
  const installationId = payload.installation?.id;
  const ctx = installationId ? { installation_id: installationId } : undefined;

  if (checkRun.conclusion === 'failure') {
    await handleCheckRunFailure(owner, repoName, checkRun, config, ctx);
    return;
  }

  if (checkRun.conclusion === 'success' || checkRun.conclusion === 'neutral') {
    await handleCheckRunSuccess(owner, repoName, checkRun, config, ctx);
  }
}

/**
 * Detect if this check run is a test runner (vs build/lint/etc.).
 * @param {object} checkRun
 * @returns {boolean}
 */
function isTestCheckRun(checkRun) {
  return /\b(test|tests|jest|vitest|pytest|mocha|xunit|unittest|rspec)\b/i.test(checkRun.name);
}

/**
 * Handle CI failure — notify the configured agent, or create test failure work item.
 */
async function handleCheckRunFailure(owner, repoName, checkRun, config, ctx) {
  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha, ctx);
    if (prs && prs.length > 0) pr = prs[0];
  } catch (err) {
    // Safe to continue: PR lookup failure means we can't determine
    // which PR this CI failure belongs to — log and proceed without
    // a linked PR. The agent notification will be less specific.
    logger.warn({ msg: 'Failed to fetch linked PRs for CI failure', repo: `${owner}/${repoName}`, sha: checkRun.head_sha, error: err.message });
  }

  // If this is a test check run, route to test-manager for work item creation
  if (isTestCheckRun(checkRun) && pr) {
    const annotations = await getCheckRunAnnotations(owner, repoName, checkRun.id, ctx);
    const testFailures = parseCheckAnnotations(annotations);
    const issueNumber = extractLinkedIssue(pr.body);
    await handleTestFailure({
      owner,
      repo: repoName,
      sha: checkRun.head_sha,
      checkName: checkRun.name,
      testFailures,
      issueNumber,
      config,
      ctx,
    });
    return;
  }

  // General CI failure — notify agent
  const prBody = pr?.body;
  const prNumber = pr?.number;
  const prTitle = pr?.title ?? '';

  const agentId = resolveAgentId({ prBody, config });
  if (!agentId) {
    logger.info({ msg: 'No agent_id configured, skipping CI failure notification', repo: `${owner}/${repoName}` });
    return;
  }

  const repoFullName = `${owner}/${repoName}`;
  const message = prNumber
    ? `CI FAILED: ${repoFullName}#${prNumber} (${prTitle}) — check "${checkRun.name}" failed. Fix the issue and push.`
    : `CI FAILED: ${repoFullName} — check "${checkRun.name}" failed at ${checkRun.completed_at}. Fix and push.`;

  await dispatch({
    agentId,
    event: 'ci_failed',
    payload: { message, wakeMode: 'now', deliver: true, repo: repoFullName, prNumber, check: checkRun.name },
  });

  audit('ci_failed', { repo: repoFullName, data: { check: checkRun.name, pr: prNumber, sha: checkRun.head_sha } });
  logger.info({ msg: 'CI failure notification sent', repo: repoFullName, check: checkRun.name, pr: prNumber });
}

/**
 * Handle CI success — dispatch automated review if configured.
 * Uses trigger_check for exact match, or falls back to waiting for all checks to pass.
 */
async function handleCheckRunSuccess(owner, repoName, checkRun, config, ctx) {
  if (!config.reviewer?.enabled) return;

  const triggerCheck = config.reviewer?.trigger_check;
  const repoKey = `${owner}/${repoName}`;

  if (triggerCheck) {
    // Use startsWith to handle matrix jobs (e.g. "test (20)" matches "test")
    if (!checkRun.name.startsWith(triggerCheck)) return;
  } else {
    try {
      const allChecks = await getCheckRunsForCommit(owner, repoName, checkRun.head_sha, ctx);
      const ciChecks = allChecks.filter((c) => !isFluentFlowCheckRun(c) && !isReviewCheckRun(c));
      const allPassed = ciChecks.every(
        (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'neutral')
      );
      if (!allPassed) {
        logger.info({ msg: 'Not all checks passed yet, waiting', repo: repoKey, sha: checkRun.head_sha });
        return;
      }
    } catch (err) {
      // Safe to continue: check-runs query failure means we can't determine
      // if all CI passed — return early, the review will be dispatched on a
      // future check_run.completed event.
      logger.error({ msg: 'Failed to query check runs for fallback', repo: repoKey, error: err.message });
      return;
    }
  }

  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha, ctx);
    if (prs && prs.length > 0) pr = prs[0];
  } catch (err) {
    // Safe to continue: PR lookup failure means we can't determine which
    // PR to review — return early, the review will dispatch when a future
    // check_run event provides a linkable PR.
    logger.warn({ msg: 'Failed to find linked PR for review dispatch', repo: repoKey, sha: checkRun.head_sha, error: err.message });
    return;
  }

  if (!pr) {
    logger.info({ msg: 'No linked PR for check run, skipping review', repo: repoKey, sha: checkRun.head_sha });
    return;
  }

  if (pr.state !== 'open') {
    logger.info({ msg: 'PR is not open, skipping review', repo: repoKey, prNumber: pr.number, state: pr.state });
    return;
  }

  const issueNumber = extractLinkedIssue(pr.body);

  if (issueNumber) {
    const activePause = await getActivePause(repoKey, issueNumber);
    if (activePause) {
      logger.info({ msg: 'Skipping review dispatch — issue is paused', repo: repoKey, prNumber: pr.number, issueNumber, pauseId: activePause.id });
      return;
    }
  }

  const maxRetries = config.reviewer?.max_retries ?? 3;
  const claim = await claimDispatch(repoKey, pr.number, checkRun.head_sha, maxRetries);
  if (!claim) {
    logger.info({ msg: 'Skipping review dispatch — duplicate SHA or max retries', repo: repoKey, prNumber: pr.number, sha: checkRun.head_sha });
    return;
  }

  const priorIssues = claim.last_issues ?? [];
  const attempt = (claim.retry_count ?? 0) + 1;

  // On test check success, update work item state if this is a test runner
  if (isTestCheckRun(checkRun)) {
    await handleTestSuccess({
      owner,
      repo: repoName,
      sha: checkRun.head_sha,
      issueNumber,
      config,
      ctx,
    });
  }

  // Try green claim creation via review_fix linkage
  let resolvedOrgId = null;
  try {
    resolvedOrgId = await resolveOrgId(owner, repoName);
    const greenClaim = await createGreenClaim({
      orgId: resolvedOrgId,
      repo: repoKey,
      prNumber: pr.number,
      headSha: checkRun.head_sha,
      branch: pr.head?.ref ?? null,
      checkRun,
      config,
    });

    if (greenClaim?.status === 'created') {
      if (ctx?.installation_id) {
        try {
          const providerClient = getProvider({ provider: 'github', installation_id: ctx.installation_id });
          await onClaimDispatched(providerClient, {
            ...greenClaim.claim,
            head_sha: checkRun.head_sha,
            installation_id: ctx.installation_id,
          });
        } catch (err) {
          // Safe to continue: the green verify claim exists and runners can
          // execute it; only the GitHub check-run mirror failed.
          logger.warn({ msg: 'Green verify check-run dispatch failed', repo: repoKey, prNumber: pr.number, error: err.message });
        }
      } else {
        logger.warn({ msg: 'Green verify check-run dispatch skipped — no installation context', repo: repoKey, prNumber: pr.number });
      }
      logger.info({ msg: 'Created green claim after review_fix + CI pass', repo: repoKey, prNumber: pr.number });
      // Early return: green claim will verify fixes, then auto-chain will trigger review
      return;
    }

    if (greenClaim?.status === 'duplicate') {
      logger.info({ msg: 'Skipping review dispatch — duplicate green claim', repo: repoKey, prNumber: pr.number, sha: checkRun.head_sha });
      return;
    }

    // If createGreenClaim returned null (no linkage or red record missing), fall through
    logger.info({ msg: 'No green claim created (no review_fix linkage or missing red record), falling back to review dispatch', repo: repoKey, prNumber: pr.number });
  } catch (err) {
    // Safe to continue: green claim creation failure falls back to
    // dispatching a regular review — no work is lost.
    logger.error({ msg: 'Failed to create green claim, falling back to review', error: err.message });
  }

  try {
    await dispatchReview({
      owner, repo: repoName, prNumber: pr.number,
      ref: pr.head?.ref ?? 'main', headSha: checkRun.head_sha, attempt, priorIssues, issueNumber,
      ctx,
    });
    logger.info({ msg: 'Review dispatched after CI pass', repo: repoKey, prNumber: pr.number, attempt, trigger: triggerCheck ?? 'all-checks' });
  } catch (err) {
    // Safe to continue: review dispatch failure after CI pass — the
    // review can be manually triggered or will be re-attempted on the
    // next push/check_run event.
    logger.error({ msg: 'Failed to dispatch review after CI pass', repo: repoKey, prNumber: pr.number, error: err.message });
  }
}

export { isFluentFlowCheckRun };