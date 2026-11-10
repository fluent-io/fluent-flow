import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEnrollmentToken, exchangeEnrollmentToken } from '../../src/queries/index';

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

vi.mock('../../src/pool', () => ({
  getPool: () => ({ connect: () => mockConnect() }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { regenerateKey, getKeyInfo, createToken } = await import('../../src/queries/tokens');


function normalizedSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function transactionCommands() {
  return mockClientQuery.mock.calls.map(([text]) => normalizedSql(text)).filter((sql) =>
    ['begin', 'commit', 'rollback'].includes(sql),
  );
}

describe('regenerateKey', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockRelease.mockReset();
  });

  it('revokes existing tokens and creates a new one in a transaction', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ id: 5, org_id: 'fluent-io', agent_id: 'ff-runner', created_at: new Date() }],
    }); // INSERT
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await regenerateKey('fluent-io', 'ff-runner');
    expect(result.plaintext).toMatch(/^ff_/);
    expect(result.id).toBe(5);
    expect(mockClientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(mockClientQuery.mock.calls[3][0]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('rolls back on failure', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockClientQuery.mockRejectedValueOnce(new Error('insert failed')); // INSERT
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(regenerateKey('fluent-io', 'ff-runner')).rejects.toThrow('insert failed');
    expect(mockClientQuery.mock.calls[3][0]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe('getKeyInfo', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns key creation date when key exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 3, created_at: new Date('2026-04-05') }],
    });

    const result = await getKeyInfo('fluent-io', 'ff-runner');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(3);
  });

  it('returns null when no active key exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getKeyInfo('fluent-io', 'ff-runner');
    expect(result).toBeNull();
  });
});

describe('createToken', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('generates ff_ token, hashes it, stores with the provided label, returns plaintext + id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });

    const result = await createToken({
      orgId: 'fluent-io', agentId: 'laptop-1', label: 'dashboard-abc',
    });

    expect(result.plaintext).toMatch(/^ff_[0-9a-f]{64}$/);
    expect(result.id).toBe(42);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_tokens');
    expect(sql).toContain('RETURNING id');
    // org_id, agent_id, token_hash, label, expires_at
    expect(params).toHaveLength(5);
    expect(params[0]).toBe('fluent-io');
    expect(params[1]).toBe('laptop-1');
    expect(params[2]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex of plaintext
    expect(params[3]).toBe('dashboard-abc');
    const expiresAt = params[4] as Date;
    const expected = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt.getTime() - expected)).toBeLessThan(5000);
  });

  it('does not store the plaintext — only the SHA-256 hash', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const result = await createToken({
      orgId: 'o', agentId: 'a', label: 'l',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).not.toBe(result.plaintext);
    expect(params[2]).not.toContain('ff_');
  });

  it('persists NULL expires_at when expiresAt is explicitly null (never expires)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await createToken({ orgId: 'o', agentId: 'a', label: 'l', expiresAt: null });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[4]).toBeNull();
  });

  it('honours an explicit expiresAt Date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const when = new Date('2027-01-01T00:00:00Z');

    await createToken({ orgId: 'o', agentId: 'a', label: 'l', expiresAt: when });

    expect(mockQuery.mock.calls[0][1]?.[4]).toBe(when);
  });
});

describe('createEnrollmentToken', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockConnect.mockClear();
  });

  it('generates a distinct non-ff_ credential and stores only its SHA-256 hash under an enrollment label', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 73 }] });

    const result = await createEnrollmentToken({ orgId: 'fluent-io', agentId: 'portable-1' });

    expect(result.id).toBe(73);
    expect(result.plaintext).not.toMatch(/^ff_/);
    expect(result.plaintext.length).toBeGreaterThan(32);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('fluent-io');
    expect(params[1]).toBe('portable-1');
    expect(params[2]).toBe(createHash('sha256').update(result.plaintext).digest('hex'));
    expect(params[2]).not.toContain(result.plaintext);
    expect(params[3]).toMatch(/^enrollment:/);
  });

  it('defaults expiry to fifteen minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00.000Z'));
    try {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 74 }] });

      await createEnrollmentToken({ orgId: 'fluent-io', agentId: 'portable-2' });

      expect(mockQuery.mock.calls[0][1][4]).toEqual(new Date('2026-11-08T12:15:00.000Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours an explicit expiry', async () => {
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 75 }] });

    await createEnrollmentToken({ orgId: 'fluent-io', agentId: 'portable-3', expiresAt });

    expect(mockQuery.mock.calls[0][1][4]).toBe(expiresAt);
  });

  it('uses a supplied transaction executor without opening or committing its own transaction', async () => {
    const executorQuery = vi.fn().mockResolvedValue({ rows: [{ id: 76 }] });
    const executor = { query: executorQuery };

    const result = await createEnrollmentToken(
      { orgId: 'fluent-io', agentId: 'portable-4' },
      executor,
    );

    expect(result.id).toBe(76);
    expect(executorQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    const commands = executorQuery.mock.calls.map(([text]) => normalizedSql(text));
    expect(commands).not.toContain('begin');
    expect(commands).not.toContain('commit');
    expect(commands).not.toContain('rollback');
  });
});

