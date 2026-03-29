import { resolveAgentId, dispatch } from '../notifications/dispatcher.js';
import { getPRsForCommit, getCheckRunsForCommit } from './rest.js';
import { dispatchReview, claimDispatch } from '../engine/review-manager.js';
import { getActivePause } from '../engine/pause-manager.js';
import { audit } from '../db/client.js';
import logger from '../logger.js';

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

  if (checkRun.conclusion === 'failure') {
    await handleCheckRunFailure(owner, repoName, checkRun, config);
    return;
  }

  if (checkRun.conclusion === 'success' || checkRun.conclusion === 'neutral') {
    await handleCheckRunSuccess(owner, repoName, checkRun, config);
  }
}

/**
 * Handle CI failure — notify the configured agent.
 */
async function handleCheckRunFailure(owner, repoName, checkRun, config) {
  let prNumber = null;
  let prTitle = '';
  let prBody;

  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha);
    if (prs && prs.length > 0) {
      prNumber = prs[0].number;
      prTitle = prs[0].title;
      prBody = prs[0].body;
    }
  } catch (err) {
    logger.warn({ msg: 'Failed to fetch linked PRs for CI failure', repo: `${owner}/${repoName}`, sha: checkRun.head_sha, error: err.message });
  }

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
async function handleCheckRunSuccess(owner, repoName, checkRun, config) {
  if (!config.reviewer?.enabled) return;

  const triggerCheck = config.reviewer?.trigger_check;
  const repoKey = `${owner}/${repoName}`;

  if (triggerCheck) {
    // Use startsWith to handle matrix jobs (e.g. "test (20)" matches "test")
    if (!checkRun.name.startsWith(triggerCheck)) return;
  } else {
    try {
      const allChecks = await getCheckRunsForCommit(owner, repoName, checkRun.head_sha);
      const ciChecks = allChecks.filter((c) => !isReviewCheckRun(c));
      const allPassed = ciChecks.every(
        (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'neutral')
      );
      if (!allPassed) {
        logger.info({ msg: 'Not all checks passed yet, waiting', repo: repoKey, sha: checkRun.head_sha });
        return;
      }
    } catch (err) {
      logger.error({ msg: 'Failed to query check runs for fallback', repo: repoKey, error: err.message });
      return;
    }
  }

  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha);
    if (prs && prs.length > 0) pr = prs[0];
  } catch (err) {
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

  try {
    await dispatchReview({
      owner, repo: repoName, prNumber: pr.number,
      ref: pr.base?.ref ?? 'main', attempt, priorIssues, issueNumber,
    });
    logger.info({ msg: 'Review dispatched after CI pass', repo: repoKey, prNumber: pr.number, attempt, trigger: triggerCheck ?? 'all-checks' });
  } catch (err) {
    logger.error({ msg: 'Failed to dispatch review after CI pass', repo: repoKey, prNumber: pr.number, error: err.message });
  }
}
