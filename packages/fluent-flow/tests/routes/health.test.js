import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const mockHealthCheck = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  healthCheck: (...args) => mockHealthCheck(...args),
}));

const { createApp } = await import('../../src/app.js');

describe('GET /api/health', () => {
  let server;
  let baseUrl;
  const originalSecret = process.env.FF_COLLAB_AUTH_SECRET;

  beforeAll(async () => {
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mockHealthCheck.mockReset();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
    else process.env.FF_COLLAB_AUTH_SECRET = originalSecret;
  });

  it('returns 503 with missingEnvVars when FF_COLLAB_AUTH_SECRET is unset', async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;

    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ status: 'error', missingEnvVars: ['FF_COLLAB_AUTH_SECRET'] });
    expect(mockHealthCheck).not.toHaveBeenCalled();
  });

  it('returns 200 when required env vars are set and the db is healthy', async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'test-secret';
    mockHealthCheck.mockResolvedValueOnce(true);

    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('returns 503 when the db is unhealthy', async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'test-secret';
    mockHealthCheck.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ status: 'error', db: 'unhealthy' });
  });
});
