import { WorkQueueAdapter } from '../adapter.js';
import {
  moveProjectItem,
  findProjectItem,
  getProjectItemStatus,
} from '../../github/graphql.js';
import logger from '../../logger.js';

/**
 * Work queue adapter for GitHub Projects v2.
 * Uses existing graphql helpers to move issues between project states.
 */
export class GitHubProjectsAdapter extends WorkQueueAdapter {
  constructor(config) {
    super(config);
    // config should have: projectNodeId
  }

  /**
   * Create a test failure work item by moving an existing project issue
   * to the "Test Failures" state. The issue must already be in the project.
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
    const projectNodeId = this.config.projectNodeId;
    if (!projectNodeId) {
      throw new Error('GitHubProjectsAdapter: projectNodeId is required');
    }

    // Find the project item for this issue
    const itemNodeId = await findProjectItem(projectNodeId, owner, repo, issueNumber);
    if (!itemNodeId) {
      throw new Error(
        `No project item found for ${owner}/${repo}#${issueNumber} in project ${projectNodeId}`
      );
    }

    // Move to "Test Failures" state
    await moveProjectItem(projectNodeId, itemNodeId, 'Test Failures');

    logger.info({ msg: 'Created test failure item in project', issueNumber, itemNodeId });
    return { id: itemNodeId, state: 'Test Failures' };
  }

  /**
   * Update a work item state by finding and moving the project item.
   */
  async updateWorkItemState({ owner, repo, issueNumber, fromState, toState }) {
    const projectNodeId = this.config.projectNodeId;
    if (!projectNodeId) {
      throw new Error('GitHubProjectsAdapter: projectNodeId is required');
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
   * Get pending work items. Queries by scanning the project for items
   * in "Test Failures" state. Note: full project scanning requires
   * pagination via findProjectItem; this is intentionally limited to
   * fetching status of known items (full project query is a future enhancement).
   */
  async getPendingWorkItems(agentId, opts = {}) {
    // This is a placeholder — full project scanning requires additional
    // GraphQL helpers not yet in graphql.js. Returns empty for now.
    logger.info({ msg: 'getPendingWorkItems called (full scan not yet implemented)', agentId });
    return [];
  }

  /**
   * Acknowledge a work item (no-op for GitHub Projects).
   */
  async acknowledgeWorkItem(issueNumber) {
    logger.info({ msg: 'Acknowledged work item', issueNumber });
  }
}
