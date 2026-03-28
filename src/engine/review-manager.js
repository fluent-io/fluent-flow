import { query, audit } from '../db/client.js';
import { resolveConfig } from '../config/loader.js';
import { dispatchWorkflow, addLabel, getReviews, dismissReview } from '../github/rest.js';
import { enablePullRequestAutoMerge, getPRNodeId } from '../github/graphql.js';
import { recordPause, getActivePause } from './pause-manager.js';
import { notifyReviewFailure, formatRichMessage } from '../notifications/dispatcher.js';
import { createClaim, completeClaim } from '../agents/claim-manager.js';
import logger from '../logger.js';

/**
 * Dispatch the pr-review GitHub Actions workflow for a repository.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {string} [opts.ref='main'] - Branch to dispatch workflow on
 * @param {number} [opts.attempt=1]
 * @param {Array} [opts.priorIssues=[]]
 * @returns {Promise<void>}
 */
export async function dispatchReview({ owner, repo, prNumber, ref = 'main', attempt = 1, priorIssues = [], issueNumber }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);

  if (!config.reviewer?.enabled) {
    logger.info({ msg: 'Reviewer disabled for repo', repo: repoKey });
    return;
  }

  if (issueNumber) {
    const activePause = await getActivePause(repoKey, issueNumber);
    if (activePause) {
      logger.info({ msg: 'Skipping review dispatch — issue is paused', repo: repoKey, prNumber, issueNumber, pauseId: activePause.id });
      return;
    }
  }

  // Dismiss prior Fluent Flow reviews before dispatching new one
  try {
    const reviews = await getReviews(owner, repo, prNumber);
    const staleReviews = reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED' && /<!--\s*reviewer-result:/.test(r.body)
    );
    for (const review of staleReviews) {
      try {
        await dismissReview(owner, repo, prNumber, review.id, 'Superseded by new review');
        logger.info({ msg: 'Dismissed stale review', repo: repoKey, prNumber, reviewId: review.id });
      } catch (err) {
        logger.warn({ msg: 'Failed to dismiss stale review', repo: repoKey, prNumber, reviewId: review.id, error: err.message });
      }
    }
  } catch (err) {
    logger.warn({ msg: 'Failed to fetch reviews for dismiss', repo: repoKey, prNumber, error: err.message });
  }

  await dispatchWorkflow(owner, repo, 'pr-review.yml', ref, {
    pr_number: String(prNumber),
    attempt: String(attempt),
    prior_issues: JSON.stringify(priorIssues),
  });

  logger.info({ msg: 'Dispatched pr-review workflow', repo: repoKey, prNumber, attempt });
  audit('review_dispatched', { repo: repoKey, data: { prNumber, attempt } });
}

/**
 * Handle an incoming review result (posted by the GitHub Actions workflow).
 *
 * Parses the result and:
 * - PASS: enables auto-merge
 * - FAIL: increments retry counter, notifies agent
 * - FAIL + max retries exceeded: adds needs-human label → triggers pause
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.issueNumber - Associated issue number (for pause)
 * @param {object} opts.result - { status, blocking[], advisory[], attempt, summary }
 * @param {string} [opts.reviewSha] - Commit SHA the review was for
 * @returns {Promise<{ action: 'pass'|'fail'|'escalate' }>}
 */
