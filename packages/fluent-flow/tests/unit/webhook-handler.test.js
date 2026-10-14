import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY, makeRetryRecord,
} from '../helpers/mocks.js';


const dbMockState = vi.hoisted(() => ({
  staleClaims: [],
  selectWhereArgs: [],
  updateSets: [],
  updateWhereArgs: [],
  failUpdate: false,
}));

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    db: {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation((...args) => {
            dbMockState.selectWhereArgs.push(args);
            return Promise.resolve(dbMockState.staleClaims);
          }),
        })),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((values) => {
          dbMockState.updateSets.push(values);
          return {
            where: vi.fn().mockImplementation((...args) => {
              dbMockState.updateWhereArgs.push(args);
              if (dbMockState.failUpdate) {
                return Promise.reject(new Error('update failed'));
              }
              return Promise.resolve([]);
            }),
          };
        }),
      })),
    },
    schema: real.schema,
  };
});
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn(),
  invalidateConfig: vi.fn(),
  resolveOrgId: vi.fn().mockResolvedValue('self-hosted'),
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
vi.mock('../../src/providers/github/rest.js', () => ({
  getLinkedPR: vi.fn(),
  getPR: vi.fn(),
}));
vi.mock('../../src/providers/github/check-run-handler.js', () => ({
  handleCheckRun: vi.fn(),
}));
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  webhookSignatureMiddleware: (req, res, next) => next(),
}));

import { db } from '@fluent-flow/db';
import { audit } from '../../src/db/client.js';
import { resolveConfig } from '../../src/config/loader.js';
import { dispatchReview, getRetryRecord, resetRetries } from '../../src/engine/review-manager.js';
import { resolveAgentId, notifyPRMerged, resolveAgentForIssue } from '../../src/notifications/dispatcher.js';
import { executeTransition } from '../../src/engine/state-machine.js';
import { recordPause, processResume, getActivePause } from '../../src/engine/pause-manager.js';
import { handlePullRequest, handleIssues, handleIssueComment } from '../../src/routes/webhook.js';

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.staleClaims = [];
  dbMockState.selectWhereArgs = [];
  dbMockState.updateSets = [];
  dbMockState.updateWhereArgs = [];
  dbMockState.failUpdate = false;
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

function walkQueryTree(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  visit(node);
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) walkQueryTree(chunk, visit, depth + 1);
  }
  if (Array.isArray(node)) {
    for (const item of node) walkQueryTree(item, visit, depth + 1);
  }
}

function collectQueryText(whereArgs) {
  const parts = [];
  walkQueryTree(whereArgs, (node) => {
    if (typeof node.name === 'string') parts.push(node.name);
    if (typeof node.value === 'string' || typeof node.value === 'number') {
      parts.push(String(node.value));
    }
    if (Array.isArray(node.value)) {
      for (const value of node.value) {
        if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
      }
    }
  });
  return parts.join(' ');
}

describe('handlePullRequest — synchronize (CI-gated)', () => {
  it('synchronize does not dispatch review or read retry record (CI-gated)', async () => {
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

    expect(dispatchReview).not.toHaveBeenCalled();
    expect(getRetryRecord).not.toHaveBeenCalled();
  });

  it('cancels stale pending green verify claims and filters the lookup to green phase only', async () => {
    dbMockState.staleClaims = [
      {
        id: 21,
        repo: TEST_REPO_KEY,
        prNumber: 7,
        claimType: 'verify',
        status: 'pending',
        payload: { phase: 'green' },
        headSha: 'old-sha',
      },
    ];

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

    expect(db.select).toHaveBeenCalledOnce();
    const queryText = collectQueryText(dbMockState.selectWhereArgs);
    expect(queryText).toContain('verify');
    expect(queryText).toContain('pending');
    expect(queryText).toContain('phase');
    expect(queryText).toContain('green');
    expect(db.update).toHaveBeenCalledOnce();
    expect(dbMockState.updateSets[0]).toMatchObject({ status: 'cancelled' });
    expect(audit).toHaveBeenCalledWith('green_claim_cancelled', {
      repo: TEST_REPO_KEY,
      data: expect.objectContaining({
        claimId: 21,
        prNumber: 7,
        oldHeadSha: 'old-sha',
        newHeadSha: 'def456',
      }),
    });
  });

  it('throws when stale green claim cancellation cannot be persisted', async () => {
    dbMockState.staleClaims = [
      {
        id: 21,
        repo: TEST_REPO_KEY,
        prNumber: 7,
        claimType: 'verify',
        status: 'pending',
        payload: { phase: 'green' },
        headSha: 'old-sha',
      },
    ];
    dbMockState.failUpdate = true;

    await expect(handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'synchronize',
      pull_request: {
        number: 7, body: 'Fixes #42',
        base: { ref: 'main' }, head: { sha: 'def456' },
        user: { login: 'bot' },
      },
      sender: { login: 'bot' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig())).rejects.toThrow('update failed');
  });
});

describe('handlePullRequest — opened/reopened (CI-gated)', () => {
  it('opened does not dispatch review (CI-gated)', async () => {
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

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('reopened does not dispatch review (CI-gated)', async () => {
    await handlePullRequest(TEST_OWNER, TEST_REPO, {
      action: 'reopened',
      pull_request: {
        number: 7, body: 'Fixes #42',
        user: { login: 'bot' },
        base: { ref: 'main' }, head: { sha: 'abc' },
      },
      sender: { login: 'bot' },
      repository: { full_name: TEST_REPO_KEY },
    }, buildConfig());

    expect(dispatchReview).not.toHaveBeenCalled();
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

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object), undefined);
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

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object), undefined);
    expect(processResume).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'resolved-agent' }),
    );
  });

  it('uses resolveAgentForIssue for agent-pause comment', async () => {
    resolveAgentForIssue.mockResolvedValue('resolved-agent');
    const { parseResumeCommand } = await import('../../src/engine/pause-manager.js');
    parseResumeCommand.mockReturnValue({ isResume: false });
    const { getLinkedPR } = await import('../../src/providers/github/rest.js');
    getLinkedPR.mockResolvedValue(7);

    await handleIssueComment(TEST_OWNER, TEST_REPO, {
      action: 'created',
      comment: {
        body: '<!-- agent-pause: {"reason": "agent-stuck", "context": "test"} -->',
        user: { login: 'bot' },
      },
      issue: { number: 42 },
    }, buildConfig());

    expect(resolveAgentForIssue).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, expect.any(Object), undefined);
    expect(recordPause).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'resolved-agent' }),
    );
  });
});
