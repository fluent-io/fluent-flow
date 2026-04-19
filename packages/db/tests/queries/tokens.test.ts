import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

vi.mock('../../src/pool', () => ({
  getPool: () => ({ connect: () => mockConnect() }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { regenerateKey, getKeyInfo, createToken } = await import('../../src/queries/tokens');

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
