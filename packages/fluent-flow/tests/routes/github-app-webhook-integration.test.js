import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Tracing + logger — standard test silencing.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

// Bypass webhook signature verification so we can POST raw payloads from the
// test without computing real HMACs. Signature logic is covered in its own
// unit test (tests/providers/github/webhook-verify.test.js) — this test is
// about wiring.
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  // Mirror the real implementation: attach buf to req.rawBody so the
  // downstream signature middleware can read it if the mock is ever relaxed.
  captureRawBody: (req, _res, buf) => { req.rawBody = buf; },
  webhookSignatureMiddleware: (_req, _res, next) => next(),
  appWebhookSignatureMiddleware: (_req, _res, next) => next(),
}));

// Mock the installation lifecycle so we can assert on invocations without
// needing a real DB. The handler has its own unit test in tests/engine.
const mockHandleInstallationCreated = vi.fn().mockResolvedValue({ id: 1 });
const mockHandleInstallationSuspended = vi.fn();
const mockHandleInstallationUnsuspended = vi.fn();
const mockHandleInstallationRepositoriesAdded = vi.fn();
const mockHandleInstallationRepositoriesRemoved = vi.fn();
vi.mock('../../src/engine/installation-lifecycle.js', () => ({
  handleInstallationCreated: (...args) => mockHandleInstallationCreated(...args),
  handleInstallationSuspended: (...args) => mockHandleInstallationSuspended(...args),
  handleInstallationUnsuspended: (...args) => mockHandleInstallationUnsuspended(...args),
  handleInstallationDeleted: vi.fn(),
  handleInstallationRepositoriesAdded: (...args) => mockHandleInstallationRepositoriesAdded(...args),
  handleInstallationRepositoriesRemoved: (...args) => mockHandleInstallationRepositoriesRemoved(...args),
}));

// Other routes and dependencies that app.js imports transitively — we don't
// use them in this test but they must not blow up on import.
vi.mock('../../src/mcp/handler.js', () => ({
  mcpHandler: (_req, res) => res.status(200).json({}),
  mcpMethodNotAllowed: (_req, res) => res.status(405).json({}),
}));
vi.mock('../../src/mcp/auth.js', () => ({
  mcpAuthMiddleware: (_req, _res, next) => next(),
}));

const { createApp } = await import('../../src/app.js');

describe('POST /webhooks/github-app (route integration)', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mockHandleInstallationCreated.mockClear();
  });

  it('routes installation.created to the handler at the configured URL', async () => {
    const payload = {
      action: 'created',
      installation: {
        id: 98765,
        account: { login: 'fluent-io', type: 'Organization' },
        permissions: { contents: 'read' },
        events: ['push'],
      },
      sender: { id: 1, login: 'vicpon', type: 'User', avatar_url: 'https://a.b/c.png' },
    };

    const res = await fetch(`${baseUrl}/webhooks/github-app`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(mockHandleInstallationCreated).toHaveBeenCalledTimes(1);
    const [receivedPayload] = mockHandleInstallationCreated.mock.calls[0];
    expect(receivedPayload.installation.id).toBe(98765);
    expect(receivedPayload.sender.login).toBe('vicpon');
  });

  it('does NOT mount the webhook under /api (regression guard for the Apr 2026 mount-path bug)', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/github-app`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
      },
      body: JSON.stringify({ action: 'created', installation: { id: 1, account: { login: 'x', type: 'User' } } }),
    });

    expect(res.status).toBe(404);
    expect(mockHandleInstallationCreated).not.toHaveBeenCalled();
  });
});