export async function handleReviewResult({ owner, repo, prNumber, issueNumber, result, reviewSha, agentId }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const maxRetries = config.reviewer?.max_retries ?? 3;

  const { status, blocking = [], advisory = [], attempt = 1 } = result;

  if (status === 'PASS') {
    // Enable auto-merge via GraphQL
    try {
      const prNodeId = await getPRNodeId(owner, repo, prNumber);
      if (prNodeId) {
        await enablePullRequestAutoMerge(prNodeId, 'SQUASH');
        logger.info({ msg: 'Enabled auto-merge after PASS', repo: repoKey, prNumber });
      audit('review_result_pass', { repo: repoKey, data: { prNumber, attempt } });
      }
    } catch (err) {
      logger.error({ msg: 'Failed to enable auto-merge', repo: repoKey, prNumber, error: err.message });
    }

    // Update retry record to reflect pass
    await query(
      `UPDATE review_retries SET last_review_sha = $1, updated_at = NOW()
       WHERE repo = $2 AND pr_number = $3`,
      [reviewSha ?? null, repoKey, prNumber]
    );

    // Complete any active claim for this PR
    try {
      await completeClaim(config.org_id ?? 'self-hosted', repoKey, prNumber, attempt);
    } catch (err) {
      logger.error({ msg: 'Failed to complete claim on pass', error: err.message, repo: repoKey, prNumber });
    }

    return { action: 'pass' };
  }

  // FAIL: increment retry count
  const allIssues = [
    ...blocking.map((b) => ({ ...b, severity: 'blocking' })),
    ...advisory.map((a) => ({ ...a, severity: 'advisory' })),
  ];

  const retryResult = await query(
    `INSERT INTO review_retries (repo, pr_number, retry_count, last_issues, last_review_sha)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (repo, pr_number) DO UPDATE
       SET retry_count = review_retries.retry_count + 1,
           last_issues = $3,
           last_review_sha = $4,
           updated_at = NOW()
     RETURNING *`,
    [repoKey, prNumber, JSON.stringify(allIssues), reviewSha ?? null]
  );
  const retryRecord = retryResult.rows[0];
  const newRetryCount = retryRecord.retry_count;

  logger.info({ msg: 'Review failed', repo: repoKey, prNumber, attempt, retryCount: newRetryCount, maxRetries });

  // Notify the agent that created the PR
  const resolvedAgent = agentId ?? config.default_agent ?? config.agent_id;
  if (resolvedAgent) {
    await notifyReviewFailure({
      agentId: resolvedAgent,
      repo: repoKey,
      prNumber,
      attempt,
      issues: allIssues,
      onFailure: config.reviewer?.on_failure,
      delivery: config.delivery ?? {},
    });

    // Create a claim for this review attempt
    try {
      await createClaim({
        orgId: config.org_id ?? 'self-hosted',
        repo: repoKey,
        prNumber,
        attempt,
        agentId: resolvedAgent,
        payload: {
          message: formatRichMessage({ repo: repoKey, prNumber, attempt, blocking, advisory }),
          issues: allIssues,
          onFailure: config.reviewer?.on_failure,
        },
      });
    } catch (err) {
      logger.warn({ msg: 'Failed to create claim on review failure', error: err.message });
    }
  }

  // Check if we've hit max retries
  if (newRetryCount >= maxRetries) {
    logger.info({ msg: 'Max review retries reached — escalating', repo: repoKey, prNumber, retryCount: newRetryCount });
    audit('review_escalated', { repo: repoKey, data: { prNumber, attempt, blockingCount: blocking.length } });

    // Reset retry counter so future pushes start a fresh review cycle
    await resetRetries(repoKey, prNumber);

    // Add needs-human label to trigger pause
    try {
      if (issueNumber) {
        await addLabel(owner, repo, issueNumber, 'needs-human');
      }
    } catch (err) {
      logger.error({ msg: 'Failed to add needs-human label on escalation', error: err.message });
    }

    // Record a pause for the escalation
    if (issueNumber) {
      try {
        await recordPause({
          owner,
          repo,
          issueNumber,
          prNumber,
          reason: 'review-escalation',
          context: `Automated review failed ${newRetryCount} times. Blocking issues:\n${blocking.map((b) => `- ${b.file}:${b.line} — ${b.issue}`).join('\n')}`,
          actor: 'fluent-flow',
          agentId: resolvedAgent,
        });
      } catch (err) {
        logger.error({ msg: 'Failed to record escalation pause', error: err.message });
      }
    }

    return { action: 'escalate' };
  }

  // Do NOT re-dispatch here — wait for the agent to push new commits.
  // The check_run.completed handler will dispatch a fresh review with last_issues
  // as prior context when CI passes after the agent pushes new commits.
  logger.info({ msg: 'Review failed — waiting for agent to push fixes', repo: repoKey, prNumber, retryCount: newRetryCount });
  audit('review_result_fail', { repo: repoKey, data: { prNumber, attempt, retryCount: newRetryCount } });

  return { action: 'fail' };
}

/**
 * Get the retry record for a PR.
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @returns {Promise<object|null>}
 */
export async function getRetryRecord(repo, prNumber) {
  const result = await query(
    'SELECT * FROM review_retries WHERE repo = $1 AND pr_number = $2',
    [repo, prNumber]
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically claim a dispatch slot for a SHA. Returns the retry record if
 * the claim succeeds (new SHA or first dispatch), or null if the SHA was
 * already dispatched or max retries reached.
 *
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @param {string} sha - Commit SHA to claim
 * @param {number} maxRetries
 * @returns {Promise<object|null>}
 */
export async function claimDispatch(repo, prNumber, sha, maxRetries) {
  const result = await query(
    `INSERT INTO review_retries (repo, pr_number, last_dispatch_sha)
     VALUES ($1, $2, $3)
     ON CONFLICT (repo, pr_number) DO UPDATE
       SET last_dispatch_sha = $3, updated_at = NOW()
       WHERE review_retries.last_dispatch_sha IS DISTINCT FROM $3
         AND review_retries.retry_count < $4
     RETURNING *`,
    [repo, prNumber, sha, maxRetries]
  );
  return result.rows[0] ?? null;
}

/**
 * Reset the retry counter for a PR (e.g. after a new commit is pushed).
 * @param {string} repo
 * @param {number} prNumber
 */
export async function resetRetries(repo, prNumber) {
  await query(
    `UPDATE review_retries SET retry_count = 0, last_issues = NULL, last_dispatch_sha = NULL, updated_at = NOW()
     WHERE repo = $1 AND pr_number = $2`,
    [repo, prNumber]
  );
}

