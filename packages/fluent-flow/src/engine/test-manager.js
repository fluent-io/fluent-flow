import { resolveConfig } from '../config/loader.js';
import { getAdapter } from '../work-queue/index.js';
import { getPRsForCommit } from '../github/rest.js';
import logger from '../logger.js';
import { query, audit } from '../db/client.js';

/**
 * Resolve work queue adapter config with sensible defaults.
 * Falls back to project_id (or project_ids[0]) for project_node_id.
 */
function resolveAdapterConfig(config) {
  if (config.work_queue) {
    const adapterConfig = { ...config.work_queue };
    // Default project_node_id from project_id if not set
    if (!adapterConfig.project_node_id && !adapterConfig.projectNodeId) {
      adapterConfig.project_node_id = config.project_id ?? config.project_ids?.[0];
    }
    return adapterConfig;
  }
  return {
    type: 'github-projects',
    project_node_id: config.project_id ?? config.project_ids?.[0],
  };
}

/**
 * Handle test failures by creating a work item in the configured queue.
 *
 * This is called from check-run-handler when a test check run fails.
 * Adapter failures are non-fatal — logged and audited but do not fail the webhook.
 */
export async function handleTestFailure({
  owner,
  repo,
  sha,
  checkName,
  testFailures,
  issueNumber,
  config
}) {
  // Input validation
  if (!owner || !repo) throw new Error('handleTestFailure: owner and repo are required');
  if (!sha) throw new Error('handleTestFailure: sha is required');
  if (!testFailures || typeof testFailures !== 'object') throw new Error('handleTestFailure: testFailures is required');

  const repoKey = `${owner}/${repo}`;

  if (!config) {
    config = await resolveConfig(owner, repo);
  }

  // issueNumber can legitimately be null for unlinked PRs — skip adapter call
  if (!issueNumber) {
    logger.info({ msg: 'Test failure has no linked issue, skipping work item creation', repo: repoKey, sha });
    return;
  }

  // Find linked PR
  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repo, sha);
    if (prs && prs.length > 0) pr = prs[0];
  } catch (err) {
    logger.warn({ msg: 'Failed to find linked PR for test failure', repo: repoKey, error: err.message });
    return;
  }

  if (!pr || pr.state !== 'open') {
    logger.info({ msg: 'No open PR for test failure', repo: repoKey });
    return;
  }

  // Get work queue adapter
  const adapterConfig = resolveAdapterConfig(config);
  const { type: adapterType, ...adapterOpts } = adapterConfig;
  const adapter = getAdapter(adapterType, adapterOpts);

  // Create work item — non-fatal: adapter failures (missing project item, GitHub API errors)
  // should not fail the entire webhook request
  try {
    const workItem = await adapter.createTestFailureItem({
      owner,
      repo,
      issueNumber,
      prNumber: pr.number,
      title: `Tests failed in ${checkName}`,
      description: `${testFailures.failed} test(s) failed, ${testFailures.passed} passed.`,
      testFailures
    });

    logger.info({ msg: 'Created test failure work item', repo: repoKey, issueNumber, itemId: workItem.id });
    audit('test_failure_work_item_created', { repo: repoKey, data: { issueNumber, itemId: workItem.id } });

    // Track attempt in DB
    await query(
      `INSERT INTO test_failures (repo, pr_number, sha, retry_count, test_output, work_item_id)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (repo, pr_number) DO UPDATE
         SET sha = $3,
             retry_count = test_failures.retry_count + 1,
             test_output = $4,
             work_item_id = $5,
             updated_at = NOW()
       RETURNING *`,
      [repoKey, pr.number, sha, JSON.stringify(testFailures), workItem.id]
    );
  } catch (err) {
    logger.error({ msg: 'Failed to create test failure work item', repo: repoKey, error: err.message });
    audit('test_failure_work_item_failed', { repo: repoKey, data: { issueNumber, error: err.message } });
    // Non-fatal: return without throwing so webhook processing continues
  }
}

/**
 * Handle test success — update work item state to resolved.
 * Called from check-run-handler when a test check run succeeds.
 * Adapter failures are non-fatal.
 */
export async function handleTestSuccess({ owner, repo, sha, issueNumber, config }) {
  const repoKey = `${owner}/${repo}`;

  if (!issueNumber) {
    logger.info({ msg: 'Test success has no linked issue, skipping work item update', repo: repoKey });
    return;
  }

  if (!config) {
    config = await resolveConfig(owner, repo);
  }

  const adapterConfig = resolveAdapterConfig(config);
  const { type: adapterType, ...adapterOpts } = adapterConfig;
  const adapter = getAdapter(adapterType, adapterOpts);

  try {
    const failureState = adapterOpts.failure_state ?? adapterOpts.failureState ?? 'Test Failures';
    const resolvedState = adapterOpts.resolved_state ?? adapterOpts.resolvedState ?? 'Done';

    await adapter.updateWorkItemState({
      owner,
      repo,
      issueNumber,
      fromState: failureState,
      toState: resolvedState
    });

    // Audit only after successful update
    audit('test_failure_resolved', { repo: repoKey, data: { issueNumber } });
    logger.info({ msg: 'Updated test failure item to resolved', repo: repoKey, issueNumber, resolvedState });
  } catch (err) {
    logger.warn({ msg: 'Failed to update test failure item state', error: err.message });
    // Non-fatal: return without throwing
  }
}
