import { WorkQueueAdapter } from '../adapter.js';
import {
  moveProjectItem,
  findProjectItem,
} from '../../github/graphql.js';
import logger from '../../logger.js';

/** Default project state names — override via config.failure_state / config.resolved_state */
const DEFAULT_FAILURE_STATE = 'Test Failures';
const DEFAULT_RESOLVED_STATE = 'Done';

/**
 * Work queue adapter for GitHub Projects v2.
 * Uses existing graphql helpers to move issues between project states.
 *
 * Config options (all snake_case, per project conventions):
 *   project_node_id  {string}  Required. GitHub Project node ID (PVT_xxx)
 *   failure_state    {string}  Optional. Column for test failures (default: "Test Failures")
 *   resolved_state   {string}  Optional. Column for resolved items (default: "Done")
 *
 * Legacy camelCase aliases are also accepted for backward compat:
 *   projectNodeId, failureState, resolvedState
 */
export class GitHubProjectsAdapter extends WorkQueueAdapter {
  constructor(config) {
    super(config);
  }

  get projectNodeId() {
    return this.config.project_node_id ?? this.config.projectNodeId;
  }

  get failureState() {
    return this.config.failure_state ?? this.config.failureState ?? DEFAULT_FAILURE_STATE;
  }

  get resolvedState() {
    return this.config.resolved_state ?? this.config.resolvedState ?? DEFAULT_RESOLVED_STATE;
  }

  /**
   * Create a test failure work item by moving an existing project issue
   * to the configured failure state. The issue must already be in the project.
   */
  async createTestFailureItem({
    owner,
    repo,
    issueNumber,
    prNumber,
    title,
    description,
    testFailures,
  }) {
    const projectNodeId = this.projectNodeId;
    if (!projectNodeId) {
      throw new Error('GitHubProjectsAdapter: project_node_id is required');
    }

    const itemNodeId = await findProjectItem(projectNodeId, owner, repo, issueNumber);
    if (!itemNodeId) {
      throw new Error(
        `No project item found for ${owner}/${repo}#${issueNumber} in project ${projectNodeId}`
      );
    }

    await moveProjectItem(projectNodeId, itemNodeId, this.failureState);

    logger.info({ msg: 'Created test failure item in project', issueNumber, itemNodeId, state: this.failureState });
    return { id: itemNodeId, state: this.failureState };
  }

  /**
   * Update a work item state by finding and moving the project item.
   */
  async updateWorkItemState({ owner, repo, issueNumber, fromState, toState }) {
    const projectNodeId = this.projectNodeId;
    if (!projectNodeId) {
      throw new Error('GitHubProjectsAdapter: project_node_id is required');
    }

    const itemNodeId = await findProjectItem(projectNodeId, owner, repo, issueNumber);
    if (!itemNodeId) {
      logger.warn({ msg: 'No project item found to update state', issueNumber, fromState, toState });
      return;
    }

    await moveProjectItem(projectNodeId, itemNodeId, toState);
    logger.info({ msg: 'Updated work item state', issueNumber, fromState, toState });
  }

  /**
   * Get pending work items.
   * Full project scanning requires additional GraphQL helpers not yet implemented.
   * Throws to signal callers not to depend on this method until implemented.
   */
  async getPendingWorkItems(agentId, opts = {}) {
    throw new Error(
      'GitHubProjectsAdapter.getPendingWorkItems() is not yet implemented. ' +
      'Use MCP get_pending_actions to poll for work.'
    );
  }

  /**
   * Acknowledge a work item (no-op for GitHub Projects).
   */
  async acknowledgeWorkItem(issueNumber) {
    logger.info({ msg: 'Acknowledged work item', issueNumber });
  }
}
