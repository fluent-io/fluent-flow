import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProjectsAdapter } from '../../src/work-queue/adapters/github-projects.js';

// Mock the GitHub GraphQL helper module before importing the adapter
vi.mock('../../src/github/graphql.js', () => ({
  createProjectItem: vi.fn(),
  updateProjectItemState: vi.fn(),
  queryProjectItems: vi.fn()
}));

const { createProjectItem, updateProjectItemState, queryProjectItems } = 
  await import('../../src/github/graphql.js');

describe('GitHubProjectsAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new GitHubProjectsAdapter({
      projectNodeId: 'PVT_123',
      apiToken: 'test-token'
    });
    vi.clearAllMocks();
  });

  describe('createTestFailureItem', () => {
    it('creates test failure item in GitHub Project', async () => {
      createProjectItem.mockResolvedValue({ id: 'item_123', state: 'Test Failures' });

      const result = await adapter.createTestFailureItem({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        prNumber: 105,
        title: 'Tests failed',
        description: 'Test failures occurred',
        testFailures: { passed: 5, failed: 2, failures: [] }
      });

      expect(result).toEqual({ id: 'item_123', state: 'Test Failures' });
      expect(createProjectItem).toHaveBeenCalledWith(
        expect.objectContaining({
          projectNodeId: 'PVT_123'
        })
      );
    });

    it('formats failure details in description', async () => {
      createProjectItem.mockResolvedValue({ id: 'item_456', state: 'Test Failures' });

      const testFailures = {
        passed: 3,
        failed: 2,
        failures: [
          { title: 'should validate', file: 'src/test.js', line: 42, message: 'Expected true' },
          { title: 'should render', file: 'src/render.test.js', line: 89, message: 'Timeout' }
        ]
      };

      await adapter.createTestFailureItem({
        owner: 'org',
        repo: 'repo',
        issueNumber: 10,
        prNumber: 20,
        title: 'Tests failed',
        description: 'Failures',
        testFailures
      });

      const call = createProjectItem.mock.calls[0][0];
      expect(call.description).toContain('Test Failures');
      expect(call.description).toContain('Passed: 3 | Failed: 2');
      expect(call.description).toContain('should validate');
      expect(call.description).toContain('should render');
    });
  });

  describe('updateWorkItemState', () => {
    it('updates item state from Test Failures to Done', async () => {
      updateProjectItemState.mockResolvedValue(undefined);

      await adapter.updateWorkItemState({
        issueNumber: 42,
        fromState: 'Test Failures',
        toState: 'Done'
      });

      expect(updateProjectItemState).toHaveBeenCalledWith(
        expect.objectContaining({
          projectNodeId: 'PVT_123',
          issueNumber: 42,
          fromState: 'Test Failures',
          toState: 'Done'
        })
      );
    });
  });

  describe('getPendingWorkItems', () => {
    it('queries pending test failure items', async () => {
      queryProjectItems.mockResolvedValue([
        {
          issue_number: 42,
          state: 'Test Failures',
          pr_number: 105,
          test_failures: { failed: 2, passed: 5 },
          assignee_id: null
        }
      ]);

      const items = await adapter.getPendingWorkItems('agent-id', {});

      expect(items).toHaveLength(1);
      expect(items[0].state).toBe('Test Failures');
      expect(queryProjectItems).toHaveBeenCalledWith(
        expect.objectContaining({
          projectNodeId: 'PVT_123',
          states: ['Test Failures', 'In Progress']
        })
      );
    });

    it('filters items by agent assignment', async () => {
      queryProjectItems.mockResolvedValue([
        { issue_number: 1, assignee_id: 'agent-a' },
        { issue_number: 2, assignee_id: 'agent-b' },
        { issue_number: 3, assignee_id: null }
      ]);

      const items = await adapter.getPendingWorkItems('agent-a', {});

      // Should only return items assigned to agent-a or unassigned
      expect(items).toHaveLength(2);
      expect(items.map(i => i.issue_number)).toEqual([1, 3]);
    });

    it('returns empty array on query error', async () => {
      queryProjectItems.mockRejectedValue(new Error('API error'));

      const items = await adapter.getPendingWorkItems('agent-id', {});

      expect(items).toEqual([]);
    });
  });

  describe('acknowledgeWorkItem', () => {
    it('acknowledges work item', async () => {
      await adapter.acknowledgeWorkItem(42);
      // GitHub Projects doesn't need explicit acknowledgment
      // This is just a no-op for compatibility
    });
  });
});
