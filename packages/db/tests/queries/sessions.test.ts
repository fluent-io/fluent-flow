import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getAgentSessions } = await import('../../src/queries/sessions');
const { SESSION_STATUS_AT_READ_TIME } = await import('../../src/queries/_helpers');

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

  it('computes status at read time via the shared SESSION_STATUS_AT_READ_TIME fragment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getAgentSessions('fluent-io', 'pc-1');

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain(SESSION_STATUS_AT_READ_TIME);
    expect(SESSION_STATUS_AT_READ_TIME).toContain('CASE');
    expect(SESSION_STATUS_AT_READ_TIME).toContain(`status <> 'offline' AND expires_at > NOW()`);
    expect(SESSION_STATUS_AT_READ_TIME).toContain(`ELSE 'offline'`);
  });
});
