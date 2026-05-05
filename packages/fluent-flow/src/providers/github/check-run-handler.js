import { resolveAgentId, dispatch } from '../../notifications/dispatcher.js';
import { getPRsForCommit, getCheckRunsForCommit, getCheckRunAnnotations } from './rest.js';
import { dispatchReview, claimDispatch } from '../../engine/review-manager.js';
import { handleTestFailure, handleTestSuccess } from '../../engine/test-manager.js';
import { getActivePause } from '../../engine/pause-manager.js';
import { parseCheckAnnotations } from '../../engine/test-parser.js';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../../db/client.js';
import { createClaim } from '../../agents/claim-manager.js';
import { resolveOrgId } from '../../config/loader.js';
import logger from '../../logger.js';

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
 * Handle GitHub check_run events.
 * Routes to failure notifications or success-triggered review dispatch.
 * Ignores review workflow check runs on both paths.
 * @param {string} owner
 * @param {string} repoName
 * @param {object} payload - GitHub webhook payload
 * @param {object} config - Fluent Flow config for this repo
 */
export async function handleCheckRun(owner, repoName, payload, config) {
  const { action, check_run: checkRun } = payload;
  if (action !== 'completed') return;
  if (isReviewCheckRun(checkRun)) return;

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
      const ciChecks = allChecks.filter((c) => !isReviewCheckRun(c));
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

  // Check if a review_fix claim was recently completed for this PR — if so, create test_verify
  let hasReviewFixClaim = false;
  let resolvedOrgId = null;
  try {
    resolvedOrgId = await resolveOrgId(owner, repoName);
    const { agentClaims } = schema;
    const rows = await db
      .select({ one: agentClaims.id })
      .from(agentClaims)
      .where(
        and(
          eq(agentClaims.orgId, resolvedOrgId),
          eq(agentClaims.repo, repoKey),
          eq(agentClaims.prNumber, pr.number),
          eq(agentClaims.claimType, 'review_fix'),
          eq(agentClaims.status, 'completed'),
        ),
      )
      .limit(1);
    hasReviewFixClaim = rows.length > 0;
  } catch (err) {
    // Safe to continue: checking for review_fix claims is best-effort —
    // if it fails, we skip the test_verify path and fall through to
    // a regular review dispatch.
    logger.warn({ msg: 'Failed to check for review_fix claims', error: err.message });
  }

  if (hasReviewFixClaim) {
    try {
      const testVerifyClaim = await createClaim({
        orgId: resolvedOrgId,
        repo: repoKey,
        prNumber: pr.number,
        attempt: 1, // Attempts are per claim type — test_verify starts at 1
        claimType: 'test_verify',
        payload: { branch: pr.head?.ref },
      });
      if (testVerifyClaim) {
        logger.info({ msg: 'Created test_verify claim after review_fix + CI pass', repo: repoKey, prNumber: pr.number });
        // Early return: test_verify agent will verify fixes, then runner route's
        // completion handler will trigger dispatchReview() via auto-chaining.
        return;
      }
      // createClaim returned null (duplicate) — fall through to dispatchReview
      logger.info({ msg: 'test_verify claim already exists, falling back to review dispatch', repo: repoKey, prNumber: pr.number });
    } catch (err) {
      // Safe to continue: test_verify creation failure falls back to
      // dispatching a regular review — no work is lost.
      logger.error({ msg: 'Failed to create test_verify claim, falling back to review', error: err.message });
    }
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
