import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

vi.mock('../../src/pool.js', () => ({
  getPool: () => ({ connect: () => mockConnect() }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { regenerateKey, getKeyInfo } = await import('../../src/queries/tokens.js');

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
