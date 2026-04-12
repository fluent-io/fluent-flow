import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listAgents, getAgentDetail } = await import('../../src/queries/agents');

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
