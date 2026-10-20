import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// Standard test silencing only — real app, real DB, real crypto. Dynamic
// imports are required by the repo's vi.mock hoisting convention and by env
// ordering: @fluent-flow/db resolves DATABASE_URL at module load.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } =
  await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();

const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const { signCollaborationActor } = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

function actorHeader(principalId, sessionVersion) {
  return signCollaborationActor({ principalId, sessionVersion }, TEST_AUTH_SECRET);
}

async function api(baseUrl, method, path, { actor, body } = {}) {
  const headers = {};
  if (actor) headers['x-fluent-flow-actor'] = actorHeader(actor.principalId, actor.sessionVersion);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/collab/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('A1 backlog acceptance: identity, task capture, client isolation, revocation', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let clientBActor;
  let workspaceAId;
  let projectA1Id;
  let projectB1Id;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const { runMigrations, ensureGithubPrincipal, bootstrapCollaborationWorkspace, createCollabProject, getPool } =
      await import('@fluent-flow/db');
    await runMigrations();

    // Fixture: two GitHub org admins (client A and client B), one org each.
    const adminA = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9101, login: 'owner-a' });
    const adminB = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9102, login: 'owner-b' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, adminA, 'org-a', 'admin');
    await seedLegacyOrgMembership(process.env.DATABASE_URL, adminB, 'org-b', 'admin');

    const principalA = await ensureGithubPrincipal({
      legacyUserId: adminA,
      displayName: 'Owner A',
      email: 'owner-a@example.test',
    });
    const principalB = await ensureGithubPrincipal({
      legacyUserId: adminB,
      displayName: 'Owner B',
      email: 'owner-b@example.test',
    });
    managerActor = { principalId: principalA.id, sessionVersion: principalA.sessionVersion };
    clientBActor = { principalId: principalB.id, sessionVersion: principalB.sessionVersion };

    const wsA = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-a',
      name: 'Client A',
      idempotencyKey: 'fixture-ws-a',
    });
    workspaceAId = wsA.id;
    const pA1 = await createCollabProject({ actor: managerActor, workspaceId: workspaceAId, name: 'Project A1' });
    projectA1Id = pA1.id;
    const wsB = await bootstrapCollaborationWorkspace({
      actor: clientBActor,
      legacyOrgId: 'org-b',
      name: 'Client B',
      idempotencyKey: 'fixture-ws-b',
    });
    const pB1 = await createCollabProject({ actor: clientBActor, workspaceId: wsB.id, name: 'Project B1' });
    projectB1Id = pB1.id;

    const { rows } = await getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [workspaceAId],
    );
    global.__fixtureCollaboratorRoleId = rows[0].id;

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('invites a collaborator whose secret is only in the authorized response', async () => {
    const res = await api(baseUrl, 'POST', `/projects/${projectA1Id}/invitations`, {
      actor: managerActor,
      body: {
        email: 'collab1@client-a.test',
        roleId: global.__fixtureCollaboratorRoleId,
        expiresInHours: 24,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.url).toContain('/invite#token=');
    global.__inviteUrl = res.body.data.url;
  });

  it('redeems the invitation exactly once via the public accept route', async () => {
    const token = global.__inviteUrl.split('token=')[1];
    const res = await api(baseUrl, 'POST', '/invitations/accept', {
      body: { token, displayName: 'Collab One', password: 'correct horse battery' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.principal.email).toBe('collab1@client-a.test');
    expect(res.body.data.workspaceId).toBe(workspaceAId);
    expect(res.body.data.projectId).toBe(projectA1Id);
    collaboratorActor = {
      principalId: res.body.data.principal.id,
      sessionVersion: res.body.data.principal.sessionVersion,
    };

    const replay = await api(baseUrl, 'POST', '/invitations/accept', {
      body: { token, displayName: 'Collab One', password: 'correct horse battery' },
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).not.toContain('token');
  });

  it('shows /me with the authorized project and capabilities only', async () => {
    const res = await api(baseUrl, 'GET', '/me', { actor: collaboratorActor });
    expect(res.status).toBe(200);
    expect(res.body.data.principal.id).toBe(collaboratorActor.principalId);
    const projectIds = res.body.data.workspaces.flatMap((w) => w.projects.map((p) => p.id));
    expect(projectIds).toContain(projectA1Id);
    expect(projectIds).not.toContain(projectB1Id);
    // Capabilities are a top-level per-project map (B's agreed wire shape).
    expect(res.body.data.capabilities[projectA1Id]).toContain('task.write');
    expect(res.body.data.capabilities[projectA1Id]).not.toContain('run.start');
    expect(res.body.data.capabilities[projectB1Id]).toBeUndefined();
    expect(res.body.data.workspaces.every((w) => typeof w.id === 'string' && Array.isArray(w.projects))).toBe(true);
  });

  it('creates a task with no repository, run or host prerequisite', async () => {
    const created = await api(baseUrl, 'POST', `/projects/${projectA1Id}/tasks`, {
      actor: collaboratorActor,
      body: { title: 'Draft onboarding copy', description: 'No repo needed to capture this.' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('backlog');
    expect(created.body.data.version).toBe(1);
    global.__taskA = created.body.data;

    const list = await api(baseUrl, 'GET', `/tasks?projectId=${projectA1Id}`, {
      actor: collaboratorActor,
    });
    expect(list.status).toBe(200);
    expect(list.body.data.map((t) => t.id)).toContain(global.__taskA.id);

    const detail = await api(baseUrl, 'GET', `/tasks/${global.__taskA.id}`, {
      actor: collaboratorActor,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.capabilities).toContain('task.write');
  });

  it('isolates client B: own project visible, client A task not found', async () => {
    const own = await api(baseUrl, 'POST', `/projects/${projectB1Id}/tasks`, {
      actor: clientBActor,
      body: { title: 'Client B item' },
    });
    expect(own.status).toBe(201);

    const listB = await api(baseUrl, 'GET', '/tasks', { actor: clientBActor });
    expect(listB.status).toBe(200);
    const idsB = listB.body.data.map((t) => t.id);
    expect(idsB).toContain(own.body.data.id);
    expect(idsB).not.toContain(global.__taskA.id);

    const direct = await api(baseUrl, 'GET', `/tasks/${global.__taskA.id}`, { actor: clientBActor });
    expect(direct.status).toBe(404);
    expect(direct.body.error.code).toBe('not_found');

    const writeIntoA = await api(baseUrl, 'POST', `/projects/${projectA1Id}/tasks`, {
      actor: clientBActor,
      body: { title: 'Sneaky write' },
    });
    expect(writeIntoA.status).toBe(404);
  });

  it('revocation denies the next request for the revoked principal', async () => {
    const revoked = await api(
      baseUrl,
      'DELETE',
      `/projects/${projectA1Id}/members/${collaboratorActor.principalId}`,
      { actor: managerActor },
    );
    expect(revoked.status).toBe(204);

    const after = await api(baseUrl, 'GET', `/tasks/${global.__taskA.id}`, {
      actor: collaboratorActor,
    });
    expect(after.status).toBe(404);
  });

  it('ignores body-supplied actors on redemption — only the signed header counts', async () => {
    const inv = await api(baseUrl, 'POST', `/projects/${projectA1Id}/invitations`, {
      actor: managerActor,
      body: { email: 'forged@client-a.test', roleId: global.__fixtureCollaboratorRoleId, expiresInHours: 24 },
    });
    const token = inv.body.data.url.split('token=')[1];

    // Forged body.actor claims the manager identity, no header, no password:
    // if the body were trusted the redeem would succeed as manager. It must
    // be treated as an anonymous redemption → password required, not consumed.
    const forged = await api(baseUrl, 'POST', '/invitations/accept', {
      body: { token, displayName: 'Forged', actor: managerActor },
    });
    expect(forged.status).toBe(422);
    expect(forged.body.error.code).toBe('password_required');

    // Still redeemable properly: the invitation was not consumed.
    const legit = await api(baseUrl, 'POST', '/invitations/accept', {
      body: { token, displayName: 'Forged Collab', password: 'a real good password' },
    });
    expect(legit.status).toBe(201);
    expect(legit.body.data.principal.email).toBe('forged@client-a.test');
  });

  it('derives the redemption actor from the signed header (wrong account rejected)', async () => {
    const inv = await api(baseUrl, 'POST', `/projects/${projectA1Id}/invitations`, {
      actor: managerActor,
      body: { email: 'header-check@client-a.test', roleId: global.__fixtureCollaboratorRoleId, expiresInHours: 24 },
    });
    const token = inv.body.data.url.split('token=')[1];

    // Client B signs the header and also forges body.actor for themselves:
    // the header-derived identity (email mismatch) is what gets enforced.
    const res = await api(baseUrl, 'POST', '/invitations/accept', {
      actor: clientBActor,
      body: { token, displayName: 'Client B', actor: clientBActor },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_account');
  });

  it('blocks removing the last workspace membership admin with 409', async () => {
    const res = await api(baseUrl, 'PATCH', `/workspaces/${workspaceAId}/members/${managerActor.principalId}`, {
      actor: managerActor,
      body: { roleId: (await roleForViewer()), expectedVersion: 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_admin');

    async function roleForViewer() {
      const { getPool } = await import('@fluent-flow/db');
      const { rows } = await getPool().query(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'viewer'`,
        [workspaceAId],
      );
      return rows[0].id;
    }
  });
});
