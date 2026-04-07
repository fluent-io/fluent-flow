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

  describe('registerAgent()', () => {
    it('POSTs to /api/agents with MCP auth token', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'test-agent', agent_type: 'claude-code', transport: 'long_poll' }),
      });
      const result = await client.registerAgent({
        mcpAuthToken: 'mcp_secret',
        agentId: 'test-agent',
        agentType: 'claude-code',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/agents',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mcp_secret',
          },
          body: JSON.stringify({
            id: 'test-agent',
            agent_type: 'claude-code',
            transport: 'long_poll',
          }),
        }),
      );
      expect(result).toEqual({ id: 'test-agent', agent_type: 'claude-code', transport: 'long_poll' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      await expect(
        client.registerAgent({ mcpAuthToken: 'bad', agentId: 'x', agentType: 'claude-code' }),
      ).rejects.toThrow('Agent registration failed: 401');
    });
  });

  describe('generateToken()', () => {
    it('POSTs to /api/agents/:id/tokens with MCP auth token', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'ff_newtoken', label: 'auto-host' }),
      });
      const result = await client.generateToken({
        mcpAuthToken: 'mcp_secret',
        agentId: 'test-agent',
        label: 'auto-host',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://flow.example.com/api/agents/test-agent/tokens',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mcp_secret',
          },
          body: JSON.stringify({ label: 'auto-host' }),
        }),
      );
      expect(result).toEqual({ token: 'ff_newtoken', label: 'auto-host' });
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });
      await expect(
        client.generateToken({ mcpAuthToken: 'bad', agentId: 'x' }),
      ).rejects.toThrow('Token generation failed: 403');
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
