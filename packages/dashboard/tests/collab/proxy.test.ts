import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockSignActor = vi.fn();
const PROXY_SIGNED = 'v1.proxy-signed.assertion';

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

vi.mock('@fluent-flow/db', () => ({
  signCollaborationActor: (...args: unknown[]) => mockSignActor(...args),
}));

const { GET, POST } = await import('../../src/app/api/collab/v1/[...path]/route.js');

const SECRET = 'test-shared-secret';

function makeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
    signal: init.signal,
  });
}

function makeCtx(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

const SESSION = {
  user: {
    id: null,
    principalId: 'p-123',
    sessionVersion: 3,
    login: 'collaborator',
    email: 'c@example.com',
    image: null,
    isSuperadmin: false,
    orgs: [],
  },
};

function upstreamFetchMock(response: { status?: number; body?: string; headers?: Record<string, string> } = {}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(response.body ?? '{"data":{}}', {
      status: response.status ?? 200,
      headers: response.headers ?? { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.FF_COLLAB_AUTH_SECRET = SECRET;
  process.env.FF_COLLAB_API_URL = 'http://127.0.0.1:3847';
  mockGetServerSession.mockReset().mockResolvedValue(SESSION);
  mockSignActor.mockReset().mockReturnValue(PROXY_SIGNED);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collab proxy /api/collab/v1', () => {
  it('returns 401 with error envelope when there is no session', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const fetchMock = upstreamFetchMock();

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/tasks'), makeCtx(['tasks']));

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBeDefined();
    expect(data.error.message).toBeDefined();
    expect(typeof data.error.requestId).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth check precedes configuration check for protected routes', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const fetchMock = upstreamFetchMock();

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/tasks'), makeCtx(['tasks']));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the Express prefix with the signed actor header', async () => {
    const fetchMock = upstreamFetchMock({ body: '{"data":{"tasks":[]}}' });

    const res = await GET(
      makeRequest('http://localhost:3000/api/collab/v1/tasks?workspaceId=w1'),
      makeCtx(['tasks']),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3847/api/collab/v1/tasks?workspaceId=w1');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-fluent-flow-actor')).toBe(PROXY_SIGNED);
    expect(mockSignActor).toHaveBeenCalledWith({ principalId: 'p-123', sessionVersion: 3 }, SECRET);
  });

  it('strips any inbound actor and authorization headers before signing its own', async () => {
    const fetchMock = upstreamFetchMock();

    await GET(
      makeRequest('http://localhost:3000/api/collab/v1/tasks', {
        headers: {
          'x-fluent-flow-actor': 'v1.evil.evil',
          authorization: 'Bearer forged',
          cookie: 'next-auth.session-token=forged',
        },
      }),
      makeCtx(['tasks']),
    );

    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-fluent-flow-actor')).toBe(PROXY_SIGNED);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('does not forward a browser-supplied x-forwarded-for', async () => {
    const fetchMock = upstreamFetchMock();

    await GET(
      makeRequest('http://localhost:3000/api/collab/v1/tasks', {
        headers: { 'x-forwarded-for': '6.6.6.6' },
      }),
      makeCtx(['tasks']),
    );

    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-forwarded-for')).toBeNull();
  });

  it('rejects cross-origin mutations without contacting upstream', async () => {
    const fetchMock = upstreamFetchMock();

    const res = await POST(
      makeRequest('http://localhost:3000/api/collab/v1/projects/p1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ title: 'x' }),
      }),
      makeCtx(['projects', 'p1', 'tasks']),
    );

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts same-host mutations even when the framework rewrites request.url', async () => {
    const fetchMock = upstreamFetchMock({ status: 201, body: '{"data":{}}' });

    // Next dev can rebuild request.url from a different host name; the security
    // property is that Origin's host matches the observed Host header.
    const request = new Request('http://localhost:3100/api/collab/v1/projects/p1/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3100',
        host: '127.0.0.1:3100',
      },
      body: JSON.stringify({ title: 'x' }),
    });
    Object.defineProperty(request, 'url', { value: 'http://localhost:3100/api/collab/v1/projects/p1/tasks' });

    const res = await POST(request, makeCtx(['projects', 'p1', 'tasks']));

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects mutations whose origin host differs from the observed host header', async () => {
    const fetchMock = upstreamFetchMock();

    const request = new Request('http://localhost:3100/api/collab/v1/projects/p1/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        host: '127.0.0.1:3100',
      },
      body: JSON.stringify({ title: 'x' }),
    });
    Object.defineProperty(request, 'url', { value: 'http://localhost:3100/api/collab/v1/projects/p1/tasks' });

    const res = await POST(request, makeCtx(['projects', 'p1', 'tasks']));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a generic 503 and no secret when the shared secret is missing', async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const fetchMock = upstreamFetchMock();

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/me'), makeCtx(['me']));

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.message).toBe('Configuration error. Contact support.');
    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes through upstream status and body', async () => {
    upstreamFetchMock({ status: 409, body: '{"error":{"code":"version_conflict","message":"This item changed."}}' });

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/tasks/t1'), makeCtx(['tasks', 't1']));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe('version_conflict');
  });

  it('returns generic 503 when upstream is unreachable, without leaking the URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3847')));

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/me'), makeCtx(['me']));

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.message).toBe('Configuration error. Contact support.');
    expect(JSON.stringify(data)).not.toContain('3847');
    expect(JSON.stringify(data)).not.toContain('ECONNREFUSED');
  });

  it('forwards the Idempotency-Key unchanged across mutations', async () => {
    const fetchMock = upstreamFetchMock({ status: 201, body: '{"data":{"id":"run-1"}}' });

    for (let i = 0; i < 2; i += 1) {
      const res = await POST(
        makeRequest('http://localhost:3000/api/collab/v1/tasks/t1/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'start-key-abc' },
          body: JSON.stringify({ expectedVersion: 4 }),
        }),
        makeCtx(['tasks', 't1', 'runs']),
      );
      expect(res.status).toBe(201);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1].headers).get('idempotency-key')).toBe('start-key-abc');
    }
  });

  it('forwards Last-Event-ID on event stream requests', async () => {
    const fetchMock = upstreamFetchMock();

    await GET(
      makeRequest('http://localhost:3000/api/collab/v1/events?cursor=x', {
        headers: { accept: 'text/event-stream', 'last-event-id': 'evt-42' },
      }),
      makeCtx(['events']),
    );

    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('last-event-id')).toBe('evt-42');
  });

  it('forwards invitation acceptance without a session and without an actor header, even without the secret', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const fetchMock = upstreamFetchMock({ status: 201, body: '{"data":{"principal":{"id":"p-9"}}}' });

    const res = await POST(
      makeRequest('http://localhost:3000/api/collab/v1/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'secret-token', displayName: 'New User', password: 'pw' }),
      }),
      makeCtx(['invitations', 'accept']),
    );

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-fluent-flow-actor')).toBeNull();
  });

  it('still requires a session for every other path when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const fetchMock = upstreamFetchMock();

    const res = await POST(
      makeRequest('http://localhost:3000/api/collab/v1/tasks/t1/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hi', visibility: 'client' }),
      }),
      makeCtx(['tasks', 't1', 'comments']),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches the actor for invitation acceptance when a session exists', async () => {
    const fetchMock = upstreamFetchMock({ status: 201, body: '{"data":{}}' });

    const res = await POST(
      makeRequest('http://localhost:3000/api/collab/v1/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'secret-token' }),
      }),
      makeCtx(['invitations', 'accept']),
    );

    expect(res.status).toBe(201);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-fluent-flow-actor')).toBe(PROXY_SIGNED);
  });

  it('returns 401 when a signed-in session has no principal identity yet', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { id: 5, login: 'legacy', orgs: [], isSuperadmin: false } });
    const fetchMock = upstreamFetchMock();

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/me'), makeCtx(['me']));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams event-stream responses through and preserves safe artifact headers', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"eventId":"e1"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no',
          },
        }),
      ),
    );

    const res = await GET(
      makeRequest('http://localhost:3000/api/collab/v1/events?cursor=c1', {
        headers: { accept: 'text/event-stream' },
      }),
      makeCtx(['events']),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const text = await res.text();
    expect(text).toContain('"e1"');
  });

  it('preserves artifact download headers from upstream', async () => {
    upstreamFetchMock({
      status: 200,
      body: 'binary-ish',
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="spec.pdf"',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    });

    const res = await GET(
      makeRequest('http://localhost:3000/api/collab/v1/artifacts/a1/content'),
      makeCtx(['artifacts', 'a1', 'content']),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="spec.pdf"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('defaults responses to no-store when upstream sets no cache policy', async () => {
    upstreamFetchMock({ body: '{"data":{}}', headers: { 'content-type': 'application/json' } });

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/me'), makeCtx(['me']));

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('propagates client disconnect to the upstream request for streams', async () => {
    const fetchMock = upstreamFetchMock();
    const controller = new AbortController();
    controller.abort();

    await GET(
      makeRequest('http://localhost:3000/api/collab/v1/events', {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      }),
      makeCtx(['events']),
    );

    const upstreamSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(upstreamSignal.aborted).toBe(true);
  });

  it('equips normal requests with an upstream abort signal', async () => {
    const fetchMock = upstreamFetchMock();

    await GET(makeRequest('http://localhost:3000/api/collab/v1/me'), makeCtx(['me']));

    const upstreamSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects dot-dot path segments before any upstream contact', async () => {
    const fetchMock = upstreamFetchMock();

    const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/../../state'), makeCtx(['..', '..', 'state']));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects dot and empty path segments', async () => {
    const fetchMock = upstreamFetchMock();

    for (const segments of [['.'], ['tasks', ''], []]) {
      const res = await GET(makeRequest('http://localhost:3000/api/collab/v1/x'), makeCtx(segments));
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves Retry-After on rate limit responses', async () => {
    upstreamFetchMock({
      status: 429,
      body: '{"error":{"code":"rate_limited","message":"Too many attempts."}}',
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
    });

    const res = await POST(
      makeRequest('http://localhost:3000/api/collab/v1/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 't', displayName: 'x', password: 'y' }),
      }),
      makeCtx(['invitations', 'accept']),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
  });
});
