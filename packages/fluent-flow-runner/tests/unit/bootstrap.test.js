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
        body: expect.stringMatching(/"label":"auto-testhost-[a-z0-9]+"/),
      }),
    );
  });

  it('throws when agentType is not provided and no FLUENT_FLOW_AGENT_TYPE env var', async () => {
    const origEnv = process.env.FLUENT_FLOW_AGENT_TYPE;
    delete process.env.FLUENT_FLOW_AGENT_TYPE;

    try {
      await expect(bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: 'secret_value_here',
        fetch: fetchMock,
      })).rejects.toThrow(/agentType/);
      // Must fail before hitting the network.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (origEnv !== undefined) process.env.FLUENT_FLOW_AGENT_TYPE = origEnv;
    }
  });

  it('uses FLUENT_FLOW_AGENT_TYPE env var when agentType not provided', async () => {
    const origEnv = process.env.FLUENT_FLOW_AGENT_TYPE;
    process.env.FLUENT_FLOW_AGENT_TYPE = 'copilot';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'test', agent_type: 'copilot', transport: 'long_poll' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_tok', label: 'auto-testhost' }),
    });

    await bootstrap({
      server: 'https://flow.example.com',
      agentId: 'test',
      mcpAuthToken: 'secret_value_here',
      fetch: fetchMock,
    });

    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody.agent_type).toBe('copilot');

    if (origEnv !== undefined) process.env.FLUENT_FLOW_AGENT_TYPE = origEnv;
    else delete process.env.FLUENT_FLOW_AGENT_TYPE;
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
        mcpAuthToken: 'bad-token-value',
        fetch: fetchMock,
        agentType: 'claude-code',
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
        mcpAuthToken: 'secret_value_here',
        fetch: fetchMock,
        agentType: 'claude-code',
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
      mcpAuthToken: 'secret_value_here',
      fetch: fetchMock,
      agentType: 'claude-code',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://flow.example.com/api/agents');
    expect(fetchMock.mock.calls[1][0]).toBe('https://flow.example.com/api/agents/x/tokens');
  });

  it('throws if mcpAuthToken is empty', async () => {
    await expect(
      bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: '',
        fetch: fetchMock,
        agentType: 'claude-code',
      }),
    ).rejects.toThrow('MCP_AUTH_TOKEN is required');
  });

  it('throws if mcpAuthToken is too short', async () => {
    await expect(
      bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: 'short',
        fetch: fetchMock,
        agentType: 'claude-code',
      }),
    ).rejects.toThrow('MCP_AUTH_TOKEN must be at least 8 characters');
  });

  it('does not include response body in error messages', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error with sensitive token=abc123',
    });

    try {
      await bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: 'valid_long_token',
        fetch: fetchMock,
        agentType: 'claude-code',
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err.message).toBe('Agent registration failed: 500');
      expect(err.message).not.toContain('sensitive');
      expect(err.message).not.toContain('abc123');
    }
  });

  it('does not expose MCP_AUTH_TOKEN value in error messages', async () => {
    const secretToken = 'super_secret_mcp_token_123';
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => `Unauthorized: ${secretToken}`,
    });

    try {
      await bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: secretToken,
        fetch: fetchMock,
        agentType: 'claude-code',
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err.message).not.toContain(secretToken);
    }
  });

  it('encodes agentId with special characters in URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'my agent', agent_type: 'claude-code' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_tok', label: 'auto-testhost' }),
    });

    await bootstrap({
      server: 'https://flow.example.com',
      agentId: 'my agent',
      mcpAuthToken: 'valid_long_token',
      fetch: fetchMock,
      agentType: 'claude-code',
    });

    expect(fetchMock.mock.calls[1][0]).toBe('https://flow.example.com/api/agents/my%20agent/tokens');
  });

  it('treats 409 Conflict as success for idempotent registration', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => 'Agent already exists',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ff_generated_token', label: 'auto-testhost' }),
    });

    const result = await bootstrap({
      server: 'https://flow.example.com',
      agentId: 'existing-agent',
      mcpAuthToken: 'valid_long_token',
      fetch: fetchMock,
      agentType: 'claude-code',
    });

    expect(result).toEqual({ token: 'ff_generated_token' });
    // Token generation should still be called
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not include response body in token generation errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'test', agent_type: 'claude-code' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable: db connection failed at 10.0.0.5',
    });

    try {
      await bootstrap({
        server: 'https://flow.example.com',
        agentId: 'test',
        mcpAuthToken: 'valid_long_token',
        fetch: fetchMock,
        agentType: 'claude-code',
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err.message).toBe('Token generation failed: 503');
      expect(err.message).not.toContain('10.0.0.5');
    }
  });
});
