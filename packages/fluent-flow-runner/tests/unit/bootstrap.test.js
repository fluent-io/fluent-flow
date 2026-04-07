import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';

// Mock os.hostname for label generation
vi.mock('node:os', () => ({
  hostname: () => 'testhost',
}));

describe('bootstrap', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('registers agent and generates token', async () => {
    // POST /api/agents → returns agent
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'my-agent', agent_type: 'claude-code', transport: 'long_poll' }),
    });
    // POST /api/agents/:id/tokens → returns token
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_generated_token', label: 'auto-testhost' }),
    });

    const result = await bootstrap({
      server: 'https://flow.example.com',
      agentId: 'my-agent',
      mcpAuthToken: 'mcp_secret',
      agentType: 'claude-code',
      fetch: fetchMock,
    });

    expect(result).toEqual({ token: 'ff_generated_token' });

    // First call: register agent
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://flow.example.com/api/agents',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mcp_secret',
        },
        body: JSON.stringify({
          id: 'my-agent',
          agent_type: 'claude-code',
          transport: 'long_poll',
        }),
      }),
    );

    // Second call: generate token
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://flow.example.com/api/agents/my-agent/tokens',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mcp_secret',
        },
        body: JSON.stringify({ label: 'auto-testhost' }),
      }),
    );
  });

  it('defaults agent_type to claude-code when not provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'test', agent_type: 'claude-code', transport: 'long_poll' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_tok', label: 'auto-testhost' }),
    });

    await bootstrap({
      server: 'https://flow.example.com',
      agentId: 'test',
      mcpAuthToken: 'secret',
      fetch: fetchMock,
    });

    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody.agent_type).toBe('claude-code');
  });

  it('throws if agent registration fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(
      bootstrap({
        server: 'https://flow.example.com',
        agentId: 'bad-agent',
        mcpAuthToken: 'bad-token',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('Agent registration failed: 403');
  });

  it('throws if token generation fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'my-agent', agent_type: 'claude-code' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    });

    await expect(
      bootstrap({
        server: 'https://flow.example.com',
        agentId: 'my-agent',
        mcpAuthToken: 'secret',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('Token generation failed: 500');
  });

  it('strips trailing slash from server URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'x', agent_type: 'claude-code' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_tok', label: 'auto-testhost' }),
    });

    await bootstrap({
      server: 'https://flow.example.com/',
      agentId: 'x',
      mcpAuthToken: 'secret',
      fetch: fetchMock,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://flow.example.com/api/agents');
    expect(fetchMock.mock.calls[1][0]).toBe('https://flow.example.com/api/agents/x/tokens');
  });
});
