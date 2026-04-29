import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '../../src/client.js';

describe('client', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = createClient({
      serverUrl: 'https://flow.example.com',
      token: 'ff_testtoken',
      fetch: fetchMock,
    });
  });

  describe('register()', () => {
    it('POSTs to /api/runner/register with meta and auth header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, session_id: 42, status: 'online' }),
      });
      const result = await client.register({ hostname: 'dev', os: 'linux' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/register',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ff_testtoken',
          },
          body: JSON.stringify({ meta: { hostname: 'dev', os: 'linux' } }),
        })
      );
      expect(result).toEqual({ ok: true, session_id: 42, status: 'online' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });
      await expect(client.register({})).rejects.toThrow('Register failed: 403');
    });
  });

  describe('poll()', () => {
    it('POSTs to /api/runner/poll with session_id', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ work: { event: 'review_failed', message: 'fix it' } }),
      });
      const result = await client.poll(42);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/poll',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ session_id: 42 }),
        })
      );
      expect(result).toEqual({ event: 'review_failed', message: 'fix it' });
    });

    it('returns null when work is null', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ work: null }),
      });
      const result = await client.poll(42);
      expect(result).toBeNull();
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });
      await expect(client.poll(42)).rejects.toThrow('Poll failed: 500');
    });
  });

  describe('reportClaim()', () => {
    it('POSTs to /api/runner/claim with claim data', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, claim_id: 1, status: 'completed' }),
      });
      const result = await client.reportClaim({
        status: 'completed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/runner/claim',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'completed', repo: 'org/repo', pr_number: 7, attempt: 1 }),
        })
      );
      expect(result).toEqual({ ok: true, claim_id: 1, status: 'completed' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });
      await expect(client.reportClaim({ status: 'failed', repo: 'x/y', pr_number: 1, attempt: 1 }))
        .rejects.toThrow('Claim report failed: 404');
    });
  });

  describe('timeout / network errors', () => {
    it('throws with label and timeout duration on abort (timeout)', async () => {
      // Mock fetch to hang until aborted by the internal AbortController signal
      fetchMock.mockImplementationOnce((_url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        })
      );
      vi.useFakeTimers();
      const p = client.register({ hostname: 'dev' });
      // Prevent unhandled rejection while advancing timers
      p.catch(() => {});
      // Advance past the 35_000ms timeout so the AbortController fires
      await vi.advanceTimersByTimeAsync(40_000);
      try {
        await p;
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.message).toMatch(/Register request failed after 35000ms/);
      }
      vi.useRealTimers();
    });

    it('throws without timeout duration on non-timeout fetch error', async () => {
      const connErr = new TypeError('fetch failed');
      connErr.cause = new Error('ECONNREFUSED');
      fetchMock.mockRejectedValueOnce(connErr);
      try {
        await client.register({ hostname: 'dev' });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.message).toMatch(/Register request failed/);
        expect(e.message).not.toMatch(/after \d+ms/);
      }
    });
  });

  describe('URL normalization', () => {
    it('strips trailing slash from serverUrl', async () => {
      const c = createClient({ serverUrl: 'https://flow.example.com/', token: 't', fetch: fetchMock });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, session_id: 1, status: 'online' }) });
      await c.register({});
      expect(fetchMock.mock.calls[0][0]).toBe('https://flow.example.com/api/runner/register');
    });
  });
});
