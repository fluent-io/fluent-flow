import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue(null),
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
vi.mock('../../src/providers/github/rest.js', () => ({
  getLinkedPR: vi.fn(),
  getPR: vi.fn(),
}));
vi.mock('../../src/providers/github/check-run-handler.js', () => ({
  handleCheckRun: vi.fn(),
}));
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  webhookSignatureMiddleware: (req, res, next) => next(),
  appWebhookSignatureMiddleware: (req, res, next) => next(),
  captureRawBody: vi.fn(),
}));
vi.mock('../../src/db/provider-installations.js', () => ({
  upsertInstallation: vi.fn(),
  softDeleteInstallation: vi.fn(),
  unsuspendInstallation: vi.fn(),
  findInstallationByExternalId: vi.fn(),
  addRepoToInstallation: vi.fn(),
  removeRepoFromInstallation: vi.fn(),
}));
vi.mock('../../src/db/outbound-queue.js', () => ({
  parkForInstallation: vi.fn(),
  unparkForInstallation: vi.fn(),
}));

function makeReq(method, path, body, headers = {}) {
  return { method, path, body, headers, ip: '127.0.0.1' };
}

function makeRes() {
  return {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    end() { return this; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FF_GITHUB_APP_ENABLED;
});

afterEach(() => {
  delete process.env.FF_GITHUB_APP_ENABLED;
});

describe('Legacy webhook gate (FF_GITHUB_APP_ENABLED)', () => {
  it('returns 503 on the legacy webhook path when flag is enabled', async () => {
    process.env.FF_GITHUB_APP_ENABLED = 'true';

    // Import after setting env so module sees the flag
    const { legacyWebhookGateMiddleware } = await import('../../src/routes/webhook.js');

    const req = makeReq('POST', '/api/webhook/github', { repository: { full_name: 'a/b' } }, {
      'x-github-event': 'push',
    });
    const res = makeRes();
    const next = vi.fn();

    legacyWebhookGateMiddleware(req, res, next);

    expect(res._status).toBe(503);
    expect(res._body).toMatchObject({ error: expect.stringContaining('legacy') });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when flag is not enabled', async () => {
    delete process.env.FF_GITHUB_APP_ENABLED;

    const { legacyWebhookGateMiddleware } = await import('../../src/routes/webhook.js');

    const req = makeReq('POST', '/api/webhook/github', {}, {});
    const res = makeRes();
    const next = vi.fn();

    legacyWebhookGateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });
});

describe('App webhook route exists', () => {
  it('github-app-webhook router exports a default Express router', async () => {
    const { default: router } = await import('../../src/routes/github-app-webhook.js');
    expect(typeof router).toBe('function');
    // Express routers have a 'stack' property
    expect(router.stack).toBeDefined();
  });
});
