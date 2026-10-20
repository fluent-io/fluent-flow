import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextAuthOptions } from 'next-auth';
import { createHash } from 'node:crypto';

const mockAuthenticateCollabPassword = vi.fn<
  (input: { email: string; password: string; rateLimitKey: string }) => Promise<unknown>
>();
const mockEnsureGithubPrincipal = vi.fn();
const mockGetCollabPrincipal = vi.fn();
const mockUpsertUser = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockQuery = vi.fn();

vi.mock('@fluent-flow/db', () => ({
  authenticateCollabPassword: (input: { email: string; password: string; rateLimitKey: string }) =>
    mockAuthenticateCollabPassword(input),
  ensureGithubPrincipal: (...args: unknown[]) => mockEnsureGithubPrincipal(...args),
  getCollabPrincipal: (...args: unknown[]) => mockGetCollabPrincipal(...args),
  upsertUser: (...args: unknown[]) => mockUpsertUser(...args),
  getUserOrgs: (...args: unknown[]) => mockGetUserOrgs(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { authOptions } = await import('../../src/lib/auth');

type NextAuthCallbacks = NonNullable<NextAuthOptions['callbacks']>;
type SignInArgs = Parameters<NonNullable<NextAuthCallbacks['signIn']>>[0];
type JwtArgs = Parameters<NonNullable<NextAuthCallbacks['jwt']>>[0];
type SessionArgs = Parameters<NonNullable<NextAuthCallbacks['session']>>[0];

// Test doubles for NextAuth callback payloads: NextAuth constructs these
// internally, so the shapes cannot be produced without a seam cast.
function asSignInArgs(args: Record<string, unknown>): SignInArgs {
  return args as unknown as SignInArgs;
}

function asJwtArgs(args: Record<string, unknown>): JwtArgs {
  return args as unknown as JwtArgs;
}

function asSessionArgs(args: Record<string, unknown>): SessionArgs {
  return args as unknown as SessionArgs;
}

// Mirrors next-auth/core/lib/providers.js parseProviders for non-oauth
// providers (deep import is blocked by the package exports map): the factory
// output carries the user config in `options` and NextAuth merges it over the
// rest at request time. Testing authorize through this normalization is what
// the library actually executes.
function normalizeCredentialsProvider(provider: { options?: Record<string, unknown> } & Record<string, unknown>) {
  return { ...provider, ...(provider.options ?? {}) } as {
    id: string;
    authorize: (
      credentials: Record<string, string> | undefined,
      req: { headers: Record<string, string> },
    ) => Promise<Record<string, unknown> | null>;
  };
}

function findProvider(providerId: string) {
  const raw = authOptions.providers.find((p) => p.id === providerId);
  if (!raw) throw new Error(`provider ${providerId} missing`);
  // Provider is a library union without an index signature; the normalized
  // surface below is asserted once at this test seam.
  const provider = normalizeCredentialsProvider(raw as unknown as { options?: Record<string, unknown> } & Record<string, unknown>);
  if (!provider.authorize) throw new Error(`provider ${providerId} has no authorize after normalization`);
  return provider;
}

const PRINCIPAL = {
  id: 'p-1',
  displayName: 'Collaborator One',
  email: 'c1@example.com',
  legacyUserId: null,
  disabledAt: null,
  sessionVersion: 2,
};

function userRow(overrides: Partial<{ id: number; is_superadmin: boolean }> = {}) {
  return { id: 7, is_superadmin: false, ...overrides };
}

describe('credentials authorize', () => {
  beforeEach(() => {
    for (const m of [
      mockAuthenticateCollabPassword,
      mockEnsureGithubPrincipal,
      mockGetCollabPrincipal,
      mockUpsertUser,
      mockGetUserOrgs,
      mockQuery,
    ]) {
      m.mockReset();
    }
    delete process.env.FF_TRUSTED_PROXY_CLIENT_HEADER;
  });

  it('authenticates and returns the principal id as the NextAuth user id', async () => {
    mockAuthenticateCollabPassword.mockResolvedValueOnce(PRINCIPAL);

    const result = await findProvider('credentials').authorize(
      { email: 'c1@example.com', password: 'secret-pw' },
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
    );

    expect(result).toMatchObject({ id: 'p-1', principalId: 'p-1', sessionVersion: 2 });
    expect(mockAuthenticateCollabPassword).toHaveBeenCalledWith({
      email: 'c1@example.com',
      password: 'secret-pw',
      rateLimitKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('uses a server-defined stable rate limit bucket by default, ignoring spoofable forwarding headers', async () => {
    mockAuthenticateCollabPassword.mockResolvedValueOnce(null);
    mockAuthenticateCollabPassword.mockResolvedValueOnce(null);

    const forwardKey = createHash('sha256').update('203.0.113.9').digest('hex');

    await findProvider('credentials').authorize(
      { email: 'a@example.com', password: 'pw' },
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
    );
    await findProvider('credentials').authorize(
      { email: 'b@example.com', password: 'pw' },
      { headers: {} },
    );

    const [first, second] = mockAuthenticateCollabPassword.mock.calls.map((call) => call[0].rateLimitKey);
    expect(first).toBe(second);
    expect(first).not.toBe(forwardKey);
  });

  it('derives the rate limit key from a trusted proxy header only when explicitly configured', async () => {
    process.env.FF_TRUSTED_PROXY_CLIENT_HEADER = 'x-real-client-ip';
    mockAuthenticateCollabPassword.mockResolvedValueOnce(null);

    await findProvider('credentials').authorize(
      { email: 'c@example.com', password: 'pw' },
      { headers: { 'x-real-client-ip': '198.51.100.4' } },
    );

    const expectedKey = createHash('sha256').update('198.51.100.4').digest('hex');
    expect(mockAuthenticateCollabPassword).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitKey: expectedKey }),
    );
  });

  it('returns null for missing credentials without calling the verifier', async () => {
    const result = await findProvider('credentials').authorize(undefined, { headers: {} });

    expect(result).toBeNull();
    expect(mockAuthenticateCollabPassword).not.toHaveBeenCalled();
  });
});

describe('signIn callback', () => {
  beforeEach(() => {
    for (const m of [
      mockAuthenticateCollabPassword,
      mockEnsureGithubPrincipal,
      mockGetCollabPrincipal,
      mockUpsertUser,
      mockGetUserOrgs,
      mockQuery,
    ]) {
      m.mockReset();
    }
  });

  it('allows credentials sign-in without touching legacy GitHub upsert', async () => {
    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({ user: { id: 'p-1' }, account: { provider: 'credentials' }, profile: undefined }),
    );

    expect(result).toBe(true);
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });

  it('upserts the legacy user for GitHub sign-in', async () => {
    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockUpsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ github_id: 9001, login: 'victor' }),
    );
  });
});

describe('full invited-user sign-in lifecycle', () => {
  beforeEach(() => {
    for (const m of [
      mockAuthenticateCollabPassword,
      mockEnsureGithubPrincipal,
      mockGetCollabPrincipal,
      mockUpsertUser,
      mockGetUserOrgs,
      mockQuery,
    ]) {
      m.mockReset();
    }
  });

  it('authorizes, signs in, builds a jwt and resolves a session without any legacy GitHub identity', async () => {
    mockAuthenticateCollabPassword.mockResolvedValueOnce(PRINCIPAL);
    mockGetCollabPrincipal.mockResolvedValue(PRINCIPAL);

    const user = await findProvider('credentials').authorize(
      { email: 'c1@example.com', password: 'pw' },
      { headers: {} },
    );
    expect(user).not.toBeNull();

    await expect(
      authOptions.callbacks!.signIn!(asSignInArgs({ user, account: { provider: 'credentials' }, profile: undefined })),
    ).resolves.toBe(true);

    const token = (await authOptions.callbacks!.jwt!(asJwtArgs({ token: {}, user }))) as Record<string, unknown>;
    expect(token).toMatchObject({ principalId: 'p-1', sessionVersion: 2 });

    const session = await authOptions.callbacks!.session!(asSessionArgs({ session: { user: {}, expires: '' }, token }));

    expect(session.user).toEqual({
      id: null,
      principalId: 'p-1',
      sessionVersion: 2,
      login: 'Collaborator One',
      email: 'c1@example.com',
      image: null,
      isSuperadmin: false,
      orgs: [],
    });
    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('jwt callback', () => {
  beforeEach(() => {
    for (const m of [
      mockAuthenticateCollabPassword,
      mockEnsureGithubPrincipal,
      mockGetCollabPrincipal,
      mockUpsertUser,
      mockGetUserOrgs,
      mockQuery,
    ]) {
      m.mockReset();
    }
  });

  it('carries principal identity from a credentials sign-in', async () => {
    const token: Record<string, unknown> = {};
    const returned = await authOptions.callbacks!.jwt!(
      asJwtArgs({
        token,
        user: { id: null, principalId: 'p-1', sessionVersion: 2, login: 'Collaborator One', email: 'c1@example.com' },
      }),
    );

    expect(returned).toMatchObject({ principalId: 'p-1', sessionVersion: 2, login: 'Collaborator One' });
  });

  it('maps a GitHub sign-in to a collaboration principal by legacy user id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()] });
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, legacyUserId: 7 });

    const token: Record<string, unknown> = {};
    await authOptions.callbacks!.jwt!(
      asJwtArgs({
        token,
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
        user: { email: 'v@example.com' },
      }),
    );

    expect(mockEnsureGithubPrincipal).toHaveBeenCalledWith({
      legacyUserId: 7,
      displayName: 'victor',
      email: 'v@example.com',
    });
    expect(token).toMatchObject({ github_id: 9001, login: 'victor', principalId: 'p-1', sessionVersion: 2 });
  });

  it('fails a GitHub sign-in when no legacy user exists for the GitHub id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const token: Record<string, unknown> = {};
    await expect(
      authOptions.callbacks!.jwt!(
        asJwtArgs({
          token,
          profile: { id: 9001, login: 'ghost' },
          user: { email: null },
        }),
      ),
    ).rejects.toThrow();
    expect(mockEnsureGithubPrincipal).not.toHaveBeenCalled();
  });

  it('materializes the principal for a pre-collab GitHub JWT without rotating identity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()] });
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, legacyUserId: 7 });

    const token: Record<string, unknown> = { github_id: 9001, login: 'victor', email: 'v@example.com' };
    const returned = (await authOptions.callbacks!.jwt!(
      asJwtArgs({ token, user: undefined, profile: undefined }),
    )) as Record<string, unknown>;

    expect(mockEnsureGithubPrincipal).toHaveBeenCalledWith({
      legacyUserId: 7,
      displayName: 'victor',
      email: 'v@example.com',
    });
    expect(returned).toMatchObject({ principalId: 'p-1', sessionVersion: 2, github_id: 9001 });
  });

  it('leaves a token without a resolvable legacy user untouched so the session rejects it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const token: Record<string, unknown> = { github_id: 9001, login: 'ghost' };
    const returned = (await authOptions.callbacks!.jwt!(
      asJwtArgs({ token, user: undefined, profile: undefined }),
    )) as Record<string, unknown>;

    expect(returned.principalId).toBeUndefined();
    expect(mockEnsureGithubPrincipal).not.toHaveBeenCalled();
  });
});

