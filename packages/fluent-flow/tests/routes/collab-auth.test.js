import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Standard test silencing — tracing + logger only. The collaboration router
// must be exercised for real (no mocks): this suite pins the consumer-visible
// auth boundary of /api/collab/v1.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { createApp } = await import('../../src/app.js');

// Server-only assertion secret as an operator would configure it. Never a
// caller-supplied value; the route reads it per request.
const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';

describe('collaboration API auth boundary (/api/collab/v1)', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers an unauthenticated task list request with 401, not the global 404', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message).not.toMatch(/secret|assertion|header/i);
    expect(typeof body.error.requestId).toBe('string');
  });

  it('rejects a malformed actor assertion with the same public 401 shape', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': 'v1.not-json.not-a-signature' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
    expect(typeof body.error.requestId).toBe('string');
  });

  it('rejects a tampered assertion signature with 401', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: {
        'x-fluent-flow-actor':
          'v1.eyJpc3MiOiJmbGllbnQtZmxvdy1kYXNoYm9hcmQiLCJhdWQiOiJmbGllbnQtZmxvdy1jb2xsYWIiLCJzdWIiOiJwMSIsInNlc3Npb25WZXJzaW9uIjoxLCJpYXQiOjEsImV4cCI6NjF9.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });

  it('rejects duplicate actor assertion headers with 401', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: [
        ['x-fluent-flow-actor', 'v1.a.b'],
        ['x-fluent-flow-actor', 'v1.c.d'],
      ],
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });
});
