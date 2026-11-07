import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/agents/claim-manager.js', () => ({ createClaim: vi.fn() }));

import { createClaim } from '../../src/agents/claim-manager.js';
import { registerTaskTools } from '../../src/mcp/tools/tasks.js';

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
  createClaim.mockResolvedValue({ id: 1, status: 'pending', claim_type: 'spec' });
  server = createMockServer();
  registerTaskTools(server);
});

describe('trigger_task MCP tool', () => {
  it('registers the trigger_task tool', () => {
    expect(server.tools.has('trigger_task')).toBe(true);
  });

  it('declares verify and legacy test_verify in the claim_type schema', () => {
    const schema = server.tools.get('trigger_task').schema;
    expect(schema.claim_type.safeParse('verify').success).toBe(true);
    expect(schema.claim_type.safeParse('test_verify').success).toBe(true);
  });

  it('creates a claim with the specified claim_type', async () => {
    const result = await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'spec',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'self-hosted',
        repo: 'fluent-io/fluent-flow',
        prNumber: 42,
        claimType: 'spec',
      }),
    );
  });

  it('creates a verify claim for the red/green verification chain', async () => {
    const result = await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'verify',
      payload: { phase: 'red' },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'self-hosted',
        repo: 'fluent-io/fluent-flow',
        prNumber: 42,
        claimType: 'verify',
        payload: { phase: 'red' },
      }),
    );
  });

  it('passes attempt through to createClaim', async () => {
    await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'build',
      attempt: 3,
    });

    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3 }),
    );
  });

  it('passes optional payload through', async () => {
    await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'spec',
      payload: { message: 'Create a plan for feature X' },
    });

    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ message: 'Create a plan for feature X' }),
      }),
    );
  });

  it('returns error when createClaim fails', async () => {
    createClaim.mockRejectedValue(new Error('DB error'));
    const result = await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'spec',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('audits the tool call', async () => {
    const { audit } = await import('../../src/db/client.js');
    await server.call('trigger_task', {
      org_id: 'self-hosted',
      repo: 'fluent-io/fluent-flow',
      pr_number: 42,
      claim_type: 'spec',
    });

    expect(audit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      data: expect.objectContaining({ tool: 'trigger_task', claim_type: 'spec' }),
    }));
  });
});
