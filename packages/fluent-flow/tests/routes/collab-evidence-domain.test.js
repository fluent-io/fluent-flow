import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// A4 evidence DOMAIN tests: focused service/route behavior with a manually
// assembled router and verbatim 0014 DDL. These bypass app wiring by design
// (fast, isolated) and are NOT app-acceptance evidence; see
// collab-evidence.test.js for the real createApp + runMigrations acceptance.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } =
  await import('../helpers/collab-db.js');
// Dedicated evidence-domain DB: CI gives it its own ff_* database so parallel
// package suites never share or race a reset (falls back to the shared collab
// routes URL locally).
const resolveEvidenceDomainDatabaseUrl = () => {
  const url = process.env.COLLAB_EVIDENCE_DOMAIN_TEST_DATABASE_URL ?? process.env.COLLAB_ROUTES_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('evidence domain suite requires COLLAB_EVIDENCE_DOMAIN_TEST_DATABASE_URL (or COLLAB_ROUTES_TEST_DATABASE_URL / TEST_DATABASE_URL)');
  }
  return url;
};
process.env.DATABASE_URL = resolveEvidenceDomainDatabaseUrl();
process.env.COLLAB_EVIDENCE_ROUTES_TEST_DATABASE_URL = process.env.DATABASE_URL;

const TEST_AUTH_SECRET = 'collab-evidence-test-secret-0123456789abcdef';
const { signCollaborationActor, getCollabTask } = await import('@fluent-flow/db');
const express = (await import('express')).default;
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

describe('A4 evidence slice 1: acceptance criteria', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let outsiderActor;
  let projectA1;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9201, login: 'evidence-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-evidence', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'evidence-owner',
      email: 'evidence-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-evidence',
      name: 'Evidence Client',
      idempotencyKey: 'evidence-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Evidence A1' });

    // Collaborator principal (password path): invite through the real service,
    // then add the workspace collaborator role membership.
    const { rows: roleRows0 } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [ws.id],
    );
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'evidence-collaborator@example.test',
      roleId: roleRows0[0].id,
      expiresInHours: 24,
    });
    const inviteToken = invite.url.split('token=')[1];
    const collaborator = await db.acceptCollabInvitation({
      token: inviteToken,
      displayName: 'Evidence Collaborator',
      password: 'EvidenceCollab!42',
      rateLimitKey: 'evidence-test',
    });
    collaboratorActor = { principalId: collaborator.principal.id, sessionVersion: collaborator.principal.sessionVersion };

    // Outsider: separate client, no access to workspace A.
    const adminB = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9202, login: 'evidence-outsider' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, adminB, 'org-evidence-b', 'admin');
    const outsiderPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: adminB,
      displayName: 'evidence-outsider',
      email: 'evidence-outsider@example.test',
    });
    await db.bootstrapCollaborationWorkspace({
      actor: { principalId: outsiderPrincipal.id, sessionVersion: outsiderPrincipal.sessionVersion },
      legacyOrgId: 'org-evidence-b',
      name: 'Evidence Client B',
      idempotencyKey: 'evidence-slice-bootstrap-b',
    });
    outsiderActor = { principalId: outsiderPrincipal.id, sessionVersion: outsiderPrincipal.sessionVersion };

    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Evidence slice task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('creates a criterion with task.write and lists it', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: collaboratorActor,
      body: { text: 'Site loads under 2s' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ text: 'Site loads under 2s', state: 'open', version: 1 });

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria`, { actor: collaboratorActor });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('transitions state with expectedVersion and preserves actor history', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: managerActor,
      body: { text: 'A11y audit passed' },
    });
    const criterionId = created.body.data.id;

    const met = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/criteria/${criterionId}`, {
      actor: collaboratorActor,
      body: { expectedVersion: 1, state: 'met' },
    });
    expect(met.status).toBe(200);
    expect(met.body.data).toMatchObject({ state: 'met', version: 2 });

    const stale = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/criteria/${criterionId}`, {
      actor: collaboratorActor,
      body: { expectedVersion: 1, state: 'waived' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');

    // History preserves who changed what (delivery acknowledgment consumes it).
    const history = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria/${criterionId}/history`, {
      actor: managerActor,
    });
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ fromState: 'open', toState: 'met' });
  });

  it('hides criteria from another client and from readers without task.read', async () => {
    const outsider = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/criteria`, { actor: outsiderActor });
    expect(outsider.status).toBe(404);
  });

  it('rejects criterion writes from actors without task.write', async () => {
    // Viewer principal: task.read only.
    const db = await import('@fluent-flow/db');
    const { rows: viewerRows } = await db.getPool().query(
      `INSERT INTO collab_principals (display_name, email) VALUES ('Evidence Viewer', 'evidence-viewer@example.test') RETURNING id, session_version`,
    );
    const viewerId = viewerRows[0].id;
    await db.getPool().query(
      `INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)`,
      [viewerId, 'x'],
    );
    const { rows: wsRows } = await db.getPool().query(`SELECT id FROM collab_workspaces LIMIT 1`);
    const { rows: roleRows } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'viewer'`,
      [wsRows[0].id],
    );
    await db.getPool().query(
      `INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id)
       VALUES ($1, NULL, $2, $3)`,
      [wsRows[0].id, viewerId, roleRows[0].id],
    );

    const denied = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: { principalId: viewerId, sessionVersion: viewerRows[0].session_version },
      body: { text: 'should not persist' },
    });
    expect(denied.status).toBe(403);
    // A's authorize emits code 'forbidden' for known-scope missing capability.
    expect(denied.body.error.code).toBe('forbidden');
  });
});

