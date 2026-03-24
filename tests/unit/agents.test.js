import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock fs before importing agents.js
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from 'fs';
import { loadAgents, getAgentConfig, resetAgentsCache } from '../../src/config/agents.js';

const VALID_REGISTRY = `
agents:
  getonit:
    transport: webhook
    url: http://openclaw:18789/hooks/agent
    token_env: OPENCLAW_WEBHOOK_TOKEN
    delivery:
      channel: discord
      to: "channel:123"
  claude-local:
    transport: webhook
    url: http://localhost:8080/wake
    token_env: CLAUDE_LOCAL_TOKEN
  claude-actions:
    transport: workflow_dispatch
    workflow: agent-wake.yml
    ref: main
`;

beforeEach(() => {
  resetAgentsCache();
  vi.clearAllMocks();
});

/** Helper: mock a file that exists with content */
function mockFile(content) {
  existsSync.mockReturnValue(true);
  readFileSync.mockReturnValue(content);
}

describe('loadAgents', () => {
  it('loads and validates agent registry from YAML', () => {
    mockFile(VALID_REGISTRY);
    const registry = loadAgents();
    expect(registry.agents.getonit).toBeDefined();
    expect(registry.agents.getonit.transport).toBe('webhook');
    expect(registry.agents.getonit.url).toBe('http://openclaw:18789/hooks/agent');
    expect(registry.agents.getonit.token_env).toBe('OPENCLAW_WEBHOOK_TOKEN');
  });

  it('caches on subsequent calls', () => {
    mockFile(VALID_REGISTRY);
    loadAgents();
    loadAgents();
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('parses workflow_dispatch transport', () => {
    mockFile(VALID_REGISTRY);
    const registry = loadAgents();
    expect(registry.agents['claude-actions'].transport).toBe('workflow_dispatch');
    expect(registry.agents['claude-actions'].workflow).toBe('agent-wake.yml');
    expect(registry.agents['claude-actions'].ref).toBe('main');
  });

  it('parses delivery config on agents', () => {
    mockFile(VALID_REGISTRY);
    const registry = loadAgents();
    expect(registry.agents.getonit.delivery).toEqual({ channel: 'discord', to: 'channel:123' });
  });

  it('accepts empty agents map', () => {
    mockFile('agents: {}');
    const registry = loadAgents();
    expect(registry.agents).toEqual({});
  });

  it('falls back to empty registry when file missing', () => {
    existsSync.mockReturnValue(false);
    const registry = loadAgents();
    expect(registry.agents).toEqual({});
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('throws on invalid transport type', () => {
    mockFile(`
agents:
  bad:
    transport: carrier_pigeon
    url: http://example.com
`);
    expect(() => loadAgents()).toThrow();
  });
});

describe('getAgentConfig', () => {
  it('returns config for registered agent', () => {
    mockFile(VALID_REGISTRY);
    const config = getAgentConfig('getonit');
    expect(config.transport).toBe('webhook');
    expect(config.url).toBe('http://openclaw:18789/hooks/agent');
    expect(config.token_env).toBe('OPENCLAW_WEBHOOK_TOKEN');
  });

  it('returns null for unregistered agent', () => {
    mockFile(VALID_REGISTRY);
    expect(getAgentConfig('nonexistent')).toBeNull();
  });

  it('returns null when agentId is null/undefined', () => {
    mockFile(VALID_REGISTRY);
    expect(getAgentConfig(null)).toBeNull();
    expect(getAgentConfig(undefined)).toBeNull();
  });
});
