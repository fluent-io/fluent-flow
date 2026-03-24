import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY } from '../helpers/mocks.js';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

import { resolveAgentId, dispatch } from '../../src/notifications/dispatcher.js';
import { getPRsForCommit } from '../../src/github/rest.js';
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
