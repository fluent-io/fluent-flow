import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTestFailure, handleTestSuccess } from '../../src/engine/test-manager.js';

vi.mock('../../src/work-queue/index.js', () => ({
  getAdapter: vi.fn()
}));

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn()
}));

vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn(),
  addLabel: vi.fn()
}));

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  audit: vi.fn()
}));

const { getAdapter } = await import('../../src/work-queue/index.js');
const { resolveConfig } = await import('../../src/config/loader.js');
const { getPRsForCommit } = await import('../../src/github/rest.js');
const { query, audit } = await import('../../src/db/client.js');

describe('Test Manager', () => {
  let mockAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = {
      createTestFailureItem: vi.fn().mockResolvedValue({ id: 'item_123', state: 'Test Failures' }),
      updateWorkItemState: vi.fn().mockResolvedValue(undefined)
    };
    getAdapter.mockReturnValue(mockAdapter);

    resolveConfig.mockResolvedValue({
      work_queue: { type: 'github-projects', projectNodeId: 'PVT_123' },
      default_agent: 'test-agent'
    });

    getPRsForCommit.mockResolvedValue([
      { number: 105, body: '', state: 'open' }
    ]);

    query.mockResolvedValue({ rows: [] });
  });

  describe('handleTestFailure', () => {
    it('creates work item for test failures using adapter', async () => {
      const testFailures = {
        passed: 5,
        failed: 2,
        failures: [
          { file: 'src/foo.test.js', line: 42, title: 'should work', message: 'Failed' }
        ]
      };

      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        checkName: 'tests',
        testFailures,
        issueNumber: 42
      });

      expect(getAdapter).toHaveBeenCalledWith('github-projects', { projectNodeId: 'PVT_123' });
      expect(mockAdapter.createTestFailureItem).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          prNumber: 105,
          testFailures
        })
      );
    });

    it('uses provided config instead of resolving', async () => {
      const config = { work_queue: { type: 'github-projects', projectNodeId: 'PVT_999' } };

      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        checkName: 'tests',
        testFailures: { passed: 1, failed: 0, failures: [] },
        issueNumber: 42,
        config
      });

      expect(getAdapter).toHaveBeenCalledWith('github-projects', { projectNodeId: 'PVT_999' });
    });

    it('handles no open PR gracefully', async () => {
      getPRsForCommit.mockResolvedValue([]);

      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        checkName: 'tests',
        testFailures: { passed: 1, failed: 1, failures: [] },
        issueNumber: 42
      });

      expect(mockAdapter.createTestFailureItem).not.toHaveBeenCalled();
    });

    it('handles PR fetch error gracefully', async () => {
      getPRsForCommit.mockRejectedValue(new Error('API error'));

      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        checkName: 'tests',
        testFailures: { passed: 1, failed: 1, failures: [] },
        issueNumber: 42
      });

      expect(mockAdapter.createTestFailureItem).not.toHaveBeenCalled();
    });

    it('records test failure in database', async () => {
      const testFailures = {
        passed: 5,
        failed: 2,
        failures: []
      };

      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123def456',
        checkName: 'tests',
        testFailures,
        issueNumber: 42
      });

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO test_failures'),
        expect.arrayContaining(['test-org/test-repo', 105, 'abc123def456'])
      );
    });

    it('audits test failure work item creation', async () => {
      await handleTestFailure({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        checkName: 'tests',
        testFailures: { passed: 5, failed: 2, failures: [] },
        issueNumber: 42
      });

      expect(audit).toHaveBeenCalledWith(
        'test_failure_work_item_created',
        expect.objectContaining({
          repo: 'test-org/test-repo'
        })
      );
    });
  });

  describe('handleTestSuccess', () => {
    it('updates work item state to Done', async () => {
      await handleTestSuccess({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        issueNumber: 42
      });

      expect(getAdapter).toHaveBeenCalledWith('github-projects', { projectNodeId: 'PVT_123' });
      expect(mockAdapter.updateWorkItemState).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          fromState: 'Test Failures',
          toState: 'Done'
        })
      );
    });

    it('uses provided config', async () => {
      const config = { work_queue: { type: 'github-projects', projectNodeId: 'PVT_777' } };

      await handleTestSuccess({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        issueNumber: 42,
        config
      });

      expect(getAdapter).toHaveBeenCalledWith('github-projects', { projectNodeId: 'PVT_777' });
    });

    it('audits test failure resolution', async () => {
      await handleTestSuccess({
        owner: 'test-org',
        repo: 'test-repo',
        sha: 'abc123',
        issueNumber: 42
      });

      expect(audit).toHaveBeenCalledWith(
        'test_failure_resolved',
        expect.objectContaining({
          repo: 'test-org/test-repo'
        })
      );
    });

    it('continues on update error (non-fatal)', async () => {
      mockAdapter.updateWorkItemState.mockRejectedValue(new Error('API error'));

      // Should not throw — adapter failures are non-fatal
      await expect(
        handleTestSuccess({
          owner: 'test-org',
          repo: 'test-repo',
          sha: 'abc123',
          issueNumber: 42
        })
      ).resolves.toBeUndefined();

      // Audit is only called on success, not on error
      expect(audit).not.toHaveBeenCalled();
    });
  });
});
