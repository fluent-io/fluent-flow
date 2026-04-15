import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/outbound-queue.js', () => ({
  claimNext: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('tok-install'),
}));

import { claimNext, markSucceeded, markFailed } from '../../src/db/outbound-queue.js';
import { drainOnce } from '../../src/workers/outbound.js';

function makeFetchResponse(status, headers = {}, json = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

const baseRow = {
  id: 1,
  installation_id: 42,
  kind: 'comment',
  payload: { owner: 'acme', repo: 'demo', prNumber: 5, body: 'hello' },
  attempts: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  claimNext.mockResolvedValue(null);
  markSucceeded.mockResolvedValue({});
  markFailed.mockResolvedValue({});
});

describe('drainOnce', () => {
  it('returns false when queue is empty', async () => {
    claimNext.mockResolvedValue(null);
    global.fetch = vi.fn();
    const result = await drainOnce();
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('marks succeeded on 200 response', async () => {
    claimNext.mockResolvedValue({ ...baseRow });
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(200));

    const result = await drainOnce();

    expect(result).toBe(true);
    expect(markSucceeded).toHaveBeenCalledWith(baseRow.id);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('marks failed (non-rate-limited) on 500', async () => {
    claimNext.mockResolvedValue({ ...baseRow });
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(500, {}, { message: 'server error' }));

    await drainOnce();

    expect(markFailed).toHaveBeenCalledWith(
      baseRow.id,
      expect.objectContaining({ rateLimited: false, error: expect.any(String) })
    );
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('marks failed as rate-limited on 429 with Retry-After', async () => {
    claimNext.mockResolvedValue({ ...baseRow });
    global.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(429, { 'retry-after': '10' })
    );

    await drainOnce();

    expect(markFailed).toHaveBeenCalledWith(
      baseRow.id,
      expect.objectContaining({ rateLimited: true })
    );
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('marks failed as rate-limited on 403 with X-RateLimit-Remaining: 0', async () => {
    claimNext.mockResolvedValue({ ...baseRow });
    global.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse(403, { 'x-ratelimit-remaining': '0' })
    );

    await drainOnce();

    expect(markFailed).toHaveBeenCalledWith(
      baseRow.id,
      expect.objectContaining({ rateLimited: true })
    );
  });

  it('dispatches correct HTTP request for kind=comment', async () => {
    claimNext.mockResolvedValue({ ...baseRow, kind: 'comment' });
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(201, {}, { id: 42 }));

    await drainOnce();

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/repos/acme/demo/issues/5/comments');
    expect(opts.method).toBe('POST');
  });

  it('dispatches correct HTTP request for kind=review', async () => {
    claimNext.mockResolvedValue({
      ...baseRow,
      kind: 'review',
      payload: { owner: 'acme', repo: 'demo', prNumber: 5, review: { event: 'APPROVE', body: 'lgtm' } },
    });
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse(200));

    await drainOnce();

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/repos/acme/demo/pulls/5/reviews');
  });
});
