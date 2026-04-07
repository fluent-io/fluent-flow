import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/credentials.js', () => ({
  getAgentCredentials: vi.fn(),
  setAgentCredentials: vi.fn(),
}));
vi.mock('../../src/bootstrap.js', () => ({ bootstrap: vi.fn() }));

import { resolveToken } from '../../src/resolve-token.js';
import { getAgentCredentials, setAgentCredentials } from '../../src/credentials.js';
import { bootstrap } from '../../src/bootstrap.js';

describe('resolveToken', () => {
  let log;

  beforeEach(() => {
    vi.clearAllMocks();
    log = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  it('returns explicit token for backward compat', async () => {
    const token = await resolveToken({ token: 'ff_explicit' }, log);
    expect(token).toBe('ff_explicit');
  });

  it('returns saved credentials when server matches', async () => {
    getAgentCredentials.mockReturnValue({ token: 'ff_saved', server: 'https://flow.example.com' });

    const token = await resolveToken(
      { agent: 'my-agent', server: 'https://flow.example.com' },
      log,
    );

    expect(token).toBe('ff_saved');
    expect(log.info).toHaveBeenCalledWith('Using saved credentials', { agent: 'my-agent' });
  });

  it('logs mismatch and bootstraps when server differs', async () => {
    getAgentCredentials.mockReturnValue({ token: 'ff_saved', server: 'https://old.example.com' });
    bootstrap.mockResolvedValue({ token: 'ff_new' });

    const token = await resolveToken(
      { agent: 'my-agent', server: 'https://new.example.com', mcpAuthToken: 'mcp_secret_long' },
      log,
    );

    expect(token).toBe('ff_new');
    expect(log.info).toHaveBeenCalledWith('Server mismatch for agent, re-authenticating', { agent: 'my-agent' });
    expect(bootstrap).toHaveBeenCalled();
  });

  it('bootstraps when no saved credentials exist', async () => {
    getAgentCredentials.mockReturnValue(null);
    bootstrap.mockResolvedValue({ token: 'ff_bootstrapped' });

    const token = await resolveToken(
      { agent: 'my-agent', server: 'https://flow.example.com', mcpAuthToken: 'mcp_secret_long' },
      log,
    );

    expect(token).toBe('ff_bootstrapped');
    expect(bootstrap).toHaveBeenCalledWith({
      server: 'https://flow.example.com',
      agentId: 'my-agent',
      mcpAuthToken: 'mcp_secret_long',
    });
    expect(setAgentCredentials).toHaveBeenCalledWith('my-agent', {
      token: 'ff_bootstrapped',
      server: 'https://flow.example.com',
    });
  });

  it('throws when no saved credentials and no MCP_AUTH_TOKEN', async () => {
    getAgentCredentials.mockReturnValue(null);
    const origEnv = process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN;

    await expect(
      resolveToken({ agent: 'my-agent', server: 'https://flow.example.com' }, log),
    ).rejects.toThrow('No saved credentials');

    if (origEnv !== undefined) process.env.MCP_AUTH_TOKEN = origEnv;
  });

  it('uses MCP_AUTH_TOKEN env var as fallback', async () => {
    getAgentCredentials.mockReturnValue(null);
    bootstrap.mockResolvedValue({ token: 'ff_env' });
    const origEnv = process.env.MCP_AUTH_TOKEN;
    process.env.MCP_AUTH_TOKEN = 'env_mcp_secret_long';

    const token = await resolveToken(
      { agent: 'my-agent', server: 'https://flow.example.com' },
      log,
    );

    expect(token).toBe('ff_env');
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAuthToken: 'env_mcp_secret_long' }),
    );

    if (origEnv !== undefined) process.env.MCP_AUTH_TOKEN = origEnv;
    else delete process.env.MCP_AUTH_TOKEN;
  });

  it('sanitizes URLs from bootstrap error messages', async () => {
    getAgentCredentials.mockReturnValue(null);
    bootstrap.mockRejectedValue(new Error('Connection refused to https://secret.internal:8080'));

    await expect(
      resolveToken(
        { agent: 'my-agent', server: 'https://flow.example.com', mcpAuthToken: 'mcp_secret_long' },
        log,
      ),
    ).rejects.toThrow('Bootstrap failed for agent "my-agent"');

    try {
      await resolveToken(
        { agent: 'my-agent', server: 'https://flow.example.com', mcpAuthToken: 'mcp_secret_long' },
        log,
      );
    } catch (err) {
      expect(err.message).not.toContain('secret.internal');
    }
  });
});
