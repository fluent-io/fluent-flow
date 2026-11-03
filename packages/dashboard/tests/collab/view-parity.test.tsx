import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextAuthOptions, Session } from 'next-auth';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the rows the auth callbacks read. The callbacks run
// unmodified; only the data layer is replaced, so the same principal can sign
// in through both providers and the resulting sessions can be compared.
type UserRow = { id: number; github_id: number; login: string; email: string | null; avatar_url: string | null; is_superadmin: boolean };
type PrincipalRow = { id: string; displayName: string; email: string | null; legacyUserId: number | null; disabledAt: string | null; sessionVersion: number; password: string | null };
const db = { users: [] as UserRow[], orgs: [] as { user_id: number; org_id: string; role: 'admin' | 'member' }[], principals: [] as PrincipalRow[] };

function publicPrincipal(p: PrincipalRow) {
  const { password: _password, ...rest } = p;
  return { ...rest };
}

vi.mock('@fluent-flow/db', () => ({
  authenticateCollabPassword: async ({ email, password }: { email: string; password: string }) => {
    const p = db.principals.find((r) => r.email === email && r.password === password && !r.disabledAt);
    return p ? publicPrincipal(p) : null;
  },
  ensureGithubPrincipal: async ({ legacyUserId, displayName, email }: { legacyUserId: number; displayName: string; email: string | null }) => {
    let p = db.principals.find((r) => r.legacyUserId === legacyUserId);
    if (!p) {
      p = { id: `p-gh-${legacyUserId}`, displayName, email, legacyUserId, disabledAt: null, sessionVersion: 1, password: null };
      db.principals.push(p);
    }
    p.displayName = displayName;
    p.email = email;
    return publicPrincipal(p);
  },
  getCollabPrincipal: async (id: string) => {
    const p = db.principals.find((r) => r.id === id);
    return p ? publicPrincipal(p) : null;
  },
  upsertUser: async (input: { github_id: number; login: string; email: string | null; avatar_url: string | null }) => {
    const existing = db.users.find((u) => u.github_id === input.github_id);
    if (!existing) throw new Error('fixture: GitHub users are seeded explicitly');
    existing.login = input.login;
    existing.email = input.email ?? existing.email;
    existing.avatar_url = input.avatar_url ?? existing.avatar_url;
    return existing;
  },
  getUserOrgs: async (userId: number) =>
    db.orgs.filter((o) => o.user_id === userId).map(({ org_id, role }) => ({ user_id: userId, org_id, role })),
  query: async (sql: string, params: unknown[]) => {
    if (/FROM users WHERE github_id = \$1/.test(sql)) return { rows: db.users.filter((u) => u.github_id === params[0]) };
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: db.users.filter((u) => u.id === params[0]) };
    throw new Error(`fixture: unexpected SQL ${sql}`);
  },
}));

let currentSession: Session | null = null;
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSession: () => (currentSession ? { data: currentSession, status: 'authenticated' } : { data: null, status: 'unauthenticated' }),
  signOut: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/settings' }));

const { authOptions, getOrgScope } = await import('../../src/lib/auth');
const { LegacyAdminGate } = await import('@/components/layout/legacy-admin-gate');
const { DashboardShell } = await import('@/components/layout/dashboard-shell');

type Callbacks = NonNullable<NextAuthOptions['callbacks']>;
const callbacks = authOptions.callbacks as Required<Callbacks>;
const seam = (args: Record<string, unknown>) => args as never;

function credentialsAuthorize() {
  // NextAuth merges the factory `options` over the provider at request time;
  // same normalization as auth.test.ts.
  const raw = authOptions.providers.find((p) => p.id === 'credentials') as unknown as Record<string, unknown> & { options: Record<string, unknown> };
  return ({ ...raw, ...raw.options } as unknown as { authorize: (c: Record<string, string>, r: { headers: Record<string, string> }) => Promise<Record<string, unknown> | null> }).authorize;
}

async function resolveSession(token: Record<string, unknown>): Promise<Session> {
  return (await callbacks.session(seam({ session: { user: {}, expires: '2099-01-01T00:00:00.000Z' }, token }))) as Session;
}

/** authorize -> signIn -> jwt -> session, as NextAuth runs a credentials login. */
async function passwordLogin(email: string, password: string) {
  const user = await credentialsAuthorize()({ email, password }, { headers: {} });
  if (!user) throw new Error('password rejected');
  const account = { provider: 'credentials', type: 'credentials' };
  expect(await callbacks.signIn(seam({ user, account }))).toBe(true);
  const token = await callbacks.jwt(seam({ token: { name: user.name, email: user.email, sub: user.id }, user, account }));
  return { token: token as Record<string, unknown>, session: await resolveSession(token as Record<string, unknown>) };
}

