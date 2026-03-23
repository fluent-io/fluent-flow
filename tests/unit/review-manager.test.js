import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY, makeRetryRecord,
} from '../helpers/mocks.js';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn() }));
vi.mock('../../src/github/rest.js', () => ({
  dispatchWorkflow: vi.fn(),
  addLabel: vi.fn(),
}));
vi.mock('../../src/github/graphql.js', () => ({
  enablePullRequestAutoMerge: vi.fn(),
  getPRNodeId: vi.fn(),
}));
vi.mock('../../src/engine/pause-manager.js', () => ({ recordPause: vi.fn(), getActivePause: vi.fn() }));
vi.mock('../../src/notifications/dispatcher.js', () => ({ notifyReviewFailure: vi.fn() }));

import { query } from '../../src/db/client.js';
import { resolveConfig } from '../../src/config/loader.js';
import { dispatchWorkflow, addLabel } from '../../src/github/rest.js';
import { enablePullRequestAutoMerge, getPRNodeId } from '../../src/github/graphql.js';
import { recordPause, getActivePause } from '../../src/engine/pause-manager.js';
import { notifyReviewFailure } from '../../src/notifications/dispatcher.js';
import { dispatchReview, handleReviewResult, getRetryRecord } from '../../src/engine/review-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfig.mockResolvedValue(buildConfig());
});

describe('dispatchReview', () => {
  it('dispatches pr-review.yml workflow with correct inputs', async () => {
    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7, ref: 'main' });

    expect(dispatchWorkflow).toHaveBeenCalledWith(
      TEST_OWNER, TEST_REPO, 'pr-review.yml', 'main',
      { pr_number: '7', attempt: '1', prior_issues: '[]' },
    );
  });

  it('passes attempt and prior issues to workflow', async () => {
    const priorIssues = [{ file: 'x.js', issue: 'bug' }];
    await dispatchReview({
      owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7,
      attempt: 3, priorIssues,
    });

    expect(dispatchWorkflow).toHaveBeenCalledWith(
      TEST_OWNER, TEST_REPO, 'pr-review.yml', 'main',
      expect.objectContaining({ attempt: '3', prior_issues: JSON.stringify(priorIssues) }),
    );
  });

  it('skips dispatch when reviewer is disabled', async () => {
    resolveConfig.mockResolvedValue(buildConfig({ reviewer: { enabled: false } }));

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7 });

    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('skips dispatch when linked issue has an active pause', async () => {
    getActivePause.mockResolvedValue({ id: 1, reason: 'agent-stuck' });

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7, issueNumber: 42 });

    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('dispatches when no active pause exists for issue', async () => {
    getActivePause.mockResolvedValue(null);

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7, issueNumber: 42 });

    expect(dispatchWorkflow).toHaveBeenCalled();
  });

  it('dispatches without pause check when issueNumber is not provided', async () => {
    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7 });

    expect(getActivePause).not.toHaveBeenCalled();
    expect(dispatchWorkflow).toHaveBeenCalled();
  });
});

