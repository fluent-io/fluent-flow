import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentWithEnrollment } from '../../src/queries/index';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

vi.mock('../../src/pool', () => ({
  getPool: () => ({ connect: () => mockConnect() }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listAgents, getAgentDetail, createAgent } = await import('../../src/queries/agents');
const { SESSION_STATUS_AT_READ_TIME } = await import('../../src/queries/_helpers');


function normalizedSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ff-runner',
    org_id: 'fluent-io',
    agent_type: 'claude-code',
    transport: 'long_poll',
    transport_meta: {},
    repos: [],
    created_at: new Date('2026-11-08T12:00:00.000Z'),
    updated_at: new Date('2026-11-08T12:00:00.000Z'),
    status: 'online',
    last_seen_at: new Date('2026-11-08T12:05:00.000Z'),
    deployment: 'local',
    capacity: 2,
    active_slots: 1,
    ...overrides,
  };
}

function transactionCommands() {
  return mockClientQuery.mock.calls.map(([text]) => normalizedSql(text)).filter((sql) =>
    ['begin', 'commit', 'rollback'].includes(sql),
  );
}
describe('listAgents', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns agents with status for given org', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        agentRow({ repos: ['fluent-io/fluent-flow'] }),
      ],
    });

    const result = await listAgents(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ff-runner');
    expect(result[0].status).toBe('online');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('returns no agents for empty-org non-superadmin without querying', async () => {
    const result = await listAgents([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns all agents for explicit superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listAgents([], true);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });

  it('computes status at read time via the shared SESSION_STATUS_AT_READ_TIME fragment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io']);

    const sql = mockQuery.mock.calls[0][0] as string;
    // Drift guard: the query must use the shared constant so new display
    // queries can't silently inline their own version of the CASE.
    expect(sql).toContain(SESSION_STATUS_AT_READ_TIME);
    // Shape guard: the constant itself must still encode the TTL downgrade.
    expect(SESSION_STATUS_AT_READ_TIME).toContain('CASE');
    expect(SESSION_STATUS_AT_READ_TIME).toContain(`status <> 'offline' AND expires_at > NOW()`);
    expect(SESSION_STATUS_AT_READ_TIME).toContain(`ELSE 'offline'`);
  });

  it('maps live slot aggregates onto the list DTO', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        agentRow({ id: 'busy-box', status: 'busy', deployment: 'self_hosted', capacity: 4, active_slots: 3 }),
        agentRow({ id: 'idle-box', status: 'online', deployment: 'local', capacity: 2, active_slots: 1 }),
        agentRow({ id: 'hosted-box', status: 'online', deployment: 'hosted', capacity: 8, active_slots: 2 }),
        agentRow({
          id: 'gone-box',
          status: 'offline',
          deployment: null,
          capacity: null,
          active_slots: 0,
          last_seen_at: null,
        }),
      ],
    });

    const result = await listAgents(['fluent-io']);

    expect(result.map(({ id, status, deployment, capacity, active_slots }) => (
      { id, status, deployment, capacity, active_slots }
    ))).toEqual([
      { id: 'busy-box', status: 'busy', deployment: 'self_hosted', capacity: 4, active_slots: 3 },
      { id: 'idle-box', status: 'online', deployment: 'local', capacity: 2, active_slots: 1 },
      { id: 'hosted-box', status: 'online', deployment: 'hosted', capacity: 8, active_slots: 2 },
      { id: 'gone-box', status: 'offline', deployment: null, capacity: null, active_slots: 0 },
    ]);
  });

  it.each([
    { deployment: 'cloud' },
    { capacity: 1.5 },
    { active_slots: -1 },
    { active_slots: null },
  ])('fails loudly when an aggregate column violates the DTO contract: %j', async (override) => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow(override)] });

    await expect(listAgents(['fluent-io'])).rejects.toThrow();
  });

  it('aggregates every agent in a single query instead of querying per agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [agentRow({ id: 'a' }), agentRow({ id: 'b' }), agentRow({ id: 'c' })],
    });

    const result = await listAgents(['fluent-io']);

    expect(result).toHaveLength(3);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('projects active_slots, capacity and deployment from the aggregate', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io']);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/\bas active_slots\b/);
    expect(sql).toMatch(/\bas capacity\b/);
    expect(sql).toMatch(/\bas deployment\b/);
  });

  it('uses exactly one lateral aggregate scoped to the agent and its organization', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io']);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql.match(/join lateral/g)).toHaveLength(1);
    expect(sql).toContain('from agent_sessions');
    expect(sql).toContain('agent_id = a.id and org_id = a.org_id');
  });

  it('counts slots and derives busy and online using the shared read-time TTL fragment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io']);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toContain(normalizedSql(SESSION_STATUS_AT_READ_TIME));
    expect(sql).toContain(`'busy'`);
    expect(sql).toContain(`'online'`);
    expect(sql).toContain(`'offline'`);
    expect(sql).toMatch(/count\(/);
  });

  it('falls back from live session metadata to configured transport metadata for capacity and deployment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io']);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('coalesce(');
    expect(sql).toMatch(/session_meta\s*(?:->>|->|#>>|#>)\s*'\{?capacity\}?'/);
    expect(sql).toMatch(/transport_meta\s*(?:->>|->|#>>|#>)\s*'\{?capacity\}?'/);
    expect(sql).toMatch(/session_meta\s*(?:->>|->|#>>|#>)\s*'\{?deployment\}?'/);
    expect(sql).toMatch(/transport_meta\s*(?:->>|->|#>>|#>)\s*'\{?deployment\}?'/);
  });

  it('keeps the organization filter and aggregate for scoped callers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents(['fluent-io', 'client-org']);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('a.org_id = any($1)');
    expect(sql).toMatch(/\bas active_slots\b/);
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io', 'client-org']]);
  });

  it('keeps the aggregate without an organization filter for explicit superadmin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listAgents([], true);

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).not.toContain('any($1)');
    expect(sql).toMatch(/\bas active_slots\b/);
    expect(mockQuery.mock.calls[0]).toHaveLength(1);
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
      rows: [agentRow({ repos: ['fluent-io/fluent-flow'] })],
    });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');
    expect(result?.id).toBe('ff-runner');
  });

  it('returns null for empty-org non-superadmin without querying', async () => {
    const result = await getAgentDetail([], 'ff-runner');
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns agent across orgs for explicit superadmin', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [agentRow({ org_id: 'legacy-org' })],
    });

    const result = await getAgentDetail([], 'ff-runner', true);
    expect(result?.id).toBe('ff-runner');
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });

  it('maps live slot aggregates onto the detail DTO', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [agentRow({ deployment: 'self_hosted', capacity: 6, active_slots: 4 })],
    });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');

    expect(result).toEqual(expect.objectContaining({
      id: 'ff-runner',
      deployment: 'self_hosted',
      capacity: 6,
      active_slots: 4,
    }));
  });

  it('maps an agent with no live slots and no configured capacity', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [agentRow({ deployment: null, capacity: null, active_slots: 0 })],
    });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');

    expect(result).toEqual(expect.objectContaining({ deployment: null, capacity: null, active_slots: 0 }));
  });

  it.each([
    { status: 'busy', last_seen_at: new Date('2026-11-08T12:06:00.000Z') },
    { status: 'online', last_seen_at: new Date('2026-11-08T12:05:00.000Z') },
    { status: 'offline', last_seen_at: null },
  ])('maps status and last_seen_at onto the detail DTO: %j', async ({ status, last_seen_at }) => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ status, last_seen_at })] });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');

    expect(result).toEqual(expect.objectContaining({ status, last_seen_at }));
  });

  it('selects status and last_seen_at from the aggregate for the detail query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentDetail(['fluent-io'], 'ff-runner');

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/\bs\.status\b/);
    expect(sql).toMatch(/\bs\.last_seen_at\b/);
  });

  it.each([
    { deployment: 'cloud' },
    { capacity: 0.5 },
    { active_slots: -1 },
    { active_slots: null },
  ])('fails loudly when an aggregate column violates the DTO contract: %j', async (override) => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow(override)] });

    await expect(getAgentDetail(['fluent-io'], 'ff-runner')).rejects.toThrow();
  });

  it('aggregates the agent slots in the same single organization-scoped query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentDetail(['fluent-io'], 'ff-runner');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, params] = mockQuery.mock.calls[0];
    const sql = normalizedSql(text);
    expect(sql.match(/join lateral/g)).toHaveLength(1);
    expect(sql).toMatch(/\bas active_slots\b/);
    expect(sql).toMatch(/\bas capacity\b/);
    expect(sql).toMatch(/\bas deployment\b/);
    expect(sql).toMatch(/agent_id = \w+\.id and org_id = \w+\.org_id/);
    expect(sql).toMatch(/org_id = any\(\$2\)/);
    expect(params).toEqual(['ff-runner', ['fluent-io']]);
  });

  it('uses the shared read-time TTL fragment and configured fallbacks for the detail aggregate', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentDetail(['fluent-io'], 'ff-runner');

    const sql = normalizedSql(mockQuery.mock.calls[0][0]);
    expect(sql).toContain(normalizedSql(SESSION_STATUS_AT_READ_TIME));
    expect(sql).toContain('coalesce(');
    expect(sql).toMatch(/session_meta\s*(?:->>|->|#>>|#>)\s*'\{?capacity\}?'/);
    expect(sql).toMatch(/transport_meta\s*(?:->>|->|#>>|#>)\s*'\{?capacity\}?'/);
    expect(sql).toMatch(/transport_meta\s*(?:->>|->|#>>|#>)\s*'\{?deployment\}?'/);
  });

  it('keeps the aggregate for explicit superadmin without an organization filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentDetail([], 'ff-runner', true);

    const [text, params] = mockQuery.mock.calls[0];
    expect(normalizedSql(text)).toMatch(/\bas active_slots\b/);
    expect(params).toEqual(['ff-runner']);
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

describe('createAgentWithEnrollment', () => {
  const agentRow = {
    id: 'portable-1',
    org_id: 'fluent-io',
    agent_type: 'claude-code',
    transport: 'long_poll',
    transport_meta: { capacity: 2 },
    repos: ['fluent-io/fluent-flow'],
    created_at: new Date('2026-11-08T12:00:00.000Z'),
    updated_at: new Date('2026-11-08T12:00:00.000Z'),
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockConnect.mockClear();
  });

  it('creates the agent and its enrollment in one transaction', async () => {
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('insert into agents')) return { rows: [agentRow] };
      if (sql.startsWith('insert into agent_tokens')) return { rows: [{ id: 101 }] };
      return { rows: [] };
    });

    const result = await createAgentWithEnrollment({
      id: 'portable-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
      transportMeta: { capacity: 2 },
      repos: ['fluent-io/fluent-flow'],
    });

    expect(result.agent).toEqual(agentRow);
    expect(result.enrollment.id).toBe(101);
    expect(result.enrollment.plaintext).not.toMatch(/^ff_/);
    expect(transactionCommands()).toEqual(['begin', 'commit']);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit enrollment expiry through the atomic operation', async () => {
    const expiresAt = new Date('2026-11-08T13:00:00.000Z');
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('insert into agents')) return { rows: [agentRow] };
      if (sql.startsWith('insert into agent_tokens')) return { rows: [{ id: 102 }] };
      return { rows: [] };
    });

    await createAgentWithEnrollment({
      id: 'portable-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
    }, expiresAt);

    const enrollmentInsert = mockClientQuery.mock.calls.find(([text]) =>
      normalizedSql(text).startsWith('insert into agent_tokens'),
    );
    expect(enrollmentInsert?.[1]).toContain(expiresAt);
  });

  it('rolls back the agent when enrollment insertion fails', async () => {
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('insert into agents')) return { rows: [agentRow] };
      if (sql.startsWith('insert into agent_tokens')) throw new Error('enrollment insert failed');
      return { rows: [] };
    });

    await expect(createAgentWithEnrollment({
      id: 'portable-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
    })).rejects.toThrow('enrollment insert failed');

    expect(transactionCommands()).toEqual(['begin', 'rollback']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects with both errors and still releases the client when rollback also fails', async () => {
    const insertError = new Error('enrollment insert failed');
    const rollbackError = new Error('rollback failed');
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('insert into agents')) return { rows: [agentRow] };
      if (sql.startsWith('insert into agent_tokens')) throw insertError;
      if (sql === 'rollback') throw rollbackError;
      return { rows: [] };
    });

    const failure = await createAgentWithEnrollment({
      id: 'portable-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
    }).then(
      () => { throw new Error('expected createAgentWithEnrollment to reject'); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([insertError, rollbackError]);
    expect(transactionCommands()).toEqual(['begin', 'rollback']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