/** signIn -> jwt -> session, as NextAuth runs a GitHub OAuth callback. */
async function oauthLogin(profile: { id: number; login: string; avatar_url: string | null }, email: string | null) {
  const user = { id: String(profile.id), name: profile.login, email, image: profile.avatar_url };
  const account = { provider: 'github', type: 'oauth' };
  expect(await callbacks.signIn(seam({ user, account, profile }))).toBe(true);
  const token = await callbacks.jwt(seam({ token: { name: user.name, email, picture: user.image, sub: user.id }, user, account, profile }));
  return { token: token as Record<string, unknown>, session: await resolveSession(token as Record<string, unknown>) };
}

function renderShell(session: Session) {
  currentSession = session;
  vi.stubGlobal('React', React);
  return renderToStaticMarkup(<LegacyAdminGate><div>Internal page content</div></LegacyAdminGate>);
}

function seedLinked(opts: { userId: number; githubId: number; login: string; superadmin?: boolean; orgs?: { org_id: string; role: 'admin' | 'member' }[] }) {
  db.users.push({ id: opts.userId, github_id: opts.githubId, login: opts.login, email: `${opts.login}@example.test`, avatar_url: `https://avatars.example.test/${opts.login}`, is_superadmin: opts.superadmin ?? false });
  for (const o of opts.orgs ?? []) db.orgs.push({ user_id: opts.userId, ...o });
  // The password was provisioned for the existing linked principal; its display
  // name/email differ from GitHub on purpose so a projection leak would show.
  db.principals.push({ id: `p-linked-${opts.userId}`, displayName: `${opts.login} (password)`, email: `${opts.login}+pw@example.test`, legacyUserId: opts.userId, disabledAt: null, sessionVersion: 1, password: 'correct horse battery' });
  return { profile: { id: opts.githubId, login: opts.login, avatar_url: `https://avatars.example.test/${opts.login}` }, email: `${opts.login}@example.test`, passwordEmail: `${opts.login}+pw@example.test` };
}

beforeEach(() => {
  db.users = [];
  db.orgs = [];
  db.principals = [];
  currentSession = null;
});

