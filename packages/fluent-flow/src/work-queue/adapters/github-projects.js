import { WorkQueueAdapter } from '../adapter.js';
import {
  createProjectItem,
  updateProjectItemState,
  queryProjectItems
} from '../../github/graphql.js';
import logger from '../../logger.js';

export class GitHubProjectsAdapter extends WorkQueueAdapter {
  constructor(config) {
    super(config);
    // config should have: projectNodeId, apiToken (or use GITHUB_TOKEN env)
  }

  async createTestFailureItem({
    owner,
    repo,
    issueNumber,
    prNumber,
    title,
    description,
    testFailures
  }) {
    const { passed, failed, failures } = testFailures;

    // Format failure details for project item body
    let body = `## Test Failures\n\n`;
    body += `PR: #${prNumber}\n`;
    body += `Passed: ${passed} | Failed: ${failed}\n\n`;
    
    if (failures && failures.length > 0) {
      body += `### Failed Tests\n`;
      failures.slice(0, 5).forEach((f) => {
        body += `- **${f.title}** (${f.file}:${f.line})\n`;
        body += `  ${f.message}\n`;
      });
      if (failures.length > 5) {
        body += `... and ${failures.length - 5} more\n`;
      }
    }

    body += `\n---\n*Action: Update PR #${prNumber} to fix failing tests.*`;

    try {
      const item = await createProjectItem({
        projectNodeId: this.config.projectNodeId,
        issueNumber,
        title: `Fix: ${title}`,
        description: body,
        state: 'Test Failures'
      });

      logger.info({ msg: 'Created test failure item in project', issueNumber, itemId: item.id });
      return item;
    } catch (err) {
      logger.error({ msg: 'Failed to create project item', error: err.message });
      throw err;
    }
  }

  async updateWorkItemState({ issueNumber, fromState, toState }) {
    try {
      await updateProjectItemState({
        projectNodeId: this.config.projectNodeId,
        issueNumber,
        fromState,
        toState
      });

      logger.info({ msg: 'Updated work item state', issueNumber, fromState, toState });
    } catch (err) {
      logger.error({ msg: 'Failed to update project item state', error: err.message });
      throw err;
    }
  }

  async getPendingWorkItems(agentId, opts = {}) {
    try {
      const items = await queryProjectItems({
        projectNodeId: this.config.projectNodeId,
        states: ['Test Failures', 'In Progress'],
        limit: 50
      });

      // Filter to items assigned to agent or unassigned
      return items.filter((item) => !item.assignee_id || item.assignee_id === agentId);
    } catch (err) {
      logger.error({ msg: 'Failed to query project items', error: err.message });
      return [];
    }
  }

  async acknowledgeWorkItem(issueNumber) {
    // GitHub Projects doesn't have explicit "acknowledge", so this is a no-op
    logger.info({ msg: 'Acknowledged work item', issueNumber });
  }
}
