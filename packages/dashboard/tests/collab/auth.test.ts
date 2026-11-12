import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextAuthOptions } from 'next-auth';
import { createHash } from 'node:crypto';

const mockAuthenticateCollabPassword = vi.fn<
  (input: { email: string; password: string; rateLimitKey: string }) => Promise<unknown>
>();
const mockEnsureGithubPrincipal = vi.fn();
const mockGetCollabPrincipal = vi.fn();
const mockUpsertUser = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockLinkUserToOrgIfProvisioned = vi.fn();
const mockEnsureDefaultWorkspace = vi.fn();
const mockEnrollOrgAdminInDefaultWorkspaces = vi.fn();
const mockQuery = vi.fn();

vi.mock('@fluent-flow/db', () => ({
  authenticateCollabPassword: (input: { email: string; password: string; rateLimitKey: string }) =>
    mockAuthenticateCollabPassword(input),
  ensureGithubPrincipal: (...args: unknown[]) => mockEnsureGithubPrincipal(...args),
  getCollabPrincipal: (...args: unknown[]) => mockGetCollabPrincipal(...args),
  upsertUser: (...args: unknown[]) => mockUpsertUser(...args),
  getUserOrgs: (...args: unknown[]) => mockGetUserOrgs(...args),
  linkUserToOrgIfProvisioned: (...args: unknown[]) => mockLinkUserToOrgIfProvisioned(...args),
  ensureDefaultWorkspace: (...args: unknown[]) => mockEnsureDefaultWorkspace(...args),
  enrollOrgAdminInDefaultWorkspaces: (...args: unknown[]) => mockEnrollOrgAdminInDefaultWorkspaces(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { authOptions } = await import('../../src/lib/auth');

type NextAuthCallbacks = NonNullable<NextAuthOptions['callbacks']>;
type SignInArgs = Parameters<NonNullable<NextAuthCallbacks['signIn']>>[0];
type JwtArgs = Parameters<NonNullable<NextAuthCallbacks['jwt']>>[0];
type SessionArgs = Parameters<NonNullable<NextAuthCallbacks['session']>>[0];

function asSignInArgs(args: Record<string, unknown>): SignInArgs {
  return args as unknown as SignInArgs;
}

function asJwtArgs(args: Record<string, unknown>): JwtArgs {
  return args as unknown as JwtArgs;
}

function asSessionArgs(args: Record<string, unknown>): SessionArgs {
  return args as unknown as SessionArgs;
}

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
  const provider = normalizeCredentialsProvider(raw as unknown as { options?: Record<string, unknown> } & Record<string, unknown>);
  if (!provider.authorize) throw new Error(`provider ${providerId} has no authorize after normalization`);
  return provider;
}

const PRINCIPAL = {
  id: 'p-1',
  displayName: 'Collaborator One',
  email: 'c1@example.com',
  userId: null,
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
    mockLinkUserToOrgIfProvisioned.mockReset();
    mockEnsureDefaultWorkspace.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensures a default workspace for every processed org, whether or not the link was new', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ installations: [{ account: { login: 'acme' } }, { account: { login: 'other-org' } }] }),
      }),
    );

    await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(mockEnsureDefaultWorkspace).toHaveBeenCalledTimes(2);
    expect(mockEnsureDefaultWorkspace).toHaveBeenCalledWith('acme', { createdByPrincipalId: null });
    expect(mockEnsureDefaultWorkspace).toHaveBeenCalledWith('other-org', { createdByPrincipalId: null });
  });

  it('still succeeds sign-in, and keeps going to the next org, when ensuring a default workspace throws', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockResolvedValue(true);
    mockEnsureDefaultWorkspace.mockRejectedValueOnce(new Error('collab db down')).mockResolvedValueOnce(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ installations: [{ account: { login: 'acme' } }, { account: { login: 'other-org' } }] }),
      }),
    );

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'other-org', 'member');
    expect(mockEnsureDefaultWorkspace).toHaveBeenCalledWith('other-org', { createdByPrincipalId: null });
    expect(errorSpy).toHaveBeenCalledWith(
      'reconcileGithubOrgAccess: failed to ensure default workspace',
      expect.objectContaining({ orgId: 'acme' }),
    );
    errorSpy.mockRestore();
  });

  it('still ensures the default workspace when the org link itself throws', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockRejectedValueOnce(new Error('db down'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ installations: [{ account: { login: 'acme' } }] }) }),
    );

    await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(mockEnsureDefaultWorkspace).toHaveBeenCalledWith('acme', { createdByPrincipalId: null });
  });

  it('allows credentials sign-in without touching legacy GitHub upsert', async () => {
    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({ user: { id: 'p-1' }, account: { provider: 'credentials' }, profile: undefined }),
    );

    expect(result).toBe(true);
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });

  it('upserts the legacy user for GitHub sign-in', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
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

  it('reconciles org membership on GitHub sign-in, linking as member (never admin)', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ installations: [{ account: { login: 'acme' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.github.com/user/installations?per_page=100&page=1'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer gh-token' }) }),
    );
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'acme', 'member');
    expect(mockLinkUserToOrgIfProvisioned).not.toHaveBeenCalledWith(7, 'acme', 'admin');
    // only one page: installations.length (1) < per_page (100), so no second request
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('relies on the atomic db-level guard, not an app-level pre-check, so it always attempts the link', async () => {
    // No getUserOrgs call here: whether the link already exists is decided
    // atomically inside linkUserToOrgIfProvisioned (see its own db-layer
    // tests), not by reading state first in app code — that would reopen
    // the race this PR closes.
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockResolvedValueOnce(false); // already linked, db no-op
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ installations: [{ account: { login: 'acme' } }] }) }),
    );

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockGetUserOrgs).not.toHaveBeenCalled();
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'acme', 'member');
  });

  it('continues to the next org, and still succeeds sign-in, when one org link throws', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockRejectedValueOnce(new Error('db down'));
    mockLinkUserToOrgIfProvisioned.mockResolvedValueOnce(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ installations: [{ account: { login: 'acme' } }, { account: { login: 'other-org' } }] }),
      }),
    );

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'acme', 'member');
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'other-org', 'member');
  });

  it('still succeeds when the GitHub installations call fails', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockLinkUserToOrgIfProvisioned).not.toHaveBeenCalled();
  });

  it('still succeeds sign-in when GitHub returns a non-ok response', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockLinkUserToOrgIfProvisioned).not.toHaveBeenCalled();
  });

  it('still succeeds sign-in when GitHub returns an unexpected response shape', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ not: 'what we expect' }) }));

    const result = await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(result).toBe(true);
    expect(mockLinkUserToOrgIfProvisioned).not.toHaveBeenCalled();
  });

  it('pages through installations until a short page ends the walk', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    mockLinkUserToOrgIfProvisioned.mockResolvedValue(true);
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ account: { login: `org-${i}` } }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ installations: fullPage }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ installations: [{ account: { login: 'org-last' } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github', access_token: 'gh-token' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('page=2'), expect.anything());
    expect(mockLinkUserToOrgIfProvisioned).toHaveBeenCalledWith(7, 'org-last', 'member');
  });

  it('skips reconciliation entirely when the GitHub OAuth account carries no access token', async () => {
    mockUpsertUser.mockResolvedValueOnce({ id: 7 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authOptions.callbacks!.signIn!(
      asSignInArgs({
        user: { email: 'v@example.com' },
        account: { provider: 'github' },
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLinkUserToOrgIfProvisioned).not.toHaveBeenCalled();
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
    mockEnrollOrgAdminInDefaultWorkspaces.mockReset();
    mockEnrollOrgAdminInDefaultWorkspaces.mockResolvedValue([]);
  });

  it('enrolls the GitHub user into their admin orgs\' default workspaces after resolving the principal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()] });
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, userId: 7 });

    await authOptions.callbacks!.jwt!(
      asJwtArgs({ token: {}, profile: { id: 9001, login: 'victor' }, user: { email: 'v@example.com' } }),
    );

    expect(mockEnrollOrgAdminInDefaultWorkspaces).toHaveBeenCalledWith('p-1');
  });

  it('still issues the token when default-workspace enrollment throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()] });
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, userId: 7 });
    mockEnrollOrgAdminInDefaultWorkspaces.mockRejectedValueOnce(new Error('collab db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const token: Record<string, unknown> = {};
    await authOptions.callbacks!.jwt!(
      asJwtArgs({ token, profile: { id: 9001, login: 'victor' }, user: { email: 'v@example.com' } }),
    );

    expect(token).toMatchObject({ principalId: 'p-1', sessionVersion: 2 });
    expect(errorSpy).toHaveBeenCalledWith(
      'jwt: failed to enroll org admin in default workspaces',
      expect.objectContaining({ principalId: 'p-1' }),
    );
    errorSpy.mockRestore();
  });

  it('does not enroll for credentials sign-ins', async () => {
    await authOptions.callbacks!.jwt!(
      asJwtArgs({ token: {}, user: { id: null, principalId: 'p-1', sessionVersion: 2, login: 'C', email: 'c@x' } }),
    );
    expect(mockEnrollOrgAdminInDefaultWorkspaces).not.toHaveBeenCalled();
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
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, userId: 7 });

    const token: Record<string, unknown> = {};
    await authOptions.callbacks!.jwt!(
      asJwtArgs({
        token,
        profile: { id: 9001, login: 'victor', avatar_url: 'https://avatar' },
        user: { email: 'v@example.com' },
      }),
    );

    expect(mockEnsureGithubPrincipal).toHaveBeenCalledWith({
      userId: 7,
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
    mockEnsureGithubPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, userId: 7 });

    const token: Record<string, unknown> = { github_id: 9001, login: 'victor', email: 'v@example.com' };
    const returned = (await authOptions.callbacks!.jwt!(
      asJwtArgs({ token, user: undefined, profile: undefined }),
    )) as Record<string, unknown>;

    expect(mockEnsureGithubPrincipal).toHaveBeenCalledWith({
      userId: 7,
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

  it.each([
    ['https://pr-149-preview.fluentflow.tech', 'fluent-flow-preview', true],
    ['https://dashboard.fluentflow.tech', 'fluent-flow', false],
    ['https://pr-149-preview.fluentflow.tech.example.test', 'fluent-flow', false],
  ])('selects the App for runtime auth origin %s', async (origin, slug, preview) => {
    vi.stubEnv('NEXTAUTH_URL', origin as string);
    vi.stubEnv('GITHUB_APP_SLUG', '');
    vi.stubEnv('NEXT_PUBLIC_GITHUB_APP_SLUG', '');
    mockGetCollabPrincipal.mockResolvedValueOnce(PRINCIPAL);
    try {
      const session = await callSession({ principalId: 'p-1', sessionVersion: 2 });
      expect(session).toMatchObject({ githubApp: { installUrl: `https://github.com/apps/${slug}/installations/new`, preview } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['custom-app', '', 'custom-app', false],
    ['', 'legacy-app', 'legacy-app', false],
    ['custom-app', 'legacy-app', 'custom-app', false],
    ['custom-app', '', 'custom-app', true],
  ])('prefers server slug %j over public slug %j', async (serverSlug, publicSlug, expectedSlug, preview) => {
    vi.stubEnv('NEXTAUTH_URL', preview ? 'https://pr-149-preview.fluentflow.tech' : 'https://dashboard.fluentflow.tech');
    vi.stubEnv('GITHUB_APP_SLUG', serverSlug as string);
    vi.stubEnv('NEXT_PUBLIC_GITHUB_APP_SLUG', publicSlug as string);
    mockGetCollabPrincipal.mockResolvedValueOnce(PRINCIPAL);
    try {
      const session = await callSession({ principalId: 'p-1', sessionVersion: 2 });
      expect(session).toMatchObject({ githubApp: { installUrl: `https://github.com/apps/${expectedSlug}/installations/new`, preview } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
    mockGetCollabPrincipal.mockResolvedValueOnce({ ...PRINCIPAL, userId: 7 });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          ...userRow({ id: 7, is_superadmin: true }),
          github_id: 9001,
          login: 'victor',
          email: 'v@example.com',
          avatar_url: 'https://avatar',
        },
      ],
    });
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
