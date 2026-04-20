import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getAgentSessions } = await import('../../src/queries/sessions');

describe('getAgentSessions', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns sessions ordered by last_seen_at desc', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentSessions('fluent-io', 'pc-1');

    expect(mockQuery.mock.calls[0][1]).toEqual(['fluent-io', 'pc-1']);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY last_seen_at DESC');
    expect(sql).toContain('LIMIT 50');
  });

  it('computes status at read time: expired sessions surface as offline', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentSessions('fluent-io', 'pc-1');

    const sql = mockQuery.mock.calls[0][0] as string;
    // Stored 'online'/'busy' that has outlived its TTL must surface as
    // 'offline' — readers don't trust stale status left behind when a
    // runner dies without hitting the /offline endpoint.
    expect(sql).toContain('CASE');
    expect(sql).toContain(`status <> 'offline' AND expires_at > NOW()`);
    expect(sql).toContain(`ELSE 'offline'`);
  });
});