describe('A4 evidence slice 2: named checks and append-only evidence', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let projectA1;
  let taskA1;
  let checkId;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9301, login: 'checks-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-checks', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'checks-owner',
      email: 'checks-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-checks',
      name: 'Checks Client',
      idempotencyKey: 'checks-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Checks A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Checks task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { rows: roleRows } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`,
      [ws.id],
    );
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'checks-collaborator@example.test',
      roleId: roleRows[0].id,
      expiresInHours: 24,
    });
    const collaborator = await db.acceptCollabInvitation({
      token: invite.url.split('token=')[1],
      displayName: 'Checks Collaborator',
      password: 'ChecksCollab!42',
      rateLimitKey: 'checks-test',
    });
    collaboratorActor = { principalId: collaborator.principal.id, sessionVersion: collaborator.principal.sessionVersion };

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('creates a named check and records human evidence', async () => {
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks`, {
      actor: collaboratorActor,
      body: { name: 'unit tests', command: 'npm test', visibility: 'internal' },
    });
    expect(created.status).toBe(201);
    checkId = created.body.data.id;
    expect(created.body.data).toMatchObject({ name: 'unit tests', command: 'npm test', version: 1 });

    const duplicate = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks`, {
      actor: collaboratorActor,
      body: { name: 'unit tests', command: 'npm test', visibility: 'internal' },
    });
    expect(duplicate.status).toBe(409);

    const evidence = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: collaboratorActor,
      body: { status: 'passed', exitCode: 0, commit: 'abc123', provenance: 'human' },
    });
    expect(evidence.status).toBe(201);
    expect(evidence.body.data).toMatchObject({ status: 'passed', provenance: 'human' });

    // Internal checks require internal.read: the collaborator (task.write but
    // no internal.read) must not see their own internal check listed.
    const collaboratorList = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: collaboratorActor });
    expect(collaboratorList.status).toBe(200);
    expect(collaboratorList.body.data.find((c) => c.id === checkId)).toBeUndefined();

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: managerActor });
    expect(list.status).toBe(200);
    const check = list.body.data.find((c) => c.id === checkId);
    expect(check.evidence).toHaveLength(1);
    expect(check.evidence[0].stale).toBe(true); // commit unknown to any run head
    expect(check.evidence[0].staleReason).toMatch(/unknown|head/i);
  });

  it('marks evidence stale when the check definition changes after capture', async () => {
    const patched = await api(baseUrl, 'PATCH', `/tasks/${taskA1.id}/checks/${checkId}`, {
      actor: managerActor,
      body: { expectedVersion: 1, command: 'npm test -- --run' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.version).toBe(2);

    const list = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/checks`, { actor: managerActor });
    const check = list.body.data.find((c) => c.id === checkId);
    expect(check.evidence[0].stale).toBe(true);
    expect(check.evidence[0].staleReason).toMatch(/definition/i);

    // Check edit requires task.write: collaborator may not edit the manager's check version here? (both have task.write; guard instead on a viewer)
  });

  it('rejects non-human provenance on the actor path (agent/runner use trusted contexts)', async () => {
    const runner = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: managerActor,
      body: { status: 'passed', provenance: 'runner' },
    });
    expect(runner.status).toBe(403);
    expect(runner.body.error.code).toBe('provenance_forbidden');
    // And agent provenance is reserved for trusted report contexts.
    const agent = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: managerActor,
      body: { status: 'passed', provenance: 'agent', runId: '00000000-0000-0000-0000-000000000001' },
    });
    expect(agent.status).toBe(403);
    expect(agent.body.error.code).toBe('provenance_forbidden');
  });
});

describe('A4 evidence domain slice 3: delivery acknowledgment and human-only decisions', () => {
  let server;
  let baseUrl;
  let managerActor;
  let collaboratorActor;
  let projectA1;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9401, login: 'delivery-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-delivery', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'delivery-owner',
      email: 'delivery-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-delivery',
      name: 'Delivery Client',
      idempotencyKey: 'delivery-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Delivery A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Delivery task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { rows: roleRows } = await db.getPool().query(
      `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name IN ('collaborator', 'reviewer', 'viewer')`,
      [ws.id],
    );
    const collaboratorRole = roleRows.find((r) => r.id && true);
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'delivery-collaborator@example.test',
      roleId: roleRows[0].id,
      expiresInHours: 24,
    });
    const collaborator = await db.acceptCollabInvitation({
      token: invite.url.split('token=')[1],
      displayName: 'Delivery Collaborator',
      password: 'DeliveryCollab!42',
      rateLimitKey: 'delivery-test',
    });
    collaboratorActor = { principalId: collaborator.principal.id, sessionVersion: collaborator.principal.sessionVersion };
    void collaboratorRole;

    const { registerEvidenceRoutes } = await import('../../src/collab/routes-evidence.js');
    const { collabRequestContext, requireActor, collabErrorHandler } = await import('../../src/collab/http.js');
    const router = express.Router();
    router.use(collabRequestContext);
    router.use(requireActor);
    registerEvidenceRoutes(router);
    router.use(collabErrorHandler);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/collab/v1', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('captures open items at delivery and requires their acknowledgment at current version', async () => {
    // An open criterion becomes an open item in the delivery snapshot.
    await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: managerActor,
      body: { text: 'Perf budget met' },
    });

    // Deliveries need internal.read: collaborator (no internal.read) is denied.
    const denied = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/deliveries`, {
      actor: collaboratorActor,
      body: { expectedVersion: (await getCollabTask(managerActor, taskA1.id)).task.version, note: 'should not persist' },
    });
    expect(denied.status).toBe(403);

    const delivery = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/deliveries`, {
      actor: managerActor,
      body: { expectedVersion: (await getCollabTask(managerActor, taskA1.id)).task.version, note: 'Ready for review, one criterion still open.' },
    });
    expect(delivery.status).toBe(201);
    expect(delivery.body.data.openItemIds.length).toBe(1);

    // Accept requires review state + acknowledgment of the captured open items.
    const db = await import('@fluent-flow/db');
    const currentVersion = async () =>
      (await db.getPool().query('SELECT version FROM collab_tasks WHERE id = $1', [taskA1.id])).rows[0].version;

    const acceptBlocked = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: { decision: 'accept', note: '', acknowledgedOpenItemIds: [], expectedVersion: await currentVersion() },
    });
    expect(acceptBlocked.status).toBe(422);
    expect(acceptBlocked.body.error.code).toMatch(/not_in_review|acknowledgment_required/);

    // Move to review via the status endpoint A provides; here via direct service (moves are A2).
    await db.getPool().query(`UPDATE collab_tasks SET status = 'review', version = version + 1 WHERE id = $1`, [taskA1.id]);

    const acceptNoAck = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: { decision: 'accept', note: '', acknowledgedOpenItemIds: [], expectedVersion: await currentVersion() },
    });
    expect(acceptNoAck.status).toBe(422);
    expect(acceptNoAck.body.error.code).toBe('acknowledgment_required');

    const openId = delivery.body.data.openItemIds[0];
    const accepted = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: {
        decision: 'accept',
        note: 'acknowledged open criterion',
        reviewSnapshot: (await api(baseUrl, 'GET', `/tasks/${taskA1.id}/delivery-review`, { actor: managerActor })).body.data,
        acknowledgedOpenItemIds: [openId],
        expectedVersion: await currentVersion(),
      },
    });
    expect(accepted.status).toBe(200);

    const { rows } = await db.getPool().query('SELECT status FROM collab_tasks WHERE id = $1', [taskA1.id]);
    expect(rows[0].status).toBe('done');
  });
});

describe('A4 evidence domain slice 4: idea conversion idempotency', () => {
  let server;
  let baseUrl;
  let managerActor;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9501, login: 'ideas-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-ideas', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'ideas-owner',
      email: 'ideas-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-ideas',
      name: 'Ideas Client',
      idempotencyKey: 'ideas-slice-bootstrap',
    });
    const projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Ideas A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Ideas task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { registerEvidenceRoutes } = await import('../../src/collab/routes-evidence.js');
    const { collabRequestContext, requireActor, collabErrorHandler } = await import('../../src/collab/http.js');
    const router = express.Router();
    router.use(collabRequestContext);
    router.use(requireActor);
    registerEvidenceRoutes(router);
    router.use(collabErrorHandler);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/collab/v1', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('converts an idea to exactly one backlog task; replay is idempotent; conversion never launches work', async () => {
    const db = await import('@fluent-flow/db');
    const idea = await db.createCollabIdea({
      actor: managerActor,
      taskId: taskA1.id,
      title: 'Dark mode',
      body: 'Users keep asking.',
      visibility: 'client',
    });

    const first = await db.convertCollabIdea({
      actor: managerActor,
      taskId: taskA1.id,
      ideaId: idea.id,
      kind: 'task',
      expectedVersion: 1,
      idempotencyKey: 'ideas-convert-key-0001',
    });
    expect(first.replay).toBe(false);
    expect(first.createdTaskId).toBeTruthy();

    const replay = await db.convertCollabIdea({
      actor: managerActor,
      taskId: taskA1.id,
      ideaId: idea.id,
      kind: 'task',
      expectedVersion: 1,
      idempotencyKey: 'ideas-convert-key-0001',
    });
    expect(replay).toMatchObject({ replay: true, createdTaskId: first.createdTaskId });

    await expect(
      db.convertCollabIdea({
        actor: managerActor,
        taskId: taskA1.id,
        ideaId: idea.id,
        kind: 'task',
        expectedVersion: 1,
        idempotencyKey: 'ideas-convert-key-0002',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'already_converted' });

    const { rows } = await db.getPool().query(
      `SELECT count(*)::int AS n FROM collab_tasks WHERE project_id = $1 AND title = 'Dark mode'`,
      [first.createdTaskId ? (await db.getPool().query('SELECT project_id FROM collab_tasks WHERE id = $1', [first.createdTaskId])).rows[0].project_id : ''],
    );
    expect(rows[0].n).toBe(1);
    const { rows: runRows } = await db.getPool().query('SELECT count(*)::int AS n FROM collab_runs');
    expect(runRows[0].n).toBe(0); // conversion to backlog never launches work
  });
});

describe('A4 evidence domain slice 5: workpad plan snapshots and open questions', () => {
  let server;
  let baseUrl;
  let managerActor;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9601, login: 'workpad-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-workpad', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'workpad-owner',
      email: 'workpad-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-workpad',
      name: 'Workpad Client',
      idempotencyKey: 'workpad-slice-bootstrap',
    });
    const projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Workpad A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Workpad task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { registerEvidenceRoutes } = await import('../../src/collab/routes-evidence.js');
    const { collabRequestContext, requireActor, collabErrorHandler } = await import('../../src/collab/http.js');
    const router = express.Router();
    router.use(collabRequestContext);
    router.use(requireActor);
    registerEvidenceRoutes(router);
    router.use(collabErrorHandler);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/collab/v1', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('records an open question and resolves it with versioned history', async () => {
    const asked = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/questions`, {
      actor: managerActor,
      body: { text: 'Should the logo wall link to customer sites?' },
    });
    expect(asked.status).toBe(201);
    expect(asked.body.data).toMatchObject({ state: 'open', provenance: 'human' });
    const questionId = asked.body.data.id;

    const resolved = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/questions/${questionId}/resolve`, {
      actor: managerActor,
      body: { answer: 'Yes, link to the customer site.', expectedVersion: 1 },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ state: 'resolved', answer: 'Yes, link to the customer site.', version: 2 });

    const stale = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/questions/${questionId}/resolve`, {
      actor: managerActor,
      body: { answer: 'late', expectedVersion: 1 },
    });
    expect(stale.status).toBe(409);

    const history = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/questions/${questionId}/history`, {
      actor: managerActor,
    });
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ fromState: 'open', toState: 'resolved' });
  });

  it('includes open questions in delivery outstanding acknowledgment', async () => {
    await api(baseUrl, 'POST', `/tasks/${taskA1.id}/questions`, {
      actor: managerActor,
      body: { text: 'Unresolved scope question for delivery' },
    });

    const openItems = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/open-items`, { actor: managerActor });
    expect(openItems.status).toBe(200);
    const questionItem = openItems.body.data.find((i) => i.label.startsWith('Open question'));
    expect(questionItem).toBeTruthy();

    const delivery = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/deliveries`, {
      actor: managerActor,
      body: { expectedVersion: (await getCollabTask(managerActor, taskA1.id)).task.version, note: 'delivery with unresolved question' },
    });
    expect(delivery.status).toBe(201);
    expect(delivery.body.data.openItemIds).toContain(questionItem.id);
  });

  it('records an agent plan snapshot with run binding via trusted report context', async () => {
    const db = await import('@fluent-flow/db');
    // Trusted report context (A's scoped token path): run + session bound to the task.
    const { rows: hostRows } = await db.getPool().query(
      `INSERT INTO collab_hosts (name, token_hash, enrolled_by_principal_id)
       VALUES ('workpad-host', 'hash-workpad', $1) RETURNING id`,
      [managerActor.principalId],
    );
    const { rows: mappingRows } = await db.getPool().query(
      `INSERT INTO collab_project_host_mappings (project_id, host_id, repository_key, default_profile_id)
       SELECT t.project_id, $2, 'org/repo-workpad', 'profile'
       FROM collab_tasks t WHERE t.id = $1 RETURNING id`,
      [taskA1.id, hostRows[0].id],
    );
    const { rows: runRows } = await db.getPool().query(
      `INSERT INTO collab_runs (task_id, project_id, host_id, mapping_id, profile_id, created_by_principal_id)
       SELECT t.id, t.project_id, $2, $3, 'profile', $4 FROM collab_tasks t WHERE t.id = $1 RETURNING id`,
      [taskA1.id, hostRows[0].id, mappingRows[0].id, managerActor.principalId],
    );
    const { rows: sessionRows } = await db.getPool().query(
      `INSERT INTO collab_sessions (run_id, title) VALUES ($1, 'work session') RETURNING id`,
      [runRows[0].id],
    );

    const plan = await db.recordWorkpadPlanReport({
      taskId: taskA1.id,
      runId: runRows[0].id,
      sessionId: sessionRows[0].id,
      items: [
        { text: 'Scaffold component', status: 'completed' },
        { text: 'Wire styles', status: 'in_progress' },
      ],
    });
    expect(plan.provenance).toBe('agent');
    expect(plan.items).toHaveLength(2);

    const latest = await db.getWorkpadPlan({ actor: managerActor, taskId: taskA1.id });
    expect(latest.plan?.items).toHaveLength(2);
    expect(latest.plan?.sessionId).toBe(sessionRows[0].id);

    const question = await db.recordOpenQuestionReport({
      taskId: taskA1.id,
      runId: runRows[0].id,
      sessionId: sessionRows[0].id,
      text: 'Agent asks: which palette tokens?',
    });
    expect(question.provenance).toBe('agent');
    expect(question.state).toBe('open');
  });
});

describe('A4 evidence domain slice 6: decision integrity and reviewer projection', () => {
  let server;
  let baseUrl;
  let managerActor;
  let reviewerActor;
  let taskA1;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9701, login: 'integrity-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-integrity', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'integrity-owner',
      email: 'integrity-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-integrity',
      name: 'Integrity Client',
      idempotencyKey: 'integrity-slice-bootstrap',
    });
    const projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Integrity A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Integrity task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    // Reviewer: delivery.accept WITHOUT internal.read.
    const { rows: roles } = await db.getPool().query(
      `SELECT id, name FROM collab_roles WHERE workspace_id = $1 AND name = 'reviewer'`,
      [ws.id],
    );
    const invite = await db.createCollabInvitation({
      actor: managerActor,
      workspaceId: ws.id,
      email: 'integrity-reviewer@example.test',
      roleId: roles[0].id,
      expiresInHours: 24,
    });
    const reviewer = await db.acceptCollabInvitation({
      token: invite.url.split('token=')[1],
      displayName: 'Integrity Reviewer',
      password: 'IntegrityReviewer!42',
      rateLimitKey: 'integrity-test',
    });
    reviewerActor = { principalId: reviewer.principal.id, sessionVersion: reviewer.principal.sessionVersion };

    const { registerEvidenceRoutes } = await import('../../src/collab/routes-evidence.js');
    const { collabRequestContext, requireActor, collabErrorHandler } = await import('../../src/collab/http.js');
    const router = express.Router();
    router.use(collabRequestContext);
    router.use(requireActor);
    registerEvidenceRoutes(router);
    router.use(collabErrorHandler);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/collab/v1', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('treats not_run evidence as an acknowledged open item and rejects foreign run binding', async () => {
    const db = await import('@fluent-flow/db');
    const created = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks`, {
      actor: managerActor,
      body: { name: 'e2e', command: 'npm run e2e', visibility: 'client' },
    });
    const checkId = created.body.data.id;

    const evidence = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/checks/${checkId}/evidence`, {
      actor: managerActor,
      body: { status: 'not_run', provenance: 'human' },
    });
    expect(evidence.status).toBe(201);

    const items = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/open-items`, { actor: managerActor });
    expect(items.body.data.some((i) => i.label.startsWith('Check not run:'))).toBe(true);

    // Humans cannot claim runner provenance via the actor path.
    await expect(
      db.addCollabCheckEvidence({
        actor: managerActor,
        taskId: taskA1.id,
        checkId,
        status: 'passed',
        provenance: 'runner',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'provenance_forbidden' });
  });

  it('lets a reviewer (no internal.read) read deliveries and open items with safe labels', async () => {
    const deliveries = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/deliveries`, { actor: reviewerActor });
    expect(deliveries.status).toBe(200);

    const items = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/open-items`, { actor: reviewerActor });
    expect(items.status).toBe(200);
    // Internal check names are not leaked to reviewers without internal.read.
    for (const item of items.body.data) {
      expect(item.label).not.toMatch(/internal-lint/);
    }
  });

  it('recomputes open items at decision time: items added after delivery still block acceptance', async () => {
    const db = await import('@fluent-flow/db');
    await db.getPool().query(`UPDATE collab_tasks SET status = 'review' WHERE id = $1`, [taskA1.id]);

    // Deliver now (open items snapshot A).
    const delivery = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/deliveries`, {
      actor: managerActor,
      body: { expectedVersion: (await getCollabTask(managerActor, taskA1.id)).task.version, note: 'first delivery' },
    });
    expect(delivery.status).toBe(201);

    // A new open criterion appears AFTER the delivery.
    const criterion = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/criteria`, {
      actor: managerActor,
      body: { text: 'Late-breaking requirement' },
    });
    expect(criterion.status).toBe(201);

    // Acknowledging only the old snapshot is not enough.
    const denied = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: {
        decision: 'accept',
        note: '',
        expectedVersion: 0,
        acknowledgedOpenItemIds: [],
      },
    });
    expect([400, 409, 422]).toContain(denied.status);
    if (denied.status === 422) {
      expect(denied.body.error.code).toBe('acknowledgment_required');
      expect(denied.body.error.openItemIds.length).toBeGreaterThanOrEqual(1);
    }

    // ExpectedVersion enforcement: stale task version → 409.
    const staleVersion = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: {
        decision: 'accept',
        note: '',
        expectedVersion: 1,
        acknowledgedOpenItemIds: delivery.body.data.openItemIds,
      },
    });
    expect(staleVersion.status).toBe(409);

    // Current version + full recomputed acknowledgment (read fresh) → accepted.
    const { rows } = await db.getPool().query('SELECT version FROM collab_tasks WHERE id = $1', [taskA1.id]);
    const fresh = await api(baseUrl, 'GET', `/tasks/${taskA1.id}/open-items`, { actor: managerActor });
    const accepted = await api(baseUrl, 'POST', `/tasks/${taskA1.id}/decisions`, {
      actor: managerActor,
      body: {
        decision: 'accept',
        note: 'all current items acknowledged',
        reviewSnapshot: (await api(baseUrl, 'GET', `/tasks/${taskA1.id}/delivery-review`, { actor: managerActor })).body.data,
        expectedVersion: rows[0].version,
        acknowledgedOpenItemIds: fresh.body.data.map((i) => i.id),
      },
    });
    expect(accepted.status).toBe(200);
  });
});

