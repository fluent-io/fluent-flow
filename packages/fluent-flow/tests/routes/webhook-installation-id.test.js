import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY,
} from '../helpers/mocks.js';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
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
  resolveAgentId: vi.fn().mockReturnValue(null),
  notifyPRMerged: vi.fn(),
  resolveAgentForIssue: vi.fn(),
}));
vi.mock('../../src/providers/github/rest.js', () => ({
  getLinkedPR: vi.fn().mockResolvedValue(null),
  getPR: vi.fn(),
}));
vi.mock('../../src/providers/github/check-run-handler.js', () => ({
  handleCheckRun: vi.fn(),
}));
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  webhookSignatureMiddleware: (req, res, next) => next(),
  appWebhookSignatureMiddleware: (req, res, next) => next(),
}));

import { getLinkedPR } from '../../src/providers/github/rest.js';
import { handleIssueComment } from '../../src/routes/webhook.js';

const INSTALLATION_ID = 77;

beforeEach(() => {
  vi.clearAllMocks();
  getLinkedPR.mockResolvedValue(null);
});

describe('handleIssueComment with installation_id in payload', () => {
  it('passes installation_id as ctx to getLinkedPR when present in payload', async () => {
    const payload = {
      action: 'created',
      installation: { id: INSTALLATION_ID },
      comment: { body: '<!-- agent-pause: {"reason":"stuck"} -->', user: { login: 'bot' } },
      issue: { number: 10 },
      repository: { full_name: TEST_REPO_KEY },
    };

    await handleIssueComment(TEST_OWNER, TEST_REPO, payload, buildConfig());

    expect(getLinkedPR).toHaveBeenCalledWith(
      TEST_OWNER,
      TEST_REPO,
      10,
      expect.objectContaining({ installation_id: INSTALLATION_ID })
    );
  });

  it('calls getLinkedPR with no installation_id when payload has no installation', async () => {
    const payload = {
      action: 'created',
      comment: { body: '<!-- agent-pause: {"reason":"stuck"} -->', user: { login: 'bot' } },
      issue: { number: 10 },
      repository: { full_name: TEST_REPO_KEY },
    };

    await handleIssueComment(TEST_OWNER, TEST_REPO, payload, buildConfig());

    // Should still be called, but ctx will not have installation_id
    expect(getLinkedPR).toHaveBeenCalledWith(
      TEST_OWNER,
      TEST_REPO,
      10,
      expect.not.objectContaining({ installation_id: expect.anything() })
    );
  });
});
