import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY, makeRetryRecord,
} from '../helpers/mocks.js';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn(),
  invalidateConfig: vi.fn(),
}));
vi.mock('../../src/engine/state-machine.js', () => ({
  executeTransition: vi.fn(),
  autoTransition: vi.fn(),
  getCurrentState: vi.fn(),
}));
vi.mock('../../src/engine/pause-manager.js', () => ({
  recordPause: vi.fn(),
  processResume: vi.fn(),
  parseResumeCommand: vi.fn().mockReturnValue({ isResume: false }),
  getActivePause: vi.fn(),
}));
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  handleReviewResult: vi.fn(),
  getRetryRecord: vi.fn(),
  resetRetries: vi.fn(),
}));
vi.mock('../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: vi.fn(),
  notifyPRMerged: vi.fn(),
  resolveAgentForIssue: vi.fn(),
}));
vi.mock('../../src/github/rest.js', () => ({
  getLinkedPR: vi.fn(),
  getPR: vi.fn(),
}));
vi.mock('../../src/github/check-run-handler.js', () => ({
  handleCheckRun: vi.fn(),
}));
vi.mock('../../src/github/webhook-verify.js', () => ({
  webhookSignatureMiddleware: (req, res, next) => next(),
}));

import { audit } from '../../src/db/client.js';
import { resolveConfig } from '../../src/config/loader.js';
import { dispatchReview, getRetryRecord, resetRetries } from '../../src/engine/review-manager.js';
import { resolveAgentId, notifyPRMerged, resolveAgentForIssue } from '../../src/notifications/dispatcher.js';
import { executeTransition } from '../../src/engine/state-machine.js';
import { recordPause, processResume, getActivePause } from '../../src/engine/pause-manager.js';
import { handlePullRequest, handleIssues, handleIssueComment } from '../../src/routes/webhook.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfig.mockResolvedValue(buildConfig());
});

describe('handlePullRequest — closed', () => {
  it('calls resetRetries unconditionally when PR is merged', async () => {
    resolveAgentId.mockReturnValue('test-agent');

    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'closed',
      pull_request: {
        number: 7, body: 'Fixes #42', merged: true,
        user: { login: 'bot' }, merged_by: { login: 'admin' },
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'admin' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(resetRetries).toHaveBeenCalledWith(TEST_REPO_KEY, 7);
  });

  it('calls resetRetries unconditionally when PR is closed without merge', async () => {
    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'closed',
      pull_request: {
        number: 7, body: 'Fixes #42', merged: false,
        user: { login: 'bot' }, merged_by: null,
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'admin' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(resetRetries).toHaveBeenCalledWith(TEST_REPO_KEY, 7);
  });

  it('calls resetRetries even when PR has no linked issue', async () => {
    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'closed',
      pull_request: {
        number: 7, body: 'No issue link here', merged: true,
        user: { login: 'bot' }, merged_by: { login: 'admin' },
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'admin' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(resetRetries).toHaveBeenCalledWith(TEST_REPO_KEY, 7);
  });

  it('emits retries_cleared audit event', async () => {
    resolveAgentId.mockReturnValue('test-agent');

    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'closed',
      pull_request: {
        number: 7, body: 'Fixes #42', merged: true,
        user: { login: 'bot' }, merged_by: { login: 'admin' },
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'admin' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(audit).toHaveBeenCalledWith('retries_cleared', {
      repo: TEST_REPO_KEY,
      data: { prNumber: 7, trigger: 'pr_closed' },
    });
  });
});

describe('handlePullRequest — synchronize', () => {
  it('passes issueNumber from PR body to dispatchReview', async () => {
    getRetryRecord.mockResolvedValue(makeRetryRecord({ retry_count: 1 }));

    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'synchronize',
      pull_request: {
        number: 7, body: 'Fixes #42',
        base: { ref: 'main' }, head: { sha: 'def456' },
        user: { login: 'bot' },
      },
      sender: { login: 'bot' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(dispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42 }),
    );
  });

  it('skips dispatch when retry count >= max_retries', async () => {
    getRetryRecord.mockResolvedValue(makeRetryRecord({ retry_count: 2 }));

    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'synchronize',
      pull_request: {
        number: 7, body: 'Fixes #42',
        base: { ref: 'main' }, head: { sha: 'def456' },
        user: { login: 'bot' },
      },
      sender: { login: 'bot' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig({ reviewer: { enabled: true, max_retries: 2 } }));

    expect(dispatchReview).not.toHaveBeenCalled();
  });
});

describe('handlePullRequest — opened/reopened', () => {
  it('passes issueNumber to dispatchReview', async () => {
    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'opened',
      pull_request: {
        number: 7, body: 'Fixes #42',
        user: { login: 'bot' },
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'bot' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(dispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42 }),
    );
  });
});

describe('handleIssues — agent routing', () => {
  it('uses resolveAgentForIssue when labeling needs-human', async () => {
    resolveAgentForIssue.mockResolvedValue('resolved-agent');
    // getCurrentState must not return 'Awaiting Human' for pause to fire
    const { getCurrentState } = await import('../../src/engine/state-machine.js');
    getCurrentState.mockResolvedValue('In Review');

    await handleIssues(TEST_OWNER, TEST_REPO, {
      action: 'labeled',
      issue: { number: 42 },
      label: { name: 'needs-human' },
      sender: { login: 'human' },
    }, buildConfig());

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object));
    expect(recordPause).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'resolved-agent' }),
    );
  });

  it('uses activePause.agent_id when unlabeling needs-human', async () => {
    getActivePause.mockResolvedValue({ id: 1, agent_id: 'pause-agent' });

    await handleIssues(TEST_OWNER, TEST_REPO, {
      action: 'unlabeled',
      issue: { number: 42 },
      label: { name: 'needs-human' },
      sender: { login: 'human' },
    }, buildConfig());

    expect(processResume).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'pause-agent' }),
    );
    expect(resolveAgentForIssue).not.toHaveBeenCalled();
  });
});

describe('handleIssueComment — agent routing', () => {
  it('uses resolveAgentForIssue for /resume command', async () => {
    resolveAgentForIssue.mockResolvedValue('resolved-agent');
    const { parseResumeCommand } = await import('../../src/engine/pause-manager.js');
    parseResumeCommand.mockReturnValue({ isResume: true, toState: null, instructions: null });

    await handleIssueComment(TEST_OWNER, TEST_REPO, {
      action: 'created',
      comment: { body: '/resume', user: { login: 'human' } },
      issue: { number: 42 },
    }, buildConfig());

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object));
    expect(processResume).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'resolved-agent' }),
    );
  });

  it('uses resolveAgentForIssue for agent-pause comment', async () => {
    resolveAgentForIssue.mockResolvedValue('resolved-agent');
    const { parseResumeCommand } = await import('../../src/engine/pause-manager.js');
    parseResumeCommand.mockReturnValue({ isResume: false });
    const { getLinkedPR } = await import('../../src/github/rest.js');
    getLinkedPR.mockResolvedValue(7);

    await handleIssueComment(TEST_OWNER, TEST_REPO, {
      action: 'created',
      comment: {
        body: '<!-- agent-pause: {"reason": "agent-stuck", "context": "test"} -->',
        user: { login: 'bot' },
      },
      issue: { number: 42 },
    }, buildConfig());

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object));
    expect(recordPause).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'resolved-agent' }),
    );
  });
});
