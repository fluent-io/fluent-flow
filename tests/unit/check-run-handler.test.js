import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY } from '../helpers/mocks.js';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn(),
  getCheckRunsForCommit: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  getRetryRecord: vi.fn(),
}));
vi.mock('../../src/routes/webhook.js', () => ({
  extractLinkedIssue: vi.fn().mockReturnValue(null),
}));

import { resolveAgentId, dispatch } from '../../src/notifications/dispatcher.js';
import { getPRsForCommit, getCheckRunsForCommit } from '../../src/github/rest.js';
import { dispatchReview, getRetryRecord } from '../../src/engine/review-manager.js';
import { handleCheckRun } from '../../src/github/check-run-handler.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleCheckRun — agent routing', () => {
  const basePayload = {
    action: 'completed',
    check_run: {
      conclusion: 'failure',
      name: 'tests',
      head_sha: 'abc123',
      completed_at: '2026-03-23T00:00:00Z',
    },
  };

  it('passes PR body to resolveAgentId when PR is found', async () => {
    getPRsForCommit.mockResolvedValue([
      { number: 7, title: 'Fix bug', body: '<!-- fluent-flow-agent: pr-agent -->\nFixes #42' },
    ]);
    resolveAgentId.mockReturnValue('pr-agent');

    const config = buildConfig();
    await handleCheckRun(TEST_OWNER, TEST_REPO, basePayload, config);

    expect(resolveAgentId).toHaveBeenCalledWith({
      prBody: '<!-- fluent-flow-agent: pr-agent -->\nFixes #42',
      config,
    });
  });

  it('passes undefined prBody when no PRs found', async () => {
    getPRsForCommit.mockResolvedValue([]);
    resolveAgentId.mockReturnValue('default-agent');

    const config = buildConfig();
    await handleCheckRun(TEST_OWNER, TEST_REPO, basePayload, config);

    expect(resolveAgentId).toHaveBeenCalledWith({
      prBody: undefined,
      config,
    });
  });

  it('passes undefined prBody when getPRsForCommit fails', async () => {
    getPRsForCommit.mockRejectedValue(new Error('API error'));
    resolveAgentId.mockReturnValue('default-agent');

    const config = buildConfig();
    await handleCheckRun(TEST_OWNER, TEST_REPO, basePayload, config);

    expect(resolveAgentId).toHaveBeenCalledWith({
      prBody: undefined,
      config,
    });
  });
});

describe('handleCheckRun — CI success review dispatch', () => {
  const successPayload = {
    action: 'completed',
    check_run: {
      conclusion: 'success',
      name: 'lint-and-test',
      head_sha: 'abc123',
      app: { slug: 'github-actions' },
    },
  };

  const prObj = { number: 5, title: 'feat: stuff', body: 'PR body', base: { ref: 'main' } };

  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });

  it('dispatches review when trigger_check matches', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({
      owner: TEST_OWNER, repo: TEST_REPO, prNumber: 5, ref: 'main', attempt: 1,
    }));
  });

  it('ignores when trigger_check does not match', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'e2e-tests' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('ignores review workflow check runs', async () => {
    const reviewPayload = {
      action: 'completed',
      check_run: { conclusion: 'success', name: 'review / Automated Code Review', head_sha: 'abc123', app: { slug: 'github-actions' } },
    };
    const config = buildConfig({ reviewer: { enabled: true } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, reviewPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('skips dispatch when max retries reached', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    getRetryRecord.mockResolvedValue({ retry_count: 3, last_issues: [] });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('passes priorIssues and attempt from retry record', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    const issues = [{ file: 'a.js', issue: 'bad' }];
    getRetryRecord.mockResolvedValue({ retry_count: 1, last_issues: issues });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, priorIssues: issues }));
  });

  it('extracts ref from PR base branch', async () => {
    getPRsForCommit.mockResolvedValue([{ ...prObj, base: { ref: 'develop' } }]);
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ ref: 'develop' }));
  });

  it('ignores when reviewer is disabled', async () => {
    const config = buildConfig({ reviewer: { enabled: false } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('ignores non-success conclusions (cancelled, timed_out)', async () => {
    const cancelledPayload = {
      action: 'completed',
      check_run: { conclusion: 'cancelled', name: 'lint-and-test', head_sha: 'abc123', app: { slug: 'github-actions' } },
    };
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, cancelledPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('uses first open PR when multiple PRs linked to same commit', async () => {
    const pr1 = { number: 5, title: 'PR 1', body: 'body', base: { ref: 'main' } };
    const pr2 = { number: 8, title: 'PR 2', body: 'body', base: { ref: 'develop' } };
    getPRsForCommit.mockResolvedValue([pr1, pr2]);
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5, ref: 'main' }));
  });
});

describe('handleCheckRun — fallback all-checks-pass', () => {
  const successPayload = {
    action: 'completed',
    check_run: { conclusion: 'success', name: 'lint-and-test', head_sha: 'abc123', app: { slug: 'github-actions' } },
  };
  const prObj = { number: 5, title: 'feat: stuff', body: 'PR body', base: { ref: 'main' } };

  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });

  it('dispatches when all check runs pass (no trigger_check set)', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'typecheck', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    ]);
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalled();
  });

  it('waits when some checks are still pending', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'typecheck', status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } },
    ]);
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('excludes review workflow runs from all-checks query', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'review / Automated Code Review', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
    ]);
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalled();
  });
});
