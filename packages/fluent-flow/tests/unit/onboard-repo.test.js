import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTransitionRecord, makePauseRecord } from '../helpers/mocks.js';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn(), invalidateConfig: vi.fn(), resolveOrgId: vi.fn().mockResolvedValue('self-hosted') }));
vi.mock('../../src/engine/state-machine.js', () => ({ executeTransition: vi.fn(), getCurrentState: vi.fn() }));
vi.mock('../../src/engine/review-manager.js', () => ({ dispatchReview: vi.fn() }));
vi.mock('../../src/engine/pause-manager.js', () => ({ recordPause: vi.fn(), processResume: vi.fn() }));
vi.mock('../../src/providers/github/rest.js', () => ({
  postComment: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getFileExists: vi.fn(),
  createFile: vi.fn(),
}));
vi.mock('../../src/providers/github/graphql.js', () => ({ moveProjectItem: vi.fn(), findProjectItem: vi.fn() }));
vi.mock('../../src/notifications/dispatcher.js', () => ({ notifyPause: vi.fn(), notifyResume: vi.fn(), notifyReviewFailure: vi.fn() }));

import { getFileExists, createFile } from '../../src/providers/github/rest.js';
import { invalidateConfig } from '../../src/config/loader.js';
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

describe('onboard_repo tool', () => {
  it('is registered as a command tool', () => {
    expect(server.tools.has('onboard_repo')).toBe(true);
  });

  it('returns error if config already exists', async () => {
    getFileExists.mockImplementation((o, r, path) =>
      Promise.resolve(path === '.github/fluent-flow.yml')
    );

    const result = await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('ALREADY_ONBOARDED');
    expect(createFile).not.toHaveBeenCalled();
  });

  it('checks only the fluent-flow.yml config path (no more per-repo workflow file)', async () => {
    getFileExists.mockResolvedValue(false);
    createFile.mockResolvedValue({});
    invalidateConfig.mockResolvedValue(undefined);

    await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
    });

    expect(getFileExists).toHaveBeenCalledTimes(1);
    expect(getFileExists).toHaveBeenCalledWith('test-org', 'test-repo', '.github/fluent-flow.yml');
  });

  it('creates only the config file on success (no workflow file, no API-key reminder)', async () => {
    getFileExists.mockResolvedValue(false);
    createFile.mockResolvedValue({});
    invalidateConfig.mockResolvedValue(undefined);

    const result = await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    // Creates fluent-flow.yml with valid YAML.
    expect(createFile).toHaveBeenCalledTimes(1);
    expect(createFile).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      '.github/fluent-flow.yml',
      expect.stringContaining('default_agent: my-agent'),
      'chore: onboard to Fluent Flow',
    );

    // Cache invalidated so next resolveConfig picks up the new file.
    expect(invalidateConfig).toHaveBeenCalledWith('test-org', 'test-repo');

    // No secret reminder — the harness on the user's runner has its own creds.
    expect(parsed.message).not.toContain('ANTHROPIC_API_KEY');
    expect(parsed.message).not.toContain('FLUENT_FLOW_URL');
  });

  it('includes project_id in config when provided', async () => {
    getFileExists.mockResolvedValue(false);
    createFile.mockResolvedValue({});
    invalidateConfig.mockResolvedValue(undefined);

    const result = await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
      project_id: 'PVT_abc123',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    // The config file should include project_id
    const configCall = createFile.mock.calls.find(c => c[2] === '.github/fluent-flow.yml');
    expect(configCall[3]).toContain('project_id: PVT_abc123');
  });

  it('safely handles special characters in agent name', async () => {
    getFileExists.mockResolvedValue(false);
    createFile.mockResolvedValue({});
    invalidateConfig.mockResolvedValue(undefined);

    await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'agent "with quotes"\nand: newlines',
      agent_id: 'my-agent',
    });

    const configCall = createFile.mock.calls.find(c => c[2] === '.github/fluent-flow.yml');
    // js-yaml should safely quote/escape the value
    expect(configCall[3]).not.toContain('\nand: newlines');
  });

  it('does not include project_id when not provided', async () => {
    getFileExists.mockResolvedValue(false);
    createFile.mockResolvedValue({});
    invalidateConfig.mockResolvedValue(undefined);

    await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
    });

    const configCall = createFile.mock.calls.find(c => c[2] === '.github/fluent-flow.yml');
    expect(configCall[3]).not.toContain('project_id');
  });
});
