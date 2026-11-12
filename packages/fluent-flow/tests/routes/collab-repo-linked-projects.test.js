import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';

vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedUser, seedOrgMembership } = await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');
const secret = 'repo-linked-project-test-0123456789abcdef0123456789';

describe('POST /workspaces/:id/projects with repoFullName', () => {
  let server, baseUrl, owner, ownerB, viewer, workspace;

  async function api(method, path, { actor = owner, body } = {}) {
    const response = await fetch(`${baseUrl}/api/collab/v1${path}`, {
      method,
      headers: {
        'x-fluent-flow-actor': db.signCollaborationActor(actor, secret),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = secret;
    await resetCollabSchema(process.env.DATABASE_URL);
    await db.runMigrations();
    const legacy = await seedUser(process.env.DATABASE_URL, { githubId: 88101, login: 'linked-owner' });
    await seedOrgMembership(process.env.DATABASE_URL, legacy, 'linked-org', 'admin');
    const legacyB = await seedUser(process.env.DATABASE_URL, { githubId: 88102, login: 'linked-owner-b' });
    await seedOrgMembership(process.env.DATABASE_URL, legacyB, 'linked-org-b', 'admin');
    await db.getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name) VALUES ('r1', 'linked-org', 'linked-org/app'), ('r2', 'linked-org-b', 'linked-org-b/private')`,
    );
    const principal = await db.ensureGithubPrincipal({ userId: legacy, displayName: 'Owner', email: null });
    owner = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const principalB = await db.ensureGithubPrincipal({ userId: legacyB, displayName: 'Owner B', email: null });
    ownerB = { principalId: principalB.id, sessionVersion: principalB.sessionVersion };

    await db.ensureDefaultWorkspace('linked-org');
    expect(await db.enrollOrgAdminInDefaultWorkspaces(owner.principalId)).toHaveLength(1);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const me = await api('GET', '/me');
    workspace = me.body.data.workspaces[0];

    const role = await api('POST', `/workspaces/${workspace.id}/roles`, { body: { name: 'Reader', capabilities: ['task.read'] } });
    const invitation = await api('POST', `/workspaces/${workspace.id}/invitations`, {
      body: { email: 'reader@linked.test', roleId: role.body.data.id, expiresInHours: 24 },
    });
    const accepted = await fetch(`${baseUrl}/api/collab/v1/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invitation.body.data.url.split('token=')[1], displayName: 'Reader', password: 'synthetic linked passphrase' }),
    }).then((r) => r.json());
    viewer = { principalId: accepted.data.principal.id, sessionVersion: accepted.data.principal.sessionVersion };
  }, 30000);

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.closePool();
  });

  it('exposes the default workspace with its orgId on /me', () => {
    expect(workspace).toMatchObject({ name: 'Org linked-org', orgId: 'linked-org' });
  });

  it('creates a linked project and returns linkedRepoFullName on create, /me and GET /projects/:id', async () => {
    const created = await api('POST', `/workspaces/${workspace.id}/projects`, { body: { name: 'app', repoFullName: 'linked-org/app' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'app', workspaceId: workspace.id, linkedRepoFullName: 'linked-org/app' });

    const me = await api('GET', '/me');
    const listed = me.body.data.workspaces.flatMap((w) => w.projects).find((p) => p.id === created.body.data.id);
    expect(listed.linkedRepoFullName).toBe('linked-org/app');

    const detail = await api('GET', `/projects/${created.body.data.id}`);
    expect(detail.body.data.linkedRepoFullName).toBe('linked-org/app');
  });

  it('creates a standalone project when repoFullName is absent', async () => {
    const created = await api('POST', `/workspaces/${workspace.id}/projects`, { body: { name: 'standalone' } });
    expect(created.status).toBe(201);
    expect(created.body.data.linkedRepoFullName).toBeNull();
  });

  it('rejects an unknown repo and a repo from another org with 422 invalid_repo, without naming the repo', async () => {
    for (const repoFullName of ['linked-org/missing', 'linked-org-b/private']) {
      const response = await api('POST', `/workspaces/${workspace.id}/projects`, { body: { name: 'x', repoFullName } });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('invalid_repo');
      expect(JSON.stringify(response.body)).not.toContain(repoFullName);
    }
  });

  it('rejects a malformed repoFullName with 400', async () => {
    const response = await api('POST', `/workspaces/${workspace.id}/projects`, { body: { name: 'x', repoFullName: 42 } });
    expect(response.status).toBe(400);
  });

  it('keeps capability semantics: 403 without project.admin, 404 for a foreign workspace', async () => {
    const forbidden = await api('POST', `/workspaces/${workspace.id}/projects`, { actor: viewer, body: { name: 'x', repoFullName: 'linked-org/app' } });
    expect(forbidden.status).toBe(403);
    const foreign = await api('POST', `/workspaces/${workspace.id}/projects`, { actor: ownerB, body: { name: 'x', repoFullName: 'linked-org-b/private' } });
    expect(foreign.status).toBe(404);
  });
});
