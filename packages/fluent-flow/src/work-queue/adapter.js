/**
 * Work Queue Adapter Interface
 * 
 * Implementations handle creating, updating, and querying work items
 * (issues in specific states) across different platforms.
 */

export class WorkQueueAdapter {
  constructor(config) {
    this.config = config;
  }

  /**
   * Create a work item for test failures.
   * @param {object} opts
   * @param {string} opts.owner - Repository owner
   * @param {string} opts.repo - Repository name
   * @param {number} opts.issueNumber - Linked GitHub issue number
   * @param {number} opts.prNumber - Pull request number
   * @param {string} opts.title - Work item title
   * @param {string} opts.description - Full description with failure details
   * @param {object} opts.testFailures - { passed, failed, failures: [] }
   * @returns {Promise<object>} Created work item with { id, state, url }
   */
  async createTestFailureItem(opts) {
    throw new Error('createTestFailureItem not implemented');
  }

  /**
   * Update a work item state.
   * @param {object} opts
   * @param {string} opts.issueNumber - Linked GitHub issue number
   * @param {string} opts.fromState - Current state
   * @param {string} opts.toState - Target state (e.g., 'Test Failures' → 'Done')
   * @returns {Promise<void>}
   */
  async updateWorkItemState(opts) {
    throw new Error('updateWorkItemState not implemented');
  }

  /**
   * Get pending work items for an agent.
   * @param {string} agentId
   * @param {object} opts - Agent context
   * @returns {Promise<Array>} Work items with { issueNumber, state, testFailures, ... }
   */
  async getPendingWorkItems(agentId, opts) {
    throw new Error('getPendingWorkItems not implemented');
  }

  /**
   * Acknowledge a work item (agent has seen it).
   * @param {number} issueNumber
   * @returns {Promise<void>}
   */
  async acknowledgeWorkItem(issueNumber) {
    throw new Error('acknowledgeWorkItem not implemented');
  }
}
