import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { collabFetch, collabFetchAll, ApiError } = await import('../../src/lib/collab/api');

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('collabFetch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the success envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: { id: 't1' } })));

    const result = await collabFetch<{ id: string }>('/tasks/t1');

    expect(result.data).toEqual({ id: 't1' });
  });

  it('requests the fixed collab prefix with no caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await collabFetch('/tasks?workspaceId=w1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/collab/v1/tasks?workspaceId=w1');
    expect(init.cache).toBe('no-store');
  });

  it('sends JSON bodies and the idempotency key when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await collabFetch('/tasks/t1/runs', {
      method: 'POST',
      body: { expectedVersion: 3 },
      idempotencyKey: 'start-key-1',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('start-key-1');
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 3 });
  });

  it('throws ApiError with the upstream code, status, message and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          error: { code: 'insufficient_capability', message: 'You do not have permission to perform this action.', requestId: 'req-9' },
        }),
      ),
    );

    await expect(collabFetch('/tasks/t1/runs', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_capability',
      message: 'You do not have permission to perform this action.',
      requestId: 'req-9',
    });
    await expect(
      collabFetch('/tasks/t1/runs', { method: 'POST', body: {} }).catch((e) => Promise.reject(e)),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('carries currentVersion from authorized version conflicts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'version_conflict', message: 'This item changed. Refresh before saving.', requestId: 'req-2' },
          currentVersion: 7,
        }),
      ),
    );

    const error = await collabFetch('/tasks/t1', { method: 'PATCH', body: {} }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.currentVersion).toBe(7);
  });

  it('maps malformed upstream payloads to a generic request failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 })),
    );

    await expect(collabFetch('/me')).rejects.toMatchObject({
      status: 502,
      code: 'unexpected_response',
    });
  });

  it('treats 204 no-content as a successful empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const result = await collabFetch('/workspaces/w1/members/p1', { method: 'DELETE' });

    expect(result.data).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it('preserves the final timeline watermark after a page has no next page', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(jsonResponse(200,{data:[{eventId:'new-event'}],nextCursor:null,cursor:'ingestion-watermark'})));
    const result=await collabFetch('/sessions/session/timeline');
    expect(result.cursor).toBe('ingestion-watermark');
    expect(result.nextCursor).toBeNull();
  });

  it('traverses every cursor page and returns the concatenated list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 't1' }], nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 't2' }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await collabFetchAll<{ id: string }>('/tasks');

    expect(result.data.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(result.truncated).toBe(false);
    const second = fetchMock.mock.calls[1];
    expect(String(second[0])).toContain('cursor=cur-1');
  });

  it('reports truncation when the safety bound is reached before the list ends', async () => {
    const page = { data: [{ id: 'x' }], nextCursor: 'more' };
    const fetchMock = vi.fn();
    for (let i = 0; i < 21; i += 1) fetchMock.mockResolvedValueOnce(jsonResponse(200, page));
    vi.stubGlobal('fetch', fetchMock);

    const result = await collabFetchAll<{ id: string }>('/tasks');

    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});