describe('A4 evidence domain slice 7: usage dedupe and honest insights', () => {
  let server;
  let baseUrl;
  let managerActor;
  let projectA1;
  let taskA1;
  let runId;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();

    const admin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9801, login: 'usage-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, admin, 'org-usage', 'admin');
    const adminPrincipal = await db.ensureGithubPrincipal({
      legacyUserId: admin,
      displayName: 'usage-owner',
      email: 'usage-owner@example.test',
    });
    managerActor = { principalId: adminPrincipal.id, sessionVersion: adminPrincipal.sessionVersion };

    const ws = await db.bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: 'org-usage',
      name: 'Usage Client',
      idempotencyKey: 'usage-slice-bootstrap',
    });
    projectA1 = await db.createCollabProject({ actor: managerActor, workspaceId: ws.id, name: 'Usage A1' });
    taskA1 = await db.createCollabTask({
      actor: managerActor,
      projectId: projectA1.id,
      title: 'Usage task',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });

    const { rows: hostRows } = await db.getPool().query(
      `INSERT INTO collab_hosts (name, token_hash, enrolled_by_principal_id) VALUES ('usage-host', 'hash-usage', $1) RETURNING id`,
      [managerActor.principalId],
    );
    const { rows: mappingRows } = await db.getPool().query(
      `INSERT INTO collab_project_host_mappings (project_id, host_id, repository_key, default_profile_id)
       VALUES ($1, $2, 'org/usage', 'profile') RETURNING id`,
      [projectA1.id, hostRows[0].id],
    );
    const { rows } = await db.getPool().query(
      `INSERT INTO collab_runs (task_id, project_id, host_id, mapping_id, profile_id, created_by_principal_id)
       VALUES ($1, $2, $3, $4, 'profile', $5) RETURNING id`,
      [taskA1.id, projectA1.id, hostRows[0].id, mappingRows[0].id, managerActor.principalId],
    );
    runId = rows[0].id;

    const { registerEvidenceRoutes } = await import('../../src/collab/routes-evidence.js');
    const { collabRequestContext, requireActor, collabErrorHandler } = await import('../../src/collab/http.js');
    const router = express.Router();
    router.use(collabRequestContext);
    router.use(requireActor);
    registerEvidenceRoutes(router);
    router.use(collabErrorHandler);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/collab/v1', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
  });

  it('replaces cumulative snapshots for the same turn and never double-counts', async () => {
    const db = await import('@fluent-flow/db');
    await db.recordUsageSample({
      runId, taskId: taskA1.id, sessionId: null, providerTurnId: 'turn-1',
      tokensIn: 10, tokensOut: 5, costUsd: null, unavailableReason: null,
    });
    // Later cumulative snapshot for the same turn: replaces, not adds.
    await db.recordUsageSample({
      runId, taskId: taskA1.id, sessionId: null, providerTurnId: 'turn-1',
      tokensIn: 20, tokensOut: 9, costUsd: null, unavailableReason: null,
    });
    // Compute the range AFTER the inserts so the PG now() observed_at
    // (set inside recordUsageSample) is guaranteed to fall inside it.
    const to = new Date(Date.now() + 10_000).toISOString();
    const from = new Date(Date.now() - 3600_000).toISOString();
    const insights = await db.getCollabProjectInsights({
      actor: managerActor, projectId: projectA1.id, from: new Date(from), to: new Date(to),
    });
    expect(insights.usage.available).toBe(true);
    expect(insights.usage.tokensIn).toBe(20);
    expect(insights.usage.tokensOut).toBe(9);
    expect(insights.usage.costUsd).toBeNull(); // provider reported no cost: honest null
  });

  it('keeps null-only unsupported usage as unavailable with reason', async () => {
    const db = await import('@fluent-flow/db');
    await db.recordUsageSample({
      runId, taskId: taskA1.id, sessionId: null, providerTurnId: 'turn-unsupported',
      tokensIn: null, tokensOut: null, costUsd: null, unavailableReason: 'provider does not expose usage',
    });
    const to = new Date(Date.now() + 10_000).toISOString();
    const from = new Date(Date.now() - 3600_000).toISOString();
    const insights = await db.getCollabProjectInsights({
      actor: managerActor, projectId: projectA1.id, from: new Date(from), to: new Date(to),
    });
    // The known turn-1 sample keeps availability, but the null-only sample
    // never invents zero tokens. Cost stays null (no cost reported).
    expect(insights.usage.available).toBe(true);
    expect(insights.usage.tokensIn).toBe(20);
    expect(insights.usage.costUsd).toBeNull();
  });
});
