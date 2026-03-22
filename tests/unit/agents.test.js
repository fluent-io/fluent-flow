import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing agents.js
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'fs';
import { loadAgents, getAgentConfig, resetAgentsCache } from '../../src/config/agents.js';

const VALID_REGISTRY = `
agents:
  getonit:
    transport: webhook
    url: http://openclaw:18789/hooks/agent
    token_env: OPENCLAW_WEBHOOK_TOKEN
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

describe('loadAgents', () => {
  it('loads and validates agent registry from YAML', () => {
    readFileSync.mockReturnValue(VALID_REGISTRY);
    const registry = loadAgents();
    expect(registry.agents.getonit).toBeDefined();
    expect(registry.agents.getonit.transport).toBe('webhook');
    expect(registry.agents.getonit.url).toBe('http://openclaw:18789/hooks/agent');
    expect(registry.agents.getonit.token_env).toBe('OPENCLAW_WEBHOOK_TOKEN');
  });

  it('caches on subsequent calls', () => {
    readFileSync.mockReturnValue(VALID_REGISTRY);
    loadAgents();
    loadAgents();
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('parses workflow_dispatch transport', () => {
    readFileSync.mockReturnValue(VALID_REGISTRY);
    const registry = loadAgents();
    expect(registry.agents['claude-actions'].transport).toBe('workflow_dispatch');
    expect(registry.agents['claude-actions'].workflow).toBe('agent-wake.yml');
    expect(registry.agents['claude-actions'].ref).toBe('main');
  });

  it('accepts empty agents map', () => {
    readFileSync.mockReturnValue('agents: {}');
    const registry = loadAgents();
    expect(registry.agents).toEqual({});
  });

  it('throws on invalid transport type', () => {
    readFileSync.mockReturnValue(`
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
    readFileSync.mockReturnValue(VALID_REGISTRY);
    const config = getAgentConfig('getonit');
    expect(config).toEqual({
      transport: 'webhook',
      url: 'http://openclaw:18789/hooks/agent',
      token_env: 'OPENCLAW_WEBHOOK_TOKEN',
    });
  });

  it('returns null for unregistered agent', () => {
    readFileSync.mockReturnValue(VALID_REGISTRY);
    expect(getAgentConfig('nonexistent')).toBeNull();
  });

  it('returns null when agentId is null/undefined', () => {
    readFileSync.mockReturnValue(VALID_REGISTRY);
    expect(getAgentConfig(null)).toBeNull();
    expect(getAgentConfig(undefined)).toBeNull();
  });
});
