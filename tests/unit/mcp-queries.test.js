import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildConfig, TEST_REPO_KEY, makeTransitionRecord, makePauseRecord } from '../helpers/mocks.js';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/engine/state-machine.js', () => ({
  getCurrentState: vi.fn(),
  getTransitionHistory: vi.fn(),
}));
vi.mock('../../src/engine/review-manager.js', () => ({ getRetryRecord: vi.fn() }));
vi.mock('../../src/engine/pause-manager.js', () => ({ getActivePause: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn() }));

// Need to import after mocks
import { getCurrentState, getTransitionHistory } from '../../src/engine/state-machine.js';
import { getRetryRecord } from '../../src/engine/review-manager.js';
import { getActivePause } from '../../src/engine/pause-manager.js';
import { resolveConfig } from '../../src/config/loader.js';

// Import the registration function and create a mock server
import { registerQueryTools } from '../../src/mcp/tools/queries.js';

/** Create a mock MCP server that captures tool registrations */
function createMockServer() {
  const tools = new Map();
  return {
    tool: (name, description, schema, handler) => { tools.set(name, { description, schema, handler }); },
    tools,
    call: async (name, args) => tools.get(name).handler(args),
  };
}

let server;

beforeEach(() => {
  vi.clearAllMocks();
  server = createMockServer();
  registerQueryTools(server);
});

describe('MCP query tools', () => {
  it('registers all 5 query tools', () => {
    expect(server.tools.size).toBe(5);
    expect(server.tools.has('get_current_state')).toBe(true);
    expect(server.tools.has('get_transition_history')).toBe(true);
    expect(server.tools.has('get_retry_record')).toBe(true);
    expect(server.tools.has('get_active_pause')).toBe(true);
    expect(server.tools.has('get_config')).toBe(true);
  });

  it('get_current_state returns state', async () => {
    getCurrentState.mockResolvedValue('In Review');
    const result = await server.call('get_current_state', { repo: TEST_REPO_KEY, issue_number: 42, agent_id: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.state).toBe('In Review');
    expect(getCurrentState).toHaveBeenCalledWith(TEST_REPO_KEY, 42);
  });

  it('get_transition_history returns transitions', async () => {
    const transitions = [makeTransitionRecord(), makeTransitionRecord({ id: 2 })];
    getTransitionHistory.mockResolvedValue(transitions);
    const result = await server.call('get_transition_history', { repo: TEST_REPO_KEY, issue_number: 42, agent_id: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.transitions).toHaveLength(2);
  });

  it('get_retry_record returns null when not found', async () => {
    getRetryRecord.mockResolvedValue(null);
    const result = await server.call('get_retry_record', { repo: TEST_REPO_KEY, pr_number: 7, agent_id: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.record).toBeNull();
  });

  it('get_active_pause returns pause data', async () => {
    getActivePause.mockResolvedValue(makePauseRecord());
    const result = await server.call('get_active_pause', { repo: TEST_REPO_KEY, issue_number: 42, agent_id: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pause.reason).toBe('manual');
  });

  it('get_config returns resolved config', async () => {
    resolveConfig.mockResolvedValue(buildConfig());
    const result = await server.call('get_config', { owner: 'test-org', repo: 'test-repo', agent_id: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.config.reviewer.enabled).toBe(true);
  });
});
