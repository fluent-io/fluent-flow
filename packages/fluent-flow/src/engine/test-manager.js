import { resolveConfig, installationCtxForRepo } from '../config/loader.js';
import { getAdapter } from '../work-queue/index.js';
import { getPRsForCommit } from '../providers/github/rest.js';
import logger from '../logger.js';
import { sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';

const { testFailures: testFailuresTable } = schema;

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
  config,
  ctx,
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
  let testCtx;
  try {
    testCtx = ctx ?? await installationCtxForRepo(owner, repo);
    const prs = await getPRsForCommit(owner, repo, sha, testCtx);
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
      testFailures,
      ctx: testCtx,
    });

    logger.info({ msg: 'Created test failure work item', repo: repoKey, issueNumber, itemId: workItem.id });
    audit('test_failure_work_item_created', { repo: repoKey, data: { issueNumber, itemId: workItem.id } });

    await db
      .insert(testFailuresTable)
      .values({
        repo: repoKey,
        prNumber: pr.number,
        sha,
        retryCount: 1,
        testOutput: testFailures,
        workItemId: workItem.id,
      })
      .onConflictDoUpdate({
        target: [testFailuresTable.repo, testFailuresTable.prNumber],
        set: {
          sha,
          retryCount: sql`${testFailuresTable.retryCount} + 1`,
          testOutput: testFailures,
          workItemId: workItem.id,
          updatedAt: sql`NOW()`,
        },
      })
      .returning();
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
export async function handleTestSuccess({ owner, repo, sha, issueNumber, config, ctx }) {
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

    const adapterCtx = ctx ?? await installationCtxForRepo(owner, repo);

    await adapter.updateWorkItemState({
      owner,
      repo,
      issueNumber,
      fromState: failureState,
      toState: resolvedState,
      ctx: adapterCtx,
    });

    // Audit only after successful update
    audit('test_failure_resolved', { repo: repoKey, data: { issueNumber } });
    logger.info({ msg: 'Updated test failure item to resolved', repo: repoKey, issueNumber, resolvedState });
  } catch (err) {
    logger.warn({ msg: 'Failed to update test failure item state', error: err.message });
    // Non-fatal: return without throwing
  }
}