describe('password and GitHub sign-in produce the same dashboard view for a linked principal', () => {
  const cases = [
    { name: 'org owner/admin', seed: { userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' as const }] } },
    { name: 'org member', seed: { userId: 8, githubId: 9002, login: 'member', orgs: [{ org_id: 'acme', role: 'member' as const }, { org_id: 'globex', role: 'admin' as const }] } },
    { name: 'superadmin without orgs', seed: { userId: 9, githubId: 9003, login: 'root', superadmin: true } },
  ];

  for (const c of cases) {
    it(`${c.name}: identical session, org scope and rendered shell`, async () => {
      const ids = seedLinked(c.seed);
      const password = await passwordLogin(ids.passwordEmail, 'correct horse battery');
      const oauth = await oauthLogin(ids.profile, ids.email);

      expect(password.session.user).toEqual(oauth.session.user);
      expect(password.session.user).toEqual({
        id: c.seed.userId,
        principalId: `p-linked-${c.seed.userId}`,
        sessionVersion: 1,
        login: c.seed.login,
        email: `${c.seed.login}@example.test`,
        image: `https://avatars.example.test/${c.seed.login}`,
        isSuperadmin: c.seed.superadmin ?? false,
        orgs: (c.seed.orgs ?? []).map((o) => ({ user_id: c.seed.userId, ...o })),
      });
      expect(getOrgScope(password.session)).toEqual(getOrgScope(oauth.session));

      const passwordHtml = renderShell(password.session);
      const oauthHtml = renderShell(oauth.session);
      expect(passwordHtml).toBe(oauthHtml);
      for (const label of ['Board', 'Needs attention', 'Agents', 'Repos', 'Pipelines', 'Settings']) {
        expect(passwordHtml).toContain(`<span>${label}</span>`);
      }
      expect(passwordHtml).toContain('href="/settings"');
      expect(passwordHtml).toContain('Internal page content');
      expect(passwordHtml).not.toContain('Install on GitHub');
      expect(passwordHtml).toContain(`>${c.seed.login}</span>`);
    });
  }

  it('a pre-collab GitHub JWT still materializes its principal and resolves the same view', async () => {
    const ids = seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    const fresh = await oauthLogin(ids.profile, ids.email);
    const migrated = await callbacks.jwt(seam({ token: { github_id: 9001, login: 'owner', email: ids.email } }));
    expect(migrated).toMatchObject({ principalId: 'p-linked-7', sessionVersion: 1 });
    expect((await resolveSession(migrated as Record<string, unknown>)).user).toEqual(fresh.session.user);
  });
});

describe('restricted and fail-closed cases', () => {
  it('an unlinked invited collaborator stays restricted to board views', async () => {
    seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    // Same email as the legacy user: identity must never be linked by email.
    db.principals.push({ id: 'p-ext', displayName: 'External Person', email: 'owner@example.test', legacyUserId: null, disabledAt: null, sessionVersion: 1, password: 'external password' });

    const { session } = await passwordLogin('owner@example.test', 'external password');

    expect(session.user).toEqual({ id: null, principalId: 'p-ext', sessionVersion: 1, login: 'External Person', email: 'owner@example.test', image: null, isSuperadmin: false, orgs: [] });
    expect(getOrgScope(session)).toEqual({ orgIds: [], isSuperadmin: false });
    const html = renderShell(session);
    expect(html).toContain('<span>Board</span>');
    expect(html).toContain('<span>Needs attention</span>');
    for (const label of ['Agents', 'Repos', 'Pipelines', 'Settings']) expect(html).not.toContain(`<span>${label}</span>`);
    expect(html).not.toContain('Internal page content');
    expect(html).toContain('Redirecting to your board');

    currentSession = session;
    const boardHtml = renderToStaticMarkup(<DashboardShell><div>Board content</div></DashboardShell>);
    expect(boardHtml).toContain('Board content');
    expect(boardHtml).not.toContain('Install on GitHub');
  });

  it('rejects a GitHub token whose github_id differs from the principal link', async () => {
    seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    seedLinked({ userId: 8, githubId: 9002, login: 'other', orgs: [{ org_id: 'globex', role: 'admin' }] });

    await expect(resolveSession({ principalId: 'p-linked-7', sessionVersion: 1, github_id: 9002, login: 'other' })).rejects.toThrow();
  });

  it('rejects a GitHub token bound to an unlinked principal', async () => {
    seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    db.principals.push({ id: 'p-ext', displayName: 'External', email: null, legacyUserId: null, disabledAt: null, sessionVersion: 1, password: null });

    await expect(resolveSession({ principalId: 'p-ext', sessionVersion: 1, github_id: 9001, login: 'owner' })).rejects.toThrow();
  });

  it('rejects both providers once the principal is disabled or its session version moves', async () => {
    const ids = seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    const password = await passwordLogin(ids.passwordEmail, 'correct horse battery');
    const oauth = await oauthLogin(ids.profile, ids.email);
    const principal = db.principals.find((p) => p.id === 'p-linked-7')!;

    principal.sessionVersion = 2;
    await expect(resolveSession(password.token)).rejects.toThrow();
    await expect(resolveSession(oauth.token)).rejects.toThrow();

    principal.sessionVersion = 1;
    principal.disabledAt = '2026-11-01T00:00:00.000Z';
    await expect(resolveSession(password.token)).rejects.toThrow();
    await expect(resolveSession(oauth.token)).rejects.toThrow();
  });

  it('fails closed when the linked legacy user row cannot be read', async () => {
    // collab_principals.legacy_user_id REFERENCES users(id) without ON DELETE,
    // so Postgres refuses the delete; this guards a read that still comes back
    // empty instead of quietly downgrading or keeping stale scope.
    const ids = seedLinked({ userId: 7, githubId: 9001, login: 'owner', orgs: [{ org_id: 'acme', role: 'admin' }] });
    const password = await passwordLogin(ids.passwordEmail, 'correct horse battery');
    db.users = [];

    await expect(resolveSession(password.token)).rejects.toThrow();
  });
});

describe('view-parity browser script database preflight', () => {
  // Port 1 has no listener: if the script tried to connect or reset, it would
  // fail with a connection error instead of the preflight refusal.
  const script = fileURLToPath(new URL('./view-parity.browser.mjs', import.meta.url));
  for (const name of ['ff_demo', 'ff_prod', 'ff_demo_test', 'ff_auth_parity_db', 'postgres']) {
    it(`refuses ${name} before connecting`, () => {
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, FF_COLLAB_TEST_DB_OPTIN: '1', FF_VIEW_PARITY_DATABASE_URL: `postgres://nobody@127.0.0.1:1/${name}` },
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(`refusing to reset database "${name}"`);
      expect(run.stderr).not.toMatch(/ECONNREFUSED|connect/i);
    });
  }
});
