import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextAuthOptions } from 'next-auth';
import { assertDedicatedCollabTestDatabaseUrl, resetCollabSchema } from '../../../db/tests/helpers/collab-db';

const databaseUrl = process.env.COLLAB_AUTH_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_AUTH_TEST_DATABASE_URL must point to a disposable loopback ff_* database');
vi.stubEnv('DATABASE_URL', assertDedicatedCollabTestDatabaseUrl(databaseUrl));
const db = await import('@fluent-flow/db');
const { authOptions } = await import('../../src/lib/auth');
type Callbacks = NonNullable<NextAuthOptions['callbacks']>;

async function signIn(githubId: number, login: string) {
  const profile = { id: githubId, login };
  const user = { email: null };
  expect(await authOptions.callbacks!.signIn!({
    user, account: { provider: 'github', access_token: 'synthetic-token' }, profile,
  } as unknown as Parameters<NonNullable<Callbacks['signIn']>>[0])).toBe(true);
  const token = await authOptions.callbacks!.jwt!({ token: {}, user, profile } as unknown as Parameters<NonNullable<Callbacks['jwt']>>[0]);
  return { principalId: token.principalId!, sessionVersion: token.sessionVersion! };
}

async function seedAccount(githubId: number, login: string, orgId: string, role: 'admin' | 'member') {
  await db.query('INSERT INTO orgs (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [orgId]);
  const user = await db.upsertUser({ github_id: githubId, login, email: null, avatar_url: null });
  await db.linkUserToOrg(user.id, orgId, role);
  await db.ensureGithubPrincipal({ userId: user.id, displayName: login, email: null });
  return user;
}

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await db.runMigrations();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.closePool();
  await db.pool.end();
  vi.unstubAllEnvs();
});

describe('GitHub workspace repair with real Postgres', () => {
  it('repairs a preexisting admin on GitHub 403 and permits linked and standalone creation without automatic projects', async () => {
    const user = await seedAccount(91001, 'repair-admin', 'repair-org', 'admin');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await db.query('SELECT id FROM collab_workspaces WHERE org_id = $1', ['repair-org'])).rows).toEqual([]);
    const principalBefore = (await db.query('SELECT id FROM collab_principals WHERE user_id = $1', [user.id])).rows[0];
    const actor = await signIn(91001, 'repair-admin');
    expect(actor.principalId).toBe(principalBefore.id);
    const before = await db.getPrincipalMeProfile(actor.principalId);
    expect(before.workspaces).toHaveLength(1);
    const workspace = before.workspaces[0];
    expect(workspace).toMatchObject({ orgId: 'repair-org', projects: [] });
    expect(before.workspaceCapabilities[workspace.id]).toContain('project.admin');
    const membership = await db.query('SELECT r.name FROM collab_memberships m JOIN collab_roles r ON r.id = m.role_id WHERE m.principal_id = $1 AND m.workspace_id = $2 AND m.project_id IS NULL', [actor.principalId, workspace.id]);
    expect(membership.rows).toEqual([{ name: 'manager' }]);
    await db.query('INSERT INTO repos (id, org_id, repo_full_name) VALUES ($1, $2, $3)', ['repair-repo', 'repair-org', 'repair-org/app']);
    const linked = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'app', repoFullName: 'repair-org/app' });
    const standalone = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Standalone' });
    expect(linked.linkedRepoFullName).toBe('repair-org/app');
    expect(standalone.linkedRepoFullName).toBeNull();
    const again = await signIn(91001, 'repair-admin');
    const after = await db.getPrincipalMeProfile(again.principalId);
    expect(after.workspaces.map(w => w.id)).toEqual([workspace.id]);
    expect(after.workspaces[0].projects).toHaveLength(2);
    expect((await db.getUserOrgs(user.id)).map(o => o.role)).toEqual(['admin']);
  });

  it('does not grant a known ordinary member workspace administration during repair', async () => {
    const user = await seedAccount(91002, 'repair-member', 'member-org', 'member');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const actor = await signIn(91002, 'repair-member');
    expect((await db.query('SELECT id FROM collab_workspaces WHERE org_id = $1', ['member-org'])).rows).toHaveLength(1);
    expect(await db.getPrincipalMeProfile(actor.principalId)).toEqual({ workspaces: [], capabilities: {}, workspaceCapabilities: {} });
    expect((await db.getUserOrgs(user.id)).map(o => o.role)).toEqual(['member']);
  });

  it('preserves an existing manual workspace and its membership boundary', async () => {
    const owner = await seedAccount(91003, 'manual-owner', 'manual-org', 'admin');
    await seedAccount(91004, 'other-admin', 'manual-org', 'admin');
    const principal = await db.ensureGithubPrincipal({ userId: owner.id, displayName: owner.login, email: null });
    const workspace = await db.bootstrapCollaborationWorkspace({ actor: { principalId: principal.id, sessionVersion: principal.sessionVersion }, orgId: 'manual-org', name: 'Private workspace', idempotencyKey: 'manual-existing-workspace' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ installations: [] }) }));
    const actor = await signIn(91004, 'other-admin');
    expect((await db.query('SELECT id, name FROM collab_workspaces WHERE org_id = $1', ['manual-org'])).rows).toEqual([{ id: workspace.id, name: 'Private workspace' }]);
    expect((await db.getPrincipalMeProfile(actor.principalId)).workspaces).toEqual([]);
  });
});