describe('exchangeEnrollmentToken', () => {
  const validEnrollmentRow = {
    id: 90,
    org_id: 'fluent-io',
    agent_id: 'portable-1',
    label: 'enrollment:portable-1',
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
    revoked_at: null,
  };

  beforeEach(() => {
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockConnect.mockClear();
  });

  it('atomically consumes a valid enrollment and returns one durable ff_ token bound to the instance', async () => {
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('select')) return { rows: [validEnrollmentRow] };
      if (sql.startsWith('update')) return { rows: [validEnrollmentRow] };
      if (sql.startsWith('insert')) return { rows: [{ id: 91 }] };
      return { rows: [] };
    });

    const result = await exchangeEnrollmentToken({
      plaintext: 'enrollment_credential_value',
      instanceId: 'instance-01',
    });

    expect(result).toEqual({
      plaintext: expect.stringMatching(/^ff_[0-9a-f]{64}$/),
      id: 91,
      orgId: 'fluent-io',
      agentId: 'portable-1',
    });
    expect(transactionCommands()).toEqual(['begin', 'commit']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    const insertCall = mockClientQuery.mock.calls.find(([text]) =>
      normalizedSql(text).startsWith('insert'),
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall?.[1] as unknown[];
    expect(
      insertParams.some((value) => typeof value === 'string' && value.includes('instance-01')),
    ).toBe(true);
    expect(
      insertParams.some((value) => typeof value === 'string' && value.startsWith('enrollment:')),
    ).toBe(false);
    expect(insertParams).toContain(createHash('sha256').update(result!.plaintext).digest('hex'));
  });

  it('trusts PostgreSQL admission when the application clock is later than the row expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'));
    try {
      mockClientQuery.mockImplementation(async (text: unknown) => {
        const sql = normalizedSql(text);
        if (sql.startsWith('select')) return { rows: [validEnrollmentRow] };
        if (sql.startsWith('update')) return { rows: [validEnrollmentRow] };
        if (sql.startsWith('insert')) return { rows: [{ id: 93 }] };
        return { rows: [] };
      });

      const result = await exchangeEnrollmentToken({
        plaintext: 'database_admitted_enrollment',
        instanceId: 'instance-clock-skew',
      });

      expect(result).toEqual({
        plaintext: expect.stringMatching(/^ff_[0-9a-f]{64}$/),
        id: 93,
        orgId: 'fluent-io',
        agentId: 'portable-1',
      });
      expect(transactionCommands()).toEqual(['begin', 'commit']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unknown', null],
    ['non-enrollment', { ...validEnrollmentRow, label: 'dashboard' }],
    ['revoked', { ...validEnrollmentRow, revoked_at: new Date('2026-11-08T00:00:00.000Z') }],
    ['expired', null],
  ])('returns the same null result for %s input without creating a durable token', async (_case, row) => {
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('select')) return { rows: row ? [row] : [] };
      if (sql.startsWith('update')) return { rows: row ? [row] : [] };
      if (sql.startsWith('insert')) return { rows: [{ id: 92 }] };
      return { rows: [] };
    });

    const result = await exchangeEnrollmentToken({
      plaintext: 'generic_failure_credential',
      instanceId: 'instance-02',
    });

    expect(result).toBeNull();
    expect(mockClientQuery.mock.calls.some(([text]) => normalizedSql(text).startsWith('insert'))).toBe(false);
    expect(transactionCommands()).toEqual(['begin', 'commit']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back enrollment consumption when durable token insertion fails', async () => {
    mockClientQuery.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('select')) return { rows: [validEnrollmentRow] };
      if (sql.startsWith('update')) return { rows: [validEnrollmentRow] };
      if (sql.startsWith('insert')) throw new Error('durable insert failed');
      return { rows: [] };
    });

    await expect(exchangeEnrollmentToken({
      plaintext: 'enrollment_credential_value',
      instanceId: 'instance-03',
    })).rejects.toThrow('durable insert failed');

    expect(transactionCommands()).toEqual(['begin', 'rollback']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
