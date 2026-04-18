import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listAgents, getAgentDetail, createAgent } = await import('../../src/queries/agents');

describe('listAgents', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns agents with status for given org', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code',
          transport: 'long_poll', transport_meta: {}, repos: ['fluent-io/fluent-flow'],
          created_at: new Date(), updated_at: new Date(),
          status: 'online', last_seen_at: new Date(),
        },
      ],
    });

    const result = await listAgents(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ff-runner');
    expect(result[0].status).toBe('online');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('returns all agents for superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listAgents([]);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });
});

describe('getAgentDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns null when agent not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getAgentDetail(['fluent-io'], 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns agent when found in allowed orgs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code',
        transport: 'long_poll', transport_meta: {}, repos: ['fluent-io/fluent-flow'],
        created_at: new Date(), updated_at: new Date(),
      }],
    });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');
    expect(result?.id).toBe('ff-runner');
  });
});

describe('createAgent', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('inserts an agent row with the provided fields and returns it', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'laptop-1', org_id: 'fluent-io', agent_type: 'claude-code',
        transport: 'long_poll', transport_meta: {}, repos: [],
        created_at: new Date(), updated_at: new Date(),
      }],
    });

    const result = await createAgent({
      id: 'laptop-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
    });

    expect(result.id).toBe('laptop-1');
    expect(result.org_id).toBe('fluent-io');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO agents');
    expect(params).toEqual(['laptop-1', 'fluent-io', 'claude-code', 'long_poll', {}, []]);
  });

  it('accepts optional transportMeta and repos', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'x', org_id: 'o', agent_type: 'claude-code', transport: 'long_poll',
        transport_meta: { foo: 1 }, repos: ['o/a'], created_at: new Date(), updated_at: new Date(),
      }],
    });

    await createAgent({
      id: 'x', orgId: 'o', agentType: 'claude-code', transport: 'long_poll',
      transportMeta: { foo: 1 }, repos: ['o/a'],
    });

    expect(mockQuery.mock.calls[0][1]).toEqual(['x', 'o', 'claude-code', 'long_poll', { foo: 1 }, ['o/a']]);
  });
});
