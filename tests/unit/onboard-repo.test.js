import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTransitionRecord, makePauseRecord } from '../helpers/mocks.js';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn(), invalidateConfig: vi.fn() }));
vi.mock('../../src/engine/state-machine.js', () => ({ executeTransition: vi.fn(), getCurrentState: vi.fn() }));
vi.mock('../../src/engine/review-manager.js', () => ({ dispatchReview: vi.fn() }));
vi.mock('../../src/engine/pause-manager.js', () => ({ recordPause: vi.fn(), processResume: vi.fn() }));
vi.mock('../../src/github/rest.js', () => ({
  postComment: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getFileExists: vi.fn(),
  createFile: vi.fn(),
}));
vi.mock('../../src/github/graphql.js', () => ({ moveProjectItem: vi.fn(), findProjectItem: vi.fn() }));
vi.mock('../../src/notifications/dispatcher.js', () => ({ notifyPause: vi.fn(), notifyResume: vi.fn(), notifyReviewFailure: vi.fn() }));

import { getFileExists, createFile } from '../../src/github/rest.js';
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

  it('returns error if repo is already onboarded', async () => {
    getFileExists.mockResolvedValue(true);

    const result = await server.call('onboard_repo', {
      owner: 'test-org',
      repo: 'test-repo',
      default_agent: 'my-agent',
      agent_id: 'my-agent',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('already onboarded');
    expect(createFile).not.toHaveBeenCalled();
  });

  it('creates config and workflow files on success', async () => {
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

    // Should check if file exists first
    expect(getFileExists).toHaveBeenCalledWith('test-org', 'test-repo', '.github/fluent-flow.yml');

    // Should create fluent-flow.yml
    expect(createFile).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      '.github/fluent-flow.yml',
      expect.stringContaining('default_agent: "my-agent"'),
      'chore: onboard to Fluent Flow',
    );

    // Should create workflow file
    expect(createFile).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      '.github/workflows/pr-review.yml',
      expect.stringContaining('uses: fluent-io/fluent-flow/.github/workflows/pr-review.yml@main'),
      'chore: onboard to Fluent Flow',
    );

    // Should invalidate config cache
    expect(invalidateConfig).toHaveBeenCalledWith('test-org', 'test-repo');

    // Should mention required secrets
    expect(parsed.message).toContain('ANTHROPIC_API_KEY');
    expect(parsed.message).toContain('FLUENT_FLOW_URL');
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
    expect(configCall[3]).toContain('project_id: "PVT_abc123"');
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
