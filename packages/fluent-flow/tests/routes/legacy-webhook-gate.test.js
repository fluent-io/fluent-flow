import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue(null),
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
});

describe('Legacy webhook endpoints return 410 Gone', () => {
  it('POST /webhook/github returns 410', async () => {
    const { default: router } = await import('../../src/routes/webhook.js');

    // Find the route handler for POST /webhook/github
    const layer = router.stack.find(l => l.route?.path === '/webhook/github' && l.route?.methods?.post);
    expect(layer).toBeDefined();

    const handler = layer.route.stack[0].handle;
    const res = makeRes();
    handler({}, res);

    expect(res._status).toBe(410);
    expect(res._body).toMatchObject({ error: expect.stringContaining('legacy') });
  });

  it('POST /webhooks/github returns 410', async () => {
    const { default: router } = await import('../../src/routes/webhook.js');

    const layer = router.stack.find(l => l.route?.path === '/webhooks/github' && l.route?.methods?.post);
    expect(layer).toBeDefined();

    const handler = layer.route.stack[0].handle;
    const res = makeRes();
    handler({}, res);

    expect(res._status).toBe(410);
    expect(res._body).toMatchObject({ error: expect.stringContaining('legacy') });
  });
});

describe('App webhook route exists', () => {
  it('github-app-webhook router exports a default Express router', async () => {
    const { default: router } = await import('../../src/routes/github-app-webhook.js');
    expect(typeof router).toBe('function');
    expect(router.stack).toBeDefined();
  });
});