describe('handleReviewResult', () => {
  const baseOpts = {
    owner: TEST_OWNER,
    repo: TEST_REPO,
    prNumber: 7,
    issueNumber: 42,
    reviewSha: 'abc123',
    agentId: 'test-agent',
  };

  describe('PASS', () => {
    it('enables auto-merge and returns pass', async () => {
      getPRNodeId.mockResolvedValue('PR_NODE_1');
      enablePullRequestAutoMerge.mockResolvedValue(undefined);
      query.mockResolvedValue({ rows: [] }); // update retry record

      const result = await handleReviewResult({
        ...baseOpts,
        result: { status: 'PASS', blocking: [], advisory: [] },
      });

      expect(result.action).toBe('pass');
      expect(enablePullRequestAutoMerge).toHaveBeenCalledWith('PR_NODE_1', 'SQUASH');
    });

    it('still returns pass if auto-merge fails', async () => {
      getPRNodeId.mockResolvedValue('PR_NODE_1');
      enablePullRequestAutoMerge.mockRejectedValue(new Error('branch protection'));
      query.mockResolvedValue({ rows: [] });

      const result = await handleReviewResult({
        ...baseOpts,
        result: { status: 'PASS' },
      });

      expect(result.action).toBe('pass');
    });
  });

  describe('FAIL', () => {
    const failResult = {
      status: 'FAIL',
      blocking: [{ file: 'x.js', line: 10, issue: 'SQL injection' }],
      advisory: [{ file: 'y.js', line: 5, issue: 'naming' }],
      attempt: 1,
    };

    it('increments retry count and notifies agent', async () => {
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
      query.mockResolvedValue({ rows: [] });

      const result = await handleReviewResult({ ...baseOpts, result: failResult });

      expect(result.action).toBe('fail');
      expect(notifyReviewFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'test-agent',
          repo: TEST_REPO_KEY,
          prNumber: 7,
          attempt: 1,
        }),
      );
    });

    it('combines blocking + advisory with severity tags', async () => {
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
      query.mockResolvedValue({ rows: [] });

      await handleReviewResult({ ...baseOpts, result: failResult });

      const issues = notifyReviewFailure.mock.calls[0][0].issues;
      expect(issues).toHaveLength(2);
      expect(issues[0].severity).toBe('blocking');
      expect(issues[1].severity).toBe('advisory');
    });

    it('uses agentId param over config defaults', async () => {
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
      query.mockResolvedValue({ rows: [] });

      await handleReviewResult({ ...baseOpts, agentId: 'specific-agent', result: failResult });

      expect(notifyReviewFailure).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'specific-agent' }),
      );
    });

    it('passes on_failure from config to notifyReviewFailure', async () => {
      resolveConfig.mockResolvedValue(buildConfig({
        reviewer: { enabled: true, max_retries: 3, on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
      }));
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
      query.mockResolvedValue({ rows: [] });

      await handleReviewResult({ ...baseOpts, result: failResult });

      expect(notifyReviewFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          onFailure: { model: 'claude-sonnet-4-6', thinking: 'high' },
        }),
      );
    });

    it('passes undefined onFailure when on_failure not configured', async () => {
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
      query.mockResolvedValue({ rows: [] });

      await handleReviewResult({ ...baseOpts, result: failResult });

      expect(notifyReviewFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          onFailure: undefined,
        }),
      );
    });
  });

  describe('ESCALATE (max retries)', () => {
    it('escalates after max retries, resets counter, adds label, pauses', async () => {
      resolveConfig.mockResolvedValue(buildConfig({ reviewer: { enabled: true, max_retries: 3 } }));
      // retry upsert returns count = 3 (hit max)
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 3 })] });
      // resetRetries
      query.mockResolvedValueOnce({ rows: [] });

      const result = await handleReviewResult({
        ...baseOpts,
        result: { status: 'FAIL', blocking: [{ file: 'a.js', line: 1, issue: 'bug' }], advisory: [] },
      });

      expect(result.action).toBe('escalate');
      expect(addLabel).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, 'needs-human');
      expect(recordPause).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: TEST_OWNER,
          repo: TEST_REPO,
          issueNumber: 42,
          reason: 'review-escalation',
          agentId: 'test-agent',
        }),
      );
    });

    it('does not escalate when under max retries', async () => {
      resolveConfig.mockResolvedValue(buildConfig({ reviewer: { enabled: true, max_retries: 3 } }));
      query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 2 })] });
      query.mockResolvedValue({ rows: [] });

      const result = await handleReviewResult({
        ...baseOpts,
        result: { status: 'FAIL', blocking: [{ file: 'a.js', line: 1, issue: 'bug' }] },
      });

      expect(result.action).toBe('fail');
      expect(addLabel).not.toHaveBeenCalled();
      expect(recordPause).not.toHaveBeenCalled();
    });
  });
});

describe('getRetryRecord', () => {
  it('returns record when found', async () => {
    const record = makeRetryRecord();
    query.mockResolvedValueOnce({ rows: [record] });

    const result = await getRetryRecord(TEST_REPO_KEY, 7);
    expect(result).toEqual(record);
  });

  it('returns null when not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getRetryRecord(TEST_REPO_KEY, 99)).toBeNull();
  });
});
