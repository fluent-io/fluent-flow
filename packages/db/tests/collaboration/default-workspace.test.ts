import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedUser,
  seedOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { closePool } from '../../src/pool.js';
import {
  ensureGithubPrincipal,
  ensureDefaultWorkspace,
  defaultWorkspaceIdempotencyKey,
  enrollOrgAdminInDefaultWorkspaces,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  getPrincipalMeProfile,
  getCollabProjectOverview,
} from '../../src/collaboration/identity.js';
import * as packageIndex from '../../src/index.js';

const DATABASE_URL = resolveCollabTestDatabaseUrl();

async function rawQuery(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function seedRepo(orgId: string, repoFullName: string) {
  await rawQuery(
    `INSERT INTO repos (id, org_id, repo_full_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [`${orgId}:${repoFullName}`, orgId, repoFullName],
  );
}

describe('default workspaces and repo-linked projects (real Postgres)', () => {
  const orgFresh = 'org-default-fresh';
  const orgExisting = 'org-default-existing';
  const orgOther = 'org-default-other';
  let adminUserId: number;
  let memberUserId: number;
  let admin: { principalId: string; sessionVersion: number };
  let member: { principalId: string; sessionVersion: number };

  beforeAll(async () => {
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();
    adminUserId = await seedUser(DATABASE_URL, { githubId: 7101, login: 'default-admin' });
    memberUserId = await seedUser(DATABASE_URL, { githubId: 7102, login: 'default-member' });
    await seedOrgMembership(DATABASE_URL, adminUserId, orgFresh, 'admin');
    await seedOrgMembership(DATABASE_URL, adminUserId, orgExisting, 'admin');
    await seedOrgMembership(DATABASE_URL, adminUserId, orgOther, 'admin');
    await seedOrgMembership(DATABASE_URL, memberUserId, orgFresh, 'member');
    const a = await ensureGithubPrincipal({ userId: adminUserId, displayName: 'Admin', email: null });
    const m = await ensureGithubPrincipal({ userId: memberUserId, displayName: 'Member', email: null });
    admin = { principalId: a.id, sessionVersion: a.sessionVersion };
    member = { principalId: m.id, sessionVersion: m.sessionVersion };
  });

  afterAll(async () => {
    await closePool();
  });

  it('is exported from the package index', () => {
    expect(ensureDefaultWorkspace).toBeTypeOf('function');
    expect(packageIndex.ensureDefaultWorkspace).toBe(ensureDefaultWorkspace);
    expect(packageIndex.enrollOrgAdminInDefaultWorkspaces).toBe(enrollOrgAdminInDefaultWorkspaces);
  });

  it('creates a default workspace named after the org when none exists', async () => {
    const created = await ensureDefaultWorkspace(orgFresh);
    expect(created).toMatchObject({ name: `Org ${orgFresh}`, created: true });
    const rows = await rawQuery(
      `SELECT org_id, idempotency_key, created_by_principal_id FROM collab_workspaces WHERE id = $1`,
      [created!.id],
    );
    expect(rows).toEqual([
      { org_id: orgFresh, idempotency_key: `default-workspace:${orgFresh}`, created_by_principal_id: null },
    ]);
    const roles = await rawQuery(
      `SELECT name FROM collab_roles WHERE workspace_id = $1 AND is_system ORDER BY name`,
      [created!.id],
    );
    expect(roles.map((r) => r.name)).toEqual(['collaborator', 'manager', 'operator', 'reviewer', 'viewer']);
    const members = await rawQuery(`SELECT 1 FROM collab_memberships WHERE workspace_id = $1`, [created!.id]);
    expect(members).toHaveLength(0);
  });

  it('is idempotent: a second call returns the same workspace with created:false', async () => {
    const first = await ensureDefaultWorkspace(orgFresh);
    const second = await ensureDefaultWorkspace(orgFresh, { createdByPrincipalId: admin.principalId });
    expect(second).toEqual({ id: first!.id, name: first!.name, created: false });
    const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [orgFresh]);
    expect(count[0].n).toBe(1);
  });

  it('never creates two rows under concurrent calls', async () => {
    const org = 'org-default-race';
    await rawQuery(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [org]);
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureDefaultWorkspace(org)));
    expect(new Set(results.map((r) => r!.id)).size).toBe(1);
    expect(results.filter((r) => r!.created)).toHaveLength(1);
    const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [org]);
    expect(count[0].n).toBe(1);
  });

  it('rejects manual bootstrap with a reserved default-workspace key after authorization', async () => {
    await expect(
      bootstrapCollaborationWorkspace({
        actor: admin,
        orgId: orgOther,
        name: 'Reserved Key Workspace',
        idempotencyKey: defaultWorkspaceIdempotencyKey(orgFresh),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_idempotency_key' });
    const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [orgOther]);
    expect(count[0].n).toBe(0);
  });

  it('returns a typed conflict when a foreign workspace already owns the default key', async () => {
    const targetOrg = 'org-default-collision-target';
    const ownerOrg = 'org-default-collision-owner';
    await rawQuery(`INSERT INTO orgs (id, name) VALUES ($1, $1), ($2, $2)`, [targetOrg, ownerOrg]);
    await rawQuery(
      `INSERT INTO collab_workspaces (name, org_id, idempotency_key) VALUES ($1, $2, $3)`,
      ['Foreign workspace', ownerOrg, defaultWorkspaceIdempotencyKey(targetOrg)],
    );

    await expect(ensureDefaultWorkspace(targetOrg)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_conflict',
    });
    const rows = await rawQuery(`SELECT id, org_id FROM collab_workspaces WHERE idempotency_key = $1`, [
      defaultWorkspaceIdempotencyKey(targetOrg),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).toBe(ownerOrg);
  });

  it('lets a committed manual bootstrap win a concurrent default provisioning attempt', async () => {
    const org = 'org-default-manual-first-race';
    await seedOrgMembership(DATABASE_URL, adminUserId, org, 'admin');
    const blocker = new pg.Client({ connectionString: DATABASE_URL });
    let committed = false;
    let manualPending: Promise<{ id: string; name: string }>;
    let defaultPending: Promise<{ id: string; name: string; created: boolean } | null>;
    try {
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM orgs WHERE id = $1 FOR UPDATE`, [org]);
      manualPending = bootstrapCollaborationWorkspace({
        actor: admin,
        orgId: org,
        name: 'Manual first',
        idempotencyKey: 'manual-first-key',
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        const rows = await rawQuery(
          `SELECT count(*)::int AS n
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query = 'SELECT id FROM orgs WHERE id = $1 FOR UPDATE'`,
        );
        if (rows[0].n >= 1) break;
        if (Date.now() > deadline) throw new Error('manual bootstrap did not wait for the org lock');
      }
      defaultPending = ensureDefaultWorkspace(org);
      for (;;) {
        const rows = await rawQuery(
          `SELECT count(*)::int AS n
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query = 'SELECT id FROM orgs WHERE id = $1 FOR UPDATE'`,
        );
        if (rows[0].n >= 2) break;
        if (Date.now() > deadline) throw new Error('default provisioning did not wait for the org lock');
      }
      await blocker.query('COMMIT');
      committed = true;
      const [manual, defaultWorkspace] = await Promise.all([manualPending, defaultPending]);
      expect(defaultWorkspace).toEqual({ id: manual.id, name: 'Manual first', created: false });
      const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [org]);
      expect(count[0].n).toBe(1);
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      await Promise.allSettled([manualPending!, defaultPending!].filter(Boolean));
      await blocker.end();
    }
  }, 15000);

  it('returns an existing manually bootstrapped workspace untouched instead of creating a default one', async () => {
    const manual = await bootstrapCollaborationWorkspace({
      actor: admin,
      orgId: orgExisting,
      name: 'Manual Workspace',
      idempotencyKey: 'manual-existing-org',
    });
    const before = await rawQuery(`SELECT * FROM collab_workspaces WHERE id = $1`, [manual.id]);
    const result = await ensureDefaultWorkspace(orgExisting);
    expect(result).toEqual({ id: manual.id, name: 'Manual Workspace', created: false });
    const after = await rawQuery(`SELECT * FROM collab_workspaces WHERE id = $1`, [manual.id]);
    expect(after).toEqual(before);
    const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [orgExisting]);
    expect(count[0].n).toBe(1);
  });

  it('records createdByPrincipalId when one is given', async () => {
    const org = 'org-default-with-creator';
    await rawQuery(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [org]);
    const created = await ensureDefaultWorkspace(org, { createdByPrincipalId: admin.principalId });
    const rows = await rawQuery(`SELECT created_by_principal_id FROM collab_workspaces WHERE id = $1`, [created!.id]);
    expect(rows[0].created_by_principal_id).toBe(admin.principalId);
  });

  it('returns null and creates nothing for an org that is not provisioned', async () => {
    expect(await ensureDefaultWorkspace('org-not-provisioned')).toBeNull();
    const count = await rawQuery(`SELECT count(*)::int AS n FROM collab_workspaces WHERE org_id = $1`, [
      'org-not-provisioned',
    ]);
    expect(count[0].n).toBe(0);
  });

  it('enrolls org admins as manager of their default workspaces, idempotently, and never plain members', async () => {
    const workspace = await ensureDefaultWorkspace(orgFresh);
    const enrolled = await enrollOrgAdminInDefaultWorkspaces(admin.principalId);
    expect(enrolled).toContain(workspace!.id);
    expect(await enrollOrgAdminInDefaultWorkspaces(admin.principalId)).toEqual([]);
    expect(await enrollOrgAdminInDefaultWorkspaces(member.principalId)).toEqual([]);

    const roles = await rawQuery(
      `SELECT r.name FROM collab_memberships m JOIN collab_roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND m.principal_id = $2 AND m.project_id IS NULL`,
      [workspace!.id, admin.principalId],
    );
    expect(roles).toEqual([{ name: 'manager' }]);

    const manual = await rawQuery(`SELECT id FROM collab_workspaces WHERE org_id = $1`, [orgExisting]);
    const manualMembers = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_memberships WHERE workspace_id = $1`,
      [manual[0].id],
    );
    expect(manualMembers[0].n).toBe(1);

    const profile = await getPrincipalMeProfile(admin.principalId);
    expect(profile.workspaces.find((w) => w.id === workspace!.id)).toMatchObject({ orgId: orgFresh });
  });

  it('does not change an existing membership role when re-enrolling', async () => {
    const workspace = await ensureDefaultWorkspace(orgFresh);
    await rawQuery(
      `UPDATE collab_memberships SET role_id = (SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'viewer')
       WHERE workspace_id = $1 AND principal_id = $2`,
      [workspace!.id, admin.principalId],
    );
    expect(await enrollOrgAdminInDefaultWorkspaces(admin.principalId)).toEqual([]);
    const roles = await rawQuery(
      `SELECT r.name FROM collab_memberships m JOIN collab_roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND m.principal_id = $2`,
      [workspace!.id, admin.principalId],
    );
    expect(roles).toEqual([{ name: 'viewer' }]);
    await rawQuery(
      `UPDATE collab_memberships SET role_id = (SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'manager')
       WHERE workspace_id = $1 AND principal_id = $2`,
      [workspace!.id, admin.principalId],
    );
  });

  describe('repo-linked projects', () => {
    it('creates a standalone project with linkedRepoFullName null when no repo is given', async () => {
      const workspace = await ensureDefaultWorkspace(orgFresh);
      const project = await createCollabProject({ actor: admin, workspaceId: workspace!.id, name: 'Standalone' });
      expect(project.linkedRepoFullName).toBeNull();
    });

    it('links a project to a repo of the same org and returns it everywhere projects are read', async () => {
      await seedRepo(orgFresh, 'org-default-fresh/app');
      const workspace = await ensureDefaultWorkspace(orgFresh);
      const project = await createCollabProject({
        actor: admin,
        workspaceId: workspace!.id,
        name: 'app',
        repoFullName: 'org-default-fresh/app',
      });
      expect(project).toMatchObject({ name: 'app', linkedRepoFullName: 'org-default-fresh/app' });

      const profile = await getPrincipalMeProfile(admin.principalId);
      const listed = profile.workspaces.flatMap((w) => w.projects).find((p) => p.id === project.id);
      expect(listed?.linkedRepoFullName).toBe('org-default-fresh/app');

      const overview = await getCollabProjectOverview({ actor: admin, projectId: project.id });
      expect(overview.linkedRepoFullName).toBe('org-default-fresh/app');

      const stored = await rawQuery(`SELECT linked_repo_full_name FROM collab_projects WHERE id = $1`, [project.id]);
      expect(stored[0].linked_repo_full_name).toBe('org-default-fresh/app');
    });

    it('rejects a repo that does not exist with 422 invalid_repo', async () => {
      const workspace = await ensureDefaultWorkspace(orgFresh);
      await expect(
        createCollabProject({ actor: admin, workspaceId: workspace!.id, name: 'x', repoFullName: 'org-default-fresh/missing' }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_repo' });
    });

    it('rejects a repo that belongs to a different org with 422 invalid_repo', async () => {
      await seedRepo(orgOther, 'org-default-other/secret');
      const workspace = await ensureDefaultWorkspace(orgFresh);
      await expect(
        createCollabProject({ actor: admin, workspaceId: workspace!.id, name: 'x', repoFullName: 'org-default-other/secret' }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_repo' });
    });

    it('checks capability before the repo, so a non-member gets 404 and learns nothing about repos', async () => {
      const workspace = await ensureDefaultWorkspace(orgFresh);
      await expect(
        createCollabProject({ actor: member, workspaceId: workspace!.id, name: 'x', repoFullName: 'org-default-fresh/app' }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
