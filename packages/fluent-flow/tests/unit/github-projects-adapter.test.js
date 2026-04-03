import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProjectsAdapter } from '../../src/work-queue/adapters/github-projects.js';

vi.mock('../../src/github/graphql.js', () => ({
  moveProjectItem: vi.fn(),
  findProjectItem: vi.fn(),
  getProjectItemStatus: vi.fn(),
}));

const { moveProjectItem, findProjectItem } = await import('../../src/github/graphql.js');

describe('GitHubProjectsAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new GitHubProjectsAdapter({ projectNodeId: 'PVT_123' });
    vi.clearAllMocks();
  });

  describe('createTestFailureItem', () => {
    it('finds project item and moves to Test Failures state', async () => {
      findProjectItem.mockResolvedValue('item_node_123');
      moveProjectItem.mockResolvedValue(undefined);

      const result = await adapter.createTestFailureItem({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        prNumber: 105,
        title: 'Tests failed',
        description: 'Failures...',
        testFailures: { passed: 5, failed: 2, failures: [] },
      });

      expect(findProjectItem).toHaveBeenCalledWith('PVT_123', 'test-org', 'test-repo', 42);
      expect(moveProjectItem).toHaveBeenCalledWith('PVT_123', 'item_node_123', 'Test Failures');
      expect(result).toEqual({ id: 'item_node_123', state: 'Test Failures' });
    });

    it('throws if project item not found', async () => {
      findProjectItem.mockResolvedValue(null);

      await expect(
        adapter.createTestFailureItem({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 99,
          prNumber: 1,
          title: 'fail',
          description: '',
          testFailures: { passed: 0, failed: 1, failures: [] },
        })
      ).rejects.toThrow('No project item found');
    });

    it('throws if projectNodeId not configured', async () => {
      const unconfigured = new GitHubProjectsAdapter({});
      await expect(
        unconfigured.createTestFailureItem({
          owner: 'o', repo: 'r', issueNumber: 1, prNumber: 1,
          title: 'fail', description: '', testFailures: { passed: 0, failed: 1, failures: [] },
        })
      ).rejects.toThrow('projectNodeId is required');
    });

    it('uses custom failureState from config', async () => {
      const customAdapter = new GitHubProjectsAdapter({ projectNodeId: 'PVT_123', failureState: 'Blocked' });
      findProjectItem.mockResolvedValue('item_node_789');
      moveProjectItem.mockResolvedValue(undefined);

      const result = await customAdapter.createTestFailureItem({
        owner: 'test-org', repo: 'test-repo', issueNumber: 10, prNumber: 20,
        title: 'fail', description: '', testFailures: { passed: 0, failed: 1, failures: [] },
      });

      expect(moveProjectItem).toHaveBeenCalledWith('PVT_123', 'item_node_789', 'Blocked');
      expect(result.state).toBe('Blocked');
    });
  });

  describe('updateWorkItemState', () => {
    it('finds and moves item to target state', async () => {
      findProjectItem.mockResolvedValue('item_node_456');
      moveProjectItem.mockResolvedValue(undefined);

      await adapter.updateWorkItemState({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        fromState: 'Test Failures',
        toState: 'Done',
      });

      expect(findProjectItem).toHaveBeenCalledWith('PVT_123', 'test-org', 'test-repo', 42);
      expect(moveProjectItem).toHaveBeenCalledWith('PVT_123', 'item_node_456', 'Done');
    });

    it('warns and returns if item not found (no throw)', async () => {
      findProjectItem.mockResolvedValue(null);

      // Should not throw
      await adapter.updateWorkItemState({
        owner: 'test-org', repo: 'test-repo', issueNumber: 99,
        fromState: 'Test Failures', toState: 'Done',
      });

      expect(moveProjectItem).not.toHaveBeenCalled();
    });
  });

  describe('getPendingWorkItems', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.getPendingWorkItems('agent-id', {})).rejects.toThrow('not yet implemented');
    });
  });

  describe('acknowledgeWorkItem', () => {
    it('is a no-op (returns without error)', async () => {
      await expect(adapter.acknowledgeWorkItem(42)).resolves.toBeUndefined();
    });
  });
});
