import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { upsertUser, getUserOrgs } = await import('../../src/queries/users.js');

describe('upsertUser', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('upserts user and returns record', async () => {
    const user = {
      github_id: 12345,
      login: 'victor',
      email: 'victor@example.com',
      avatar_url: 'https://github.com/victor.png',
    };

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, ...user, is_superadmin: false, created_at: new Date(), updated_at: new Date() }],
    });

    const result = await upsertUser(user);
    expect(result.login).toBe('victor');
    expect(result.github_id).toBe(12345);
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT');
  });
});

describe('getUserOrgs', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns org memberships for user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 1, org_id: 'fluent-io', role: 'admin', created_at: new Date() }],
    });

    const result = await getUserOrgs(1);
    expect(result).toHaveLength(1);
    expect(result[0].org_id).toBe('fluent-io');
    expect(result[0].role).toBe('admin');
  });

  it('returns empty array when no memberships', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getUserOrgs(999);
    expect(result).toEqual([]);
  });
});
