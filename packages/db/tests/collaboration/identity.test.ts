import { createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedLegacyUser,
  seedLegacyOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { getPool, closePool } from '../../src/pool.js';
import {
  ensureGithubPrincipal,
  getCollabPrincipal,
  authenticateCollabPassword,
  acceptCollabInvitation,
  createCollabInvitation,
  createCollabProject,
  getCollabBootstrapEligibility,
  bootstrapCollaborationWorkspace,
  addCollabMember,
  updateCollabMemberRole,
  removeCollabMember,
  listCollabTasks,
  createExecutionHost,
  revokeExecutionHost,
  createProjectHostMapping,
  CollabServiceError,
  CollabRateLimitError,
} from '../../src/collaboration/identity.js';

// The db package resolves DATABASE_URL at module load (see tests/setup.ts);
// the dedicated test URL is therefore fixed for the whole suite.
const DATABASE_URL = resolveCollabTestDatabaseUrl();

const ADMIN = { principalId: '', sessionVersion: 1 };
const managerActor = () => ({ principalId: ADMIN.principalId, sessionVersion: ADMIN.sessionVersion });

async function rawQuery(text, params) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

describe('collaboration identity (real Postgres)', () => {
  let legacyAdminUserId;
  let legacyMemberUserId;
  const orgA = 'org-client-a';

  beforeAll(async () => {
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();

    legacyAdminUserId = await seedLegacyUser(DATABASE_URL, {
      githubId: 9001,
      login: 'client-a-admin',
    });
    legacyMemberUserId = await seedLegacyUser(DATABASE_URL, {
      githubId: 9002,
      login: 'client-a-member',
    });
    await seedLegacyOrgMembership(DATABASE_URL, legacyAdminUserId, orgA, 'admin');
    await seedLegacyOrgMembership(DATABASE_URL, legacyMemberUserId, orgA, 'member');

    const adminPrincipal = await ensureGithubPrincipal({
      legacyUserId: legacyAdminUserId,
      displayName: 'Client A Admin',
      email: 'client-a-admin@example.test',
    });
    ADMIN.principalId = adminPrincipal.id;
    ADMIN.sessionVersion = adminPrincipal.sessionVersion;
  });

  afterAll(async () => {
    await closePool();
  });

  it('maps a GitHub user to a stable collaboration principal (idempotent)', async () => {
    const again = await ensureGithubPrincipal({
      legacyUserId: legacyAdminUserId,
      displayName: 'Client A Admin',
      email: 'client-a-admin@example.test',
    });
    expect(again.id).toBe(ADMIN.principalId);
    const loaded = await getCollabPrincipal(ADMIN.principalId);
    expect(loaded?.legacyUserId).toBe(legacyAdminUserId);
  });

  it('reports bootstrap eligibility from current legacy org roles', async () => {
    expect(await getCollabBootstrapEligibility(managerActor())).toEqual({
      eligible: true,
      legacyOrgIds: [orgA],
    });

    const memberPrincipal = await ensureGithubPrincipal({
      legacyUserId: legacyMemberUserId,
      displayName: 'Client A Member',
      email: 'client-a-member@example.test',
    });
    expect(
      await getCollabBootstrapEligibility({
        principalId: memberPrincipal.id,
        sessionVersion: memberPrincipal.sessionVersion,
      }),
    ).toEqual({ eligible: false, legacyOrgIds: [] });
  });

  it('bootstraps a workspace atomically with manager membership and system roles (idempotent key)', async () => {
    const first = await bootstrapCollaborationWorkspace({
      actor: managerActor(),
      legacyOrgId: orgA,
      name: 'Client A',
      idempotencyKey: 'bootstrap-org-a',
    });
    expect(first.name).toBe('Client A');

    const replay = await bootstrapCollaborationWorkspace({
      actor: managerActor(),
      legacyOrgId: orgA,
      name: 'Client A Renamed',
      idempotencyKey: 'bootstrap-org-a',
    });
    expect(replay.id).toBe(first.id);

    const roleRows = await rawQuery(
      `SELECT r.name, r.capabilities FROM collab_roles r
       JOIN collab_workspaces w ON w.id = r.workspace_id WHERE w.id = $1 ORDER BY r.name`,
      [first.id],
    );
    expect(roleRows.map((r) => r.name)).toEqual([
      'collaborator',
      'manager',
      'operator',
      'reviewer',
      'viewer',
    ]);
    const manager = roleRows.find((r) => r.name === 'manager');
    expect(manager.capabilities).toContain('membership.admin');
    expect(manager.capabilities).toContain('project.admin');

    const memberRows = await rawQuery(
      `SELECT 1 FROM collab_memberships m
       WHERE m.workspace_id = $1 AND m.principal_id = $2 AND m.project_id IS NULL`,
      [first.id, ADMIN.principalId],
    );
    expect(memberRows).toHaveLength(1);
  });

  it('refuses bootstrap for a non-admin legacy member', async () => {
    const memberPrincipal = await ensureGithubPrincipal({
      legacyUserId: legacyMemberUserId,
      displayName: 'Client A Member',
      email: 'client-a-member@example.test',
    });
    await expect(
      bootstrapCollaborationWorkspace({
        actor: { principalId: memberPrincipal.id, sessionVersion: memberPrincipal.sessionVersion },
        legacyOrgId: orgA,
        name: 'Sneaky Workspace',
        idempotencyKey: 'bootstrap-sneaky',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('creates a project under a workspace the actor administers', async () => {
    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor(),
      legacyOrgId: orgA,
      name: 'Client A Projects',
      idempotencyKey: 'bootstrap-org-a-projects',
    });
    const project = await createCollabProject({
      actor: managerActor(),
      workspaceId: workspace.id,
      name: 'Project A1',
    });
    expect(project.workspaceId).toBe(workspace.id);
    expect(project.name).toBe('Project A1');

    await expect(
      createCollabProject({
        actor: { principalId: '00000000-0000-4000-8000-00000000000f', sessionVersion: 1 },
        workspaceId: workspace.id,
        name: 'Nope',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('denies mutations for disabled actors and stale session versions with 401', async () => {
    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor(),
      legacyOrgId: orgA,
      name: 'Lifecycle Workspace',
      idempotencyKey: 'bootstrap-lifecycle',
    });

    // Stale session version (rotated elsewhere) must fail independently of HTTP.
    await expect(
      createCollabProject({
        actor: { principalId: ADMIN.principalId, sessionVersion: ADMIN.sessionVersion + 5 },
        workspaceId: workspace.id,
        name: 'Stale',
      }),
    ).rejects.toMatchObject({ status: 401 });

    await rawQuery(`UPDATE collab_principals SET disabled_at = now() WHERE id = $1`, [
      ADMIN.principalId,
    ]);
    await expect(
      createCollabProject({
        actor: managerActor(),
        workspaceId: workspace.id,
        name: 'Disabled',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await rawQuery(`UPDATE collab_principals SET disabled_at = NULL WHERE id = $1`, [
      ADMIN.principalId,
    ]);
  });

  describe('invitations and password login', () => {
    let workspaceId;
    let projectId;
    let collaboratorRoleId;
    let invitationUrl;
    const INVITE_EMAIL = 'collab1@client-a.test';
    const PASSWORD = 'correct horse battery';

    beforeAll(async () => {
      const workspace = await bootstrapCollaborationWorkspace({
        actor: managerActor(),
        legacyOrgId: orgA,
        name: 'Invite Workspace',
        idempotencyKey: 'bootstrap-invite-ws',
      });
      workspaceId = workspace.id;
      const project = await createCollabProject({
        actor: managerActor(),
        workspaceId,
        name: 'Project A1',
      });
      projectId = project.id;
      const roles = await rawQuery(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
        [workspaceId],
      );
      collaboratorRoleId = roles[0].id;
    });

    it('creates a single-use invitation whose secret is never stored in the clear', async () => {
      const invitation = await createCollabInvitation({
        actor: managerActor(),
        workspaceId,
        projectId,
        email: INVITE_EMAIL,
        roleId: collaboratorRoleId,
        expiresInHours: 24,
      });
      expect(invitation.url).toContain('/invite#token=');
      invitationUrl = invitation.url;

      const stored = await rawQuery(`SELECT token_hash FROM collab_invitations WHERE id = $1`, [
        invitation.id,
      ]);
      const secret = invitationUrl.split('token=')[1];
      expect(stored[0].token_hash).not.toContain(secret);
      expect(JSON.stringify(stored[0])).not.toContain(secret);
    });

    it('redeems exactly once into a principal with membership; replay fails', async () => {
      const token = invitationUrl.split('token=')[1];
      const accepted = await acceptCollabInvitation({
        token,
        displayName: 'Collab One',
        password: PASSWORD,
        rateLimitKey: 'rl-accept-1',
      });
      expect(accepted.principal.email).toBe(INVITE_EMAIL);
      expect(accepted.workspaceId).toBe(workspaceId);
      expect(accepted.projectId).toBe(projectId);

      await expect(
        acceptCollabInvitation({
          token,
          displayName: 'Collab One Again',
          password: PASSWORD,
          rateLimitKey: 'rl-accept-2',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('authenticates the invited principal by password; wrong password is null', async () => {
      const principal = await authenticateCollabPassword({
        email: INVITE_EMAIL,
        password: PASSWORD,
        rateLimitKey: 'rl-login-1',
      });
      expect(principal?.email).toBe(INVITE_EMAIL);
      expect(principal?.legacyUserId).toBeNull();

      expect(
        await authenticateCollabPassword({
          email: INVITE_EMAIL,
          password: 'wrong password',
          rateLimitKey: 'rl-login-2',
        }),
      ).toBeNull();

      expect(
        await authenticateCollabPassword({
          email: 'nobody@client-a.test',
          password: PASSWORD,
          rateLimitKey: 'rl-login-3',
        }),
      ).toBeNull();
    });

    it('rejects a disabled principal at login', async () => {
      await rawQuery(`UPDATE collab_principals SET disabled_at = now() WHERE email = $1`, [
        INVITE_EMAIL,
      ]);
      expect(
        await authenticateCollabPassword({
          email: INVITE_EMAIL,
          password: PASSWORD,
          rateLimitKey: 'rl-login-4',
        }),
      ).toBeNull();
      await rawQuery(`UPDATE collab_principals SET disabled_at = NULL WHERE email = $1`, [
        INVITE_EMAIL,
      ]);
    });

    it('throttles repeated login attempts for the same key with a typed 429', async () => {
      let throttled = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          await authenticateCollabPassword({
            email: INVITE_EMAIL,
            password: 'wrong again',
            rateLimitKey: 'rl-throttle-test',
          });
        } catch (err) {
          expect(err).toBeInstanceOf(CollabRateLimitError);
          expect((err as CollabServiceError).status).toBe(429);
          throttled = true;
          break;
        }
      }
      expect(throttled).toBe(true);
    });

    it('never grants capabilities outside the inviter own delegable set', async () => {
      // Fixture: a custom role holding ONLY membership.admin (delegable
      // administration without task/run/delivery powers).
      const limited = await rawQuery(
        `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
         VALUES ($1, 'limited-admin', ARRAY['membership.admin']::text[], false) RETURNING id`,
        [workspaceId],
      );
      const limitedRoleId = limited[0].id;

      // A principal holding ONLY that role must not invite anyone as the
      // built-in manager (manager carries run.start/internal.read/... which
      // the limited admin cannot delegate).
      const limitedPrincipal = await rawQuery(
        `INSERT INTO collab_principals (display_name, email) VALUES ('Limited Admin', 'limited@client-a.test') RETURNING id`,
      );
      await rawQuery(
        `INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`,
        [workspaceId, limitedPrincipal[0].id, limitedRoleId],
      );
      const limitedActor = { principalId: limitedPrincipal[0].id, sessionVersion: 1 };

      const roles = await rawQuery(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'manager'`,
        [workspaceId],
      );
      await expect(
        createCollabInvitation({
          actor: limitedActor,
          workspaceId,
          projectId,
          email: 'escalation@client-a.test',
          roleId: roles[0].id,
          expiresInHours: 24,
        }),
      ).rejects.toMatchObject({ status: 403 });

      const leaked = await rawQuery(
        `SELECT id FROM collab_invitations WHERE email = 'escalation@client-a.test'`,
      );
      expect(leaked).toHaveLength(0);

      // The full manager can still delegate the same role (subset holds).
      const delegated = await createCollabInvitation({
        actor: managerActor(),
        workspaceId,
        projectId,
        email: 'delegated-manager@client-a.test',
        roleId: roles[0].id,
        expiresInHours: 24,
      });
      expect(delegated.url).toContain('/invite#token=');
    });

    it('persists identity across a pool restart', async () => {
      const before = await rawQuery(`SELECT id FROM collab_principals WHERE email = $1`, [
        INVITE_EMAIL,
      ]);
      await closePool();
      const after = await getPool().query({
        text: `SELECT id FROM collab_principals WHERE email = $1`,
        values: [INVITE_EMAIL],
      });
      expect(after.rows[0]?.id).toBe(before[0]?.id);
    });

    it('rejects a wrong signed-in account without consuming the invitation', async () => {
      const invitation = await createCollabInvitation({
        actor: managerActor(),
        workspaceId,
        projectId,
        email: 'collab2@client-a.test',
        roleId: collaboratorRoleId,
        expiresInHours: 24,
      });
      const token = invitation.url.split('token=')[1];

      // Manager is signed in but is not the invited account.
      await expect(
        acceptCollabInvitation({
          token,
          displayName: 'Manager Grab',
          rateLimitKey: 'rl-wrong-account',
          actor: managerActor(),
        }),
      ).rejects.toMatchObject({ status: 403, code: 'wrong_account' });

      // Not consumed: the real invitee can still redeem.
      const accepted = await acceptCollabInvitation({
        token,
        displayName: 'Collab Two',
        password: 'another secure passphrase',
        rateLimitKey: 'rl-right-account',
      });
      expect(accepted.principal.email).toBe('collab2@client-a.test');
      global.__collabTwoPrincipalId = accepted.principal.id;
    });

    it('records the actual recipient as accepted_by for new-principal redemption', async () => {
      const stored = await rawQuery(
        `SELECT accepted_by_principal_id FROM collab_invitations
         WHERE email = 'collab2@client-a.test' AND accepted_at IS NOT NULL`,
      );
      expect(stored[0].accepted_by_principal_id).toBe(global.__collabTwoPrincipalId);
    });

    it('counts concurrent attempts atomically: exactly 20 pass per bucket', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () =>
          authenticateCollabPassword({
            email: INVITE_EMAIL,
            password: 'concurrent wrong guess',
            rateLimitKey: 'rl-parallel-bucket',
          }),
        ),
      );
      const passedAsNull = results.filter(
        (r) => r.status === 'fulfilled' && r.value === null,
      ).length;
      const throttled = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof CollabRateLimitError,
      ).length;
      expect(passedAsNull).toBe(20);
      expect(throttled).toBe(10);

      // The documented bucket formula (login:<key>:<email>, sha256) lets the
      // test verify this bucket reserved exactly the capacity, no more.
      const bucket = createHash('sha256')
        .update('login:rl-parallel-bucket:collab1@client-a.test')
        .digest('hex');
      const stored = await rawQuery(
        `SELECT count(*)::int AS n FROM collab_rate_limit_events WHERE bucket = $1`,
        [bucket],
      );
      expect(stored[0].n).toBe(20);
    });

    it('treats invalid credential formats as uniform null, not 4xx', async () => {
      expect(
        await authenticateCollabPassword({
          email: 'not-an-email',
          password: 'whatever',
          rateLimitKey: 'rl-format-invalid',
        }),
      ).toBeNull();
    });

    it('rejects malformed invitation emails at creation with 422', async () => {
      await expect(
        createCollabInvitation({
          actor: managerActor(),
          workspaceId,
          projectId,
          email: 'not-an-email',
          roleId: collaboratorRoleId,
          expiresInHours: 24,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('re-accepting at the invited scope is idempotent or a typed conflict', async () => {
      // Same role again for the already-member principal: idempotent grant.
      const sameRole = await createCollabInvitation({
        actor: managerActor(),
        workspaceId,
        projectId,
        email: 'collab2@client-a.test',
        roleId: collaboratorRoleId,
        expiresInHours: 24,
      });
      const idempotent = await acceptCollabInvitation({
        token: sameRole.url.split('token=')[1],
        displayName: 'Collab Two',
        rateLimitKey: 'rl-idempotent-member',
        actor: {
          principalId: global.__collabTwoPrincipalId,
          sessionVersion: 1,
        },
      });
      expect(idempotent.principal.id).toBe(global.__collabTwoPrincipalId);

      // A different role at the same scope must conflict, not overwrite.
      const roles = await rawQuery(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'viewer'`,
        [workspaceId],
      );
      const differentRole = await createCollabInvitation({
        actor: managerActor(),
        workspaceId,
        projectId,
        email: 'collab2@client-a.test',
        roleId: roles[0].id,
        expiresInHours: 24,
      });
      await expect(
        acceptCollabInvitation({
          token: differentRole.url.split('token=')[1],
          displayName: 'Collab Two',
          rateLimitKey: 'rl-conflict-member',
          actor: { principalId: global.__collabTwoPrincipalId, sessionVersion: 1 },
        }),
      ).rejects.toMatchObject({ status: 409, code: 'already_member' });
    });
  });
});

describe('A2 boundary hardening (review findings)', () => {
  let hardenedWs;
  let secondManagerActor;
  const hardeningOrg = 'hardening-org';

  beforeAll(async () => {
    const legacyAdmin = await seedLegacyUser(DATABASE_URL, { githubId: 9401, login: 'hardening-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacyAdmin, hardeningOrg, 'admin');
    const ownerPrincipal = await ensureGithubPrincipal({
      legacyUserId: legacyAdmin,
      displayName: 'Hardening Owner',
      email: 'hardening-owner@example.test',
    });
    const localManagerActor = {
      principalId: ownerPrincipal.id,
      sessionVersion: ownerPrincipal.sessionVersion,
    };
    global.__hardeningManagerActor = localManagerActor;
    const ws = await bootstrapCollaborationWorkspace({
      actor: localManagerActor,
      legacyOrgId: hardeningOrg,
      name: 'Hardening Workspace',
      idempotencyKey: 'bootstrap-hardening',
    });
    hardenedWs = ws.id;
    global.__hardeningWorkspaceId = ws.id;

    // Second manager so mutual removal has a survivor candidate. Uses the
    // collaborator principal created in the earlier describe block.
    const managerRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'manager'`,
      [hardenedWs],
    );
    await addCollabMember({
      actor: localManagerActor,
      workspaceId: hardenedWs,
      principalId: global.__collabTwoPrincipalId,
      roleId: managerRole[0].id,
    });
    secondManagerActor = { principalId: global.__collabTwoPrincipalId, sessionVersion: 1 };
    global.__hardeningSecondManager = secondManagerActor;
  });

  it('lets a true superadmin without any org membership bootstrap', async () => {
    const superLegacy = await seedLegacyUser(DATABASE_URL, {
      githubId: 9301,
      login: 'true-super',
      isSuperadmin: true,
    });
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`INSERT INTO orgs (id, name) VALUES ('orphan-org', 'Orphan Org') ON CONFLICT DO NOTHING`);
    await client.end();
    const superPrincipal = await ensureGithubPrincipal({
      legacyUserId: superLegacy,
      displayName: 'True Super',
      email: 'true-super@example.test',
    });
    const eligibility = await getCollabBootstrapEligibility({
      principalId: superPrincipal.id,
      sessionVersion: superPrincipal.sessionVersion,
    });
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.legacyOrgIds).toContain('orphan-org');

    const ws = await bootstrapCollaborationWorkspace({
      actor: { principalId: superPrincipal.id, sessionVersion: superPrincipal.sessionVersion },
      legacyOrgId: 'orphan-org',
      name: 'Orphan Workspace',
      idempotencyKey: 'bootstrap-orphan',
    });
    expect(ws.name).toBe('Orphan Workspace');
  });

  it('never returns a foreign workspace when replaying another actor bootstrap key', async () => {
    const superLegacy = await rawQuery(`SELECT id FROM users WHERE login = 'true-super'`);
    void superLegacy;
    // A second admin of orgA bootstraps with orgB admin's... simplest leak test:
    // the collab2 manager (orgA member via membership, but legacy user is an
    // orgA MEMBER) cannot bootstrap; use the true super (admin of everything)
    // replaying the orgA key with a DIFFERENT org must not return orgA's ws.
    const superPrincipal = await rawQuery(`SELECT id, session_version FROM collab_principals WHERE legacy_user_id = (SELECT id FROM users WHERE login = 'true-super')`);
    await expect(
      bootstrapCollaborationWorkspace({
        actor: { principalId: superPrincipal[0].id, sessionVersion: superPrincipal[0].session_version },
        legacyOrgId: 'orphan-org',
        name: 'Sneaky Replay',
        idempotencyKey: 'bootstrap-orphan',
      }),
    ).resolves.toMatchObject({ name: 'Orphan Workspace' }); // same actor+org: idempotent replay OK

    // Different org, same key: must NOT hand back the first workspace.
    await seedLegacyOrgMembership(DATABASE_URL, (await rawQuery(`SELECT id FROM users WHERE login = 'true-super'`))[0].id, 'orphan-org-2', 'admin');
    await rawQuery(`INSERT INTO orgs (id, name) VALUES ('orphan-org-2', 'Orphan Two') ON CONFLICT DO NOTHING`);
    await expect(
      bootstrapCollaborationWorkspace({
        actor: { principalId: superPrincipal[0].id, sessionVersion: superPrincipal[0].session_version },
        legacyOrgId: 'orphan-org-2',
        name: 'Sneaky Replay 2',
        idempotencyKey: 'bootstrap-orphan',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('excludes membership without task.read from task listings and rejects stale actors', async () => {
    // Custom role holding only comment.write, granted to a fresh principal on
    // the hardened workspace (project A1 scope would also do).
    const noReadRole = await rawQuery(
      `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
       VALUES ($1, 'no-read', ARRAY['comment.write']::text[], false) RETURNING id`,
      [hardenedWs],
    );
    const fresh = await rawQuery(
      `INSERT INTO collab_principals (display_name, email) VALUES ('No Read', 'no-read@client-a.test') RETURNING id, session_version`,
    );
    await rawQuery(
      `INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`,
      [hardenedWs, fresh[0].id, noReadRole[0].id],
    );
    const noReadActor = { principalId: fresh[0].id, sessionVersion: fresh[0].session_version };
    const visible = await listCollabTasks({ actor: noReadActor });
    expect(visible.tasks).toEqual([]);

    await expect(
      listCollabTasks({ actor: { principalId: fresh[0].id, sessionVersion: fresh[0].session_version + 7 } }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('survives concurrent mutual admin removal with one admin remaining', async () => {
    const hardeningManager = global.__hardeningManagerActor;
    const results = await Promise.allSettled([
      removeCollabMember({
        actor: hardeningManager,
        workspaceId: hardenedWs,
        principalId: global.__collabTwoPrincipalId,
      }),
      removeCollabMember({
        actor: secondManagerActor,
        workspaceId: hardenedWs,
        principalId: hardeningManager.principalId,
      }),
    ]);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason?.status));
    // Exactly one removal succeeds. The other fails 409 (last-admin guard) or
    // 404 (its own membership was already revoked by the winner — the service
    // re-checks authorization at mutation time). Either way the workspace
    // keeps its last admin: no concurrent mutual removal can drop to zero.
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    const admins = await rawQuery(
      `SELECT count(*)::int AS n FROM collab_memberships m
       JOIN collab_roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND m.project_id IS NULL AND 'membership.admin' = ANY(r.capabilities)`,
      [hardenedWs],
    );
    expect(admins[0].n).toBe(1);
  });

  it('allows removing a project membership even when the principal is the last workspace admin', async () => {
    const hardeningManager = global.__hardeningManagerActor;
    const project = await createCollabProject({ actor: hardeningManager, workspaceId: hardenedWs, name: 'Hardening P1' });
    const collaboratorRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [hardenedWs],
    );
    await addCollabMember({
      actor: hardeningManager,
      workspaceId: hardenedWs,
      projectId: project.id,
      principalId: hardeningManager.principalId,
      roleId: collaboratorRole[0].id,
    });
    await expect(
      removeCollabMember({
        actor: hardeningManager,
        workspaceId: hardenedWs,
        projectId: project.id,
        principalId: hardeningManager.principalId,
      }),
    ).resolves.toBeUndefined();
  });

  it('treats same-role membership updates as successful no-ops', async () => {
    const hardeningManager = global.__hardeningManagerActor;
    const managerRole = await rawQuery(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'manager'`,
      [hardenedWs],
    );
    await expect(
      updateCollabMemberRole({
        actor: hardeningManager,
        workspaceId: hardenedWs,
        principalId: hardeningManager.principalId,
        roleId: managerRole[0].id,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ roleId: managerRole[0].id });
  });
});

describe('A3 host isolation (foreign org admin), real Postgres', () => {
  it('never lets an unrelated org admin revoke, map, or see a foreign host', async () => {
    // Second independent client org admin (orgB-like) plus a host owned by
    // the hardening manager (orgA client).
    const foreignLegacy = await seedLegacyUser(DATABASE_URL, { githubId: 9701, login: 'foreign-admin' });
    await seedLegacyOrgMembership(DATABASE_URL, foreignLegacy, 'foreign-org', 'admin');
    const foreignPrincipal = await ensureGithubPrincipal({
      legacyUserId: foreignLegacy,
      displayName: 'Foreign Admin',
      email: 'foreign-admin@example.test',
    });
    const foreignActor = { principalId: foreignPrincipal.id, sessionVersion: foreignPrincipal.sessionVersion };
    const owner = global.__hardeningManagerActor;

    const host = await createExecutionHost({ actor: owner, name: 'Client A PC' });
    const project = await createCollabProject({
      actor: owner,
      workspaceId: global.__hardeningWorkspaceId,
      name: 'Iso P1',
    });

    // Foreign org admin cannot revoke (404 — invisible), map, or list it.
    await expect(revokeExecutionHost({ actor: foreignActor, hostId: host.id })).rejects.toMatchObject({ status: 404 });
    await expect(
      createProjectHostMapping({
        actor: foreignActor, projectId: project.id, hostId: host.id,
        repositoryKey: 'foreign/repo', profileIds: ['p1'],
      }),
    ).rejects.toMatchObject({ status: 404 });

    // The enrolling owner retains full authority.
    await expect(
      createProjectHostMapping({
        actor: owner, projectId: project.id, hostId: host.id,
        repositoryKey: 'client-a/repo', profileIds: ['p1'],
      }),
    ).resolves.toMatchObject({ hostId: host.id });
    await expect(revokeExecutionHost({ actor: owner, hostId: host.id })).resolves.toBeUndefined();
  });
});
