import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exchangeEnrollmentToken: vi.fn(),
  validateToken: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@fluent-flow/db', async (importOriginal) => ({
  ...(await importOriginal()),
  exchangeEnrollmentToken: mocks.exchangeEnrollmentToken,
}));

vi.mock('../../src/agents/token-manager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  validateToken: mocks.validateToken,
}));

vi.mock('../../src/logger.js', () => ({ default: mocks.logger }));

vi.mock('../../src/mcp/handler.js', () => ({
  mcpHandler: (_req, res) => res.status(200).json({}),
  mcpMethodNotAllowed: (_req, res) => res.status(405).json({}),
}));

vi.mock('../../src/mcp/auth.js', () => ({
  mcpAuthMiddleware: (_req, _res, next) => next(),
}));

const INSTANCE_ID = '2cee51c9-6351-43bd-92b8-f8763d47fdea';
const ENROLLMENT_TOKEN = 'enroll_test_credential';
const RUNTIME_TOKEN = `ff_${'a'.repeat(64)}`;

let server;
let baseUrl;

async function requestEnrollment({
  authorization = `Bearer ${ENROLLMENT_TOKEN}`,
  body = { instance_id: INSTANCE_ID },
  forwardedFor,
} = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;
  const response = await fetch(`${baseUrl}/api/agent-server/enroll`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = JSON.parse(text);
  return { status: response.status, body: parsed, text };
}

beforeEach(async () => {
  vi.resetModules();
  mocks.exchangeEnrollmentToken.mockReset().mockResolvedValue(null);
  mocks.validateToken.mockReset();
  Object.values(mocks.logger).forEach((method) => method.mockClear());
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('POST /api/agent-server/enroll', () => {
  it.each([
    ['a missing Authorization header', null],
    ['a non-Bearer Authorization header', `Basic ${ENROLLMENT_TOKEN}`],
    ['an empty Bearer credential', 'Bearer '],
    ['a Bearer credential containing whitespace', 'Bearer invalid credential'],
  ])('rejects %s without invoking either token boundary', async (_label, authorization) => {
    const response = await requestEnrollment({ authorization });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid enrollment credential' });
    expect(mocks.exchangeEnrollmentToken).not.toHaveBeenCalled();
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing instance ID', {}],
    ['a non-UUID instance ID', { instance_id: 'portable-agent-1' }],
    ['a non-string instance ID', { instance_id: 42 }],
  ])('rejects %s before exchange', async (_label, body) => {
    const response = await requestEnrollment({ body });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Validation failed' });
    expect(mocks.exchangeEnrollmentToken).not.toHaveBeenCalled();
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it.each([
    'unknown',
    'expired',
    'revoked',
    'consumed',
    'non-enrollment',
  ])('returns the same public response for a %s credential', async () => {
    const response = await requestEnrollment();

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid enrollment credential' });
    expect(response.text).not.toMatch(/expired|revoked|consumed|label|agent_tokens/i);
    expect(mocks.exchangeEnrollmentToken).toHaveBeenCalledWith({
      plaintext: ENROLLMENT_TOKEN,
      instanceId: INSTANCE_ID,
    });
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it('returns only the one-time runtime token and bypasses durable-token validation', async () => {
    mocks.exchangeEnrollmentToken.mockResolvedValueOnce({
      plaintext: RUNTIME_TOKEN,
      id: 91,
      orgId: 'org-1',
      agentId: 'agent-1',
    });

    const response = await requestEnrollment();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ token: RUNTIME_TOKEN });
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it('returns the generic invalid outcome when a successfully exchanged credential is replayed', async () => {
    mocks.exchangeEnrollmentToken
      .mockResolvedValueOnce({ plaintext: RUNTIME_TOKEN, id: 91, orgId: 'org-1', agentId: 'agent-1' })
      .mockResolvedValueOnce(null);

    const first = await requestEnrollment();
    const replay = await requestEnrollment();

    expect(first).toMatchObject({ status: 200, body: { token: RUNTIME_TOKEN } });
    expect(replay).toMatchObject({ status: 401, body: { error: 'Invalid enrollment credential' } });
    expect(replay.text).not.toMatch(/replay|consumed|revoked/i);
  });

  it('logs unexpected exchange failures while exposing only generic server text', async () => {
    const internalDetail = 'agent_tokens query failed at INTERNAL_DATABASE_URL';
    mocks.exchangeEnrollmentToken.mockRejectedValueOnce(new Error(internalDetail));

    const response = await requestEnrollment();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(response.text).not.toContain(internalDetail);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: internalDetail }));
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it('bounds attempts by the socket peer and cannot be evaded with forwarded addresses', async () => {
    let limitedAt = null;

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const response = await requestEnrollment({ forwardedFor: `203.0.113.${attempt}` });
      if (response.status === 429) {
        limitedAt = attempt;
        break;
      }
      expect(response.status).toBe(401);
    }

    expect(limitedAt).not.toBeNull();
    const afterLimit = await requestEnrollment({ forwardedFor: '198.51.100.250' });
    expect(afterLimit.status).toBe(429);
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });
});
