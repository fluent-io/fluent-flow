import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { upsertUser, getUserOrgs, bootstrapFirstUser } = await import('../../src/queries/users');

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

describe('bootstrapFirstUser', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('promotes the first user to superadmin and links to self-hosted org', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // ensure self-hosted org
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // UPDATE ... RETURNING id (promoted)
      .mockResolvedValueOnce({ rows: [] }); // INSERT into user_orgs

    const result = await bootstrapFirstUser(1);

    expect(result).toEqual({ promoted: true });
    expect(mockQuery.mock.calls).toHaveLength(3);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO orgs');
    expect(mockQuery.mock.calls[0][1]).toEqual(['self-hosted']);
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE users');
    expect(mockQuery.mock.calls[1][0]).toContain('is_superadmin');
    expect(mockQuery.mock.calls[1][0]).toContain('NOT EXISTS');
    expect(mockQuery.mock.calls[1][1]).toEqual([1]);
    expect(mockQuery.mock.calls[2][0]).toContain('INSERT INTO user_orgs');
    expect(mockQuery.mock.calls[2][1]).toEqual([1, 'self-hosted']);
  });

  it('does not promote when a superadmin already exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // ensure self-hosted org
      .mockResolvedValueOnce({ rows: [] }); // UPDATE matched nothing → not promoted

    const result = await bootstrapFirstUser(2);

    expect(result).toEqual({ promoted: false });
    expect(mockQuery.mock.calls).toHaveLength(2);
    expect(mockQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO user_orgs'))).toBe(false);
  });
});