describe('session callback', () => {
  beforeEach(() => {
    for (const m of [
      mockAuthenticateCollabPassword,
      mockEnsureGithubPrincipal,
      mockGetCollabPrincipal,
      mockUpsertUser,
      mockGetUserOrgs,
      mockQuery,
    ]) {
      m.mockReset();
    }
  });

  function callSession(token: Record<string, unknown>) {
    return authOptions.callbacks!.session!(asSessionArgs({ session: { user: {}, expires: '' }, token }));
  }

  it('builds an invited collaborator session with no legacy identity or orgs', async () => {
    mockGetCollabPrincipal.mockResolvedValueOnce(PRINCIPAL);

    const session = await callSession({ principalId: 'p-1', sessionVersion: 2 });

    expect(session.user).toEqual({
      id: null,
      principalId: 'p-1',
      sessionVersion: 2,
      login: 'Collaborator One',
      email: 'c1@example.com',
      image: null,
      isSuperadmin: false,
      orgs: [],
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('builds a GitHub user session with legacy identity, orgs and a mapped principal', async () => {
    mockGetCollabPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, legacyUserId: 7 });
    mockQuery.mockResolvedValueOnce({ rows: [userRow({ id: 7, is_superadmin: true })] });
    mockGetUserOrgs.mockResolvedValueOnce([{ org_id: 'acme', role: 'admin' }]);

    const session = await callSession({
      github_id: 9001,
      login: 'victor',
      email: 'v@example.com',
      picture: 'https://avatar',
      principalId: 'p-1',
      sessionVersion: 2,
    });

    expect(session.user).toMatchObject({
      id: 7,
      principalId: 'p-1',
      sessionVersion: 2,
      login: 'victor',
      email: 'v@example.com',
      image: 'https://avatar',
      isSuperadmin: true,
      orgs: [{ org_id: 'acme', role: 'admin' }],
    });
  });

  it('rejects the session when the principal version has moved', async () => {
    mockGetCollabPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, sessionVersion: 3 });

    await expect(callSession({ principalId: 'p-1', sessionVersion: 2 })).rejects.toThrow();
    expect(mockGetCollabPrincipal).toHaveBeenCalledWith('p-1');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects the session when the principal is disabled', async () => {
    mockGetCollabPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, disabledAt: '2026-10-19T00:00:00Z' });

    await expect(callSession({ principalId: 'p-1', sessionVersion: 2 })).rejects.toThrow();
    expect(mockGetCollabPrincipal).toHaveBeenCalledWith('p-1');
  });

  it('rejects the session when the principal no longer exists', async () => {
    mockGetCollabPrincipal.mockResolvedValueOnce(null);

    await expect(callSession({ principalId: 'p-1', sessionVersion: 2 })).rejects.toThrow();
    expect(mockGetCollabPrincipal).toHaveBeenCalledWith('p-1');
  });

  it('rejects a token without principal identity', async () => {
    await expect(callSession({ github_id: 9001, login: 'victor' })).rejects.toThrow();
  });
});
