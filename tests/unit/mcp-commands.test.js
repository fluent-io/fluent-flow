import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTransitionRecord, makePauseRecord } from '../helpers/mocks.js';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn() }));
vi.mock('../../src/engine/state-machine.js', () => ({ executeTransition: vi.fn(), getCurrentState: vi.fn() }));
vi.mock('../../src/engine/review-manager.js', () => ({ dispatchReview: vi.fn() }));
vi.mock('../../src/engine/pause-manager.js', () => ({ recordPause: vi.fn(), processResume: vi.fn() }));
vi.mock('../../src/github/rest.js', () => ({ postComment: vi.fn(), addLabel: vi.fn(), removeLabel: vi.fn(), dispatchWorkflow: vi.fn() }));
vi.mock('../../src/github/graphql.js', () => ({ moveProjectItem: vi.fn(), findProjectItem: vi.fn() }));
vi.mock('../../src/notifications/dispatcher.js', () => ({ notifyPause: vi.fn(), notifyResume: vi.fn(), notifyReviewFailure: vi.fn() }));

import { executeTransition } from '../../src/engine/state-machine.js';
import { dispatchReview } from '../../src/engine/review-manager.js';
import { recordPause, processResume } from '../../src/engine/pause-manager.js';
import { registerCommandTools } from '../../src/mcp/tools/commands.js';

function createMockServer() {
  const tools = new Map();
  return {
    tool: (name, description, schema, handler) => { tools.set(name, { handler }); },
    tools,
    call: async (name, args) => tools.get(name).handler(args),
  };
}

let server;

beforeEach(() => {
  vi.clearAllMocks();
  server = createMockServer();
  registerCommandTools(server);
});

describe('MCP command tools', () => {
  it('registers all 4 command tools', () => {
    expect(server.tools.size).toBe(4);
    expect(server.tools.has('execute_transition')).toBe(true);
    expect(server.tools.has('dispatch_review')).toBe(true);
    expect(server.tools.has('record_pause')).toBe(true);
    expect(server.tools.has('process_resume')).toBe(true);
  });

  it('execute_transition calls engine and returns result', async () => {
    executeTransition.mockResolvedValue({ fromState: 'Backlog', toState: 'Ready', transition: makeTransitionRecord() });
    const result = await server.call('execute_transition', {
      owner: 'org', repo: 'repo', issue_number: 42, to_state: 'Ready', agent_id: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.from_state).toBe('Backlog');
    expect(executeTransition).toHaveBeenCalledWith(expect.objectContaining({ triggerType: 'mcp' }));
  });

  it('execute_transition returns error for invalid transition', async () => {
    const err = new Error('Invalid transition');
    err.code = 'INVALID_TRANSITION';
    executeTransition.mockRejectedValue(err);
    const result = await server.call('execute_transition', {
      owner: 'org', repo: 'repo', issue_number: 42, to_state: 'Done', agent_id: 'test',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('INVALID_TRANSITION');
  });

  it('dispatch_review dispatches workflow', async () => {
    dispatchReview.mockResolvedValue(undefined);
    const result = await server.call('dispatch_review', {
      owner: 'org', repo: 'repo', pr_number: 7, agent_id: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 7 }));
  });

  it('record_pause creates pause and returns id', async () => {
    recordPause.mockResolvedValue(makePauseRecord({ id: 99 }));
    const result = await server.call('record_pause', {
      owner: 'org', repo: 'repo', issue_number: 42, reason: 'agent-stuck', agent_id: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.pause_id).toBe(99);
  });

  it('process_resume returns target state', async () => {
    processResume.mockResolvedValue({ pause: makePauseRecord(), targetState: 'In Review' });
    const result = await server.call('process_resume', {
      owner: 'org', repo: 'repo', issue_number: 42, agent_id: 'test', to_state: 'In Review',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.target_state).toBe('In Review');
  });

  it('process_resume returns error for no active pause', async () => {
    const err = new Error('No active pause');
    err.code = 'NO_ACTIVE_PAUSE';
    processResume.mockRejectedValue(err);
    const result = await server.call('process_resume', {
      owner: 'org', repo: 'repo', issue_number: 42, agent_id: 'test',
    });
    expect(result.isError).toBe(true);
  });
});
