import { query, audit } from '../db/client.js';
import { resolveConfig } from '../config/loader.js';
import { dispatchWorkflow, addLabel } from '../github/rest.js';
import { enablePullRequestAutoMerge, getPRNodeId } from '../github/graphql.js';
import { recordPause } from './pause-manager.js';
import { notifyReviewFailure } from '../notifications/dispatcher.js';

/**
 * Get or create a review_retries record for a PR.
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @returns {Promise<object>}
 */
async function getOrCreateRetryRecord(repo, prNumber) {
  const result = await query(
    `INSERT INTO review_retries (repo, pr_number)
     VALUES ($1, $2)
     ON CONFLICT (repo, pr_number) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [repo, prNumber]
  );
  return result.rows[0];
}

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
export async function dispatchReview({ owner, repo, prNumber, ref = 'main', attempt = 1, priorIssues = [] }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);

  if (!config.reviewer?.enabled) {
    console.log({ msg: 'Reviewer disabled for repo', repo: repoKey });
    return;
  }

  await dispatchWorkflow(owner, repo, 'pr-review.yml', ref, {
    pr_number: String(prNumber),
    attempt: String(attempt),
    prior_issues: JSON.stringify(priorIssues),
  });

  console.log({ msg: 'Dispatched pr-review workflow', repo: repoKey, prNumber, attempt });
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
        console.log({ msg: 'Enabled auto-merge after PASS', repo: repoKey, prNumber });
      audit('review_result_pass', { repo: repoKey, data: { prNumber, attempt } });
      }
    } catch (err) {
      console.error({ msg: 'Failed to enable auto-merge', repo: repoKey, prNumber, error: err.message });
    }

    // Update retry record to reflect pass
    await query(
      `UPDATE review_retries SET last_review_sha = $1, updated_at = NOW()
       WHERE repo = $2 AND pr_number = $3`,
      [reviewSha ?? null, repoKey, prNumber]
    );

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

  console.log({ msg: 'Review failed', repo: repoKey, prNumber, attempt, retryCount: newRetryCount, maxRetries });

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
  }

  // Check if we've hit max retries
  if (newRetryCount >= maxRetries) {
    console.log({ msg: 'Max review retries reached — escalating', repo: repoKey, prNumber, retryCount: newRetryCount });
    audit('review_escalated', { repo: repoKey, data: { prNumber, attempt, blockingCount: blocking.length } });

    // Reset retry counter so future pushes start a fresh review cycle
    await resetRetries(repoKey, prNumber);

    // Add needs-human label to trigger pause
    try {
      if (issueNumber) {
        await addLabel(owner, repo, issueNumber, 'needs-human');
      }
    } catch (err) {
      console.error({ msg: 'Failed to add needs-human label on escalation', error: err.message });
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
        console.error({ msg: 'Failed to record escalation pause', error: err.message });
      }
    }

    return { action: 'escalate' };
  }

  // Do NOT re-dispatch here — wait for the agent to push new commits.
  // The pull_request.synchronize handler will dispatch a fresh review
  // with last_issues as prior context when new commits arrive.
  console.log({ msg: 'Review failed — waiting for agent to push fixes', repo: repoKey, prNumber, retryCount: newRetryCount });
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
 * Reset the retry counter for a PR (e.g. after a new commit is pushed).
 * @param {string} repo
 * @param {number} prNumber
 */
export async function resetRetries(repo, prNumber) {
  await query(
    `UPDATE review_retries SET retry_count = 0, last_issues = NULL, updated_at = NOW()
     WHERE repo = $1 AND pr_number = $2`,
    [repo, prNumber]
  );
}

