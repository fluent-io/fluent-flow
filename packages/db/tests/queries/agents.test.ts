import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentWithEnrollment } from '../../src/queries/index';
import { listAgents, getAgentDetail } from '../../src/queries/agents.js';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

vi.mock('../../src/pool', () => ({
  getPool: () => ({ connect: () => mockConnect() }),
  query: (...args: unknown[]) => mockQuery(...args),
}));



function normalizedSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}


function transactionCommands() {
  return mockClientQuery.mock.calls.map(([text]) => normalizedSql(text)).filter((sql) =>
    ['begin', 'commit', 'rollback'].includes(sql),
  );
}
describe('listAgents', () => {
  beforeEach(() => { mockQuery.mockReset(); });


  it('returns no agents for empty-org non-superadmin without querying', async () => {
    const result = await listAgents([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

});

describe('getAgentDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns null for empty-org non-superadmin without querying', async () => {
    const result = await getAgentDetail([], 'ff-runner');
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
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

    await createAgentWithEnrollment({
      id: 'portable-1',
      orgId: 'fluent-io',
      agentType: 'claude-code',
      transport: 'long_poll',
      transportMeta: { capacity: 2 },
      repos: ['fluent-io/fluent-flow'],
    });

    expect(transactionCommands()).toEqual(['begin', 'commit']);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
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
