import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { regenerateKey, getKeyInfo } = await import('../../src/queries/tokens.js');

describe('regenerateKey', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('revokes existing tokens and creates a new one', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 5, org_id: 'fluent-io', agent_id: 'ff-runner', created_at: new Date() }],
    });

    const result = await regenerateKey('fluent-io', 'ff-runner');
    expect(result.plaintext).toMatch(/^ff_/);
    expect(result.id).toBe(5);
    expect(mockQuery).toHaveBeenCalledTimes(2);
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
