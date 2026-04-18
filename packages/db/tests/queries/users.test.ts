import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { upsertUser, getUserOrgs, linkUserToOrg } = await import('../../src/queries/users');

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

describe('linkUserToOrg', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('inserts user_orgs row with ON CONFLICT DO NOTHING', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await linkUserToOrg(42, 'acme', 'admin');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO user_orgs');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
    expect(params).toEqual([42, 'acme', 'admin']);
  });

  it('defaults role to member when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await linkUserToOrg(7, 'fluent-io');

    expect(mockQuery.mock.calls[0][1]).toEqual([7, 'fluent-io', 'member']);
  });
});
