import { resolveConfig } from '../config/loader.js';
import { getAdapter } from '../work-queue/index.js';
import { getPRsForCommit } from '../github/rest.js';
import logger from '../logger.js';
import { query, audit } from '../db/client.js';

/**
 * Handle test failures by creating a work item in the configured queue.
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
  const repoKey = `${owner}/${repo}`;

  if (!config) {
    config = await resolveConfig(owner, repo);
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
  const { type: adapterType, ...adapterConfig } = config.work_queue ?? { type: 'github-projects', projectNodeId: config.project_id };
  const adapter = getAdapter(adapterType, adapterConfig);

  // Create work item
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

    // Track attempt
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
    throw err;
  }
}

/**
 * Handle test success — update work item state to Done.
 */
export async function handleTestSuccess({ owner, repo, sha, issueNumber, config }) {
  const repoKey = `${owner}/${repo}`;

  if (!config) {
    config = await resolveConfig(owner, repo);
  }

  const { type: adapterType, ...adapterConfig } = config.work_queue ?? { type: 'github-projects', projectNodeId: config.project_id };
  const adapter = getAdapter(adapterType, adapterConfig);

  audit('test_failure_resolved', { repo: repoKey, data: { issueNumber } });

  try {
    await adapter.updateWorkItemState({
      owner,
      repo,
      issueNumber,
      fromState: 'Test Failures',
      toState: 'Done'
    });

    logger.info({ msg: 'Updated test failure item to Done', repo: repoKey, issueNumber });
  } catch (err) {
    logger.warn({ msg: 'Failed to update test failure item state', error: err.message });
  }
}
