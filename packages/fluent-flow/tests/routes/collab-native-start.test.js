import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

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

const CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];

function profile(id, overrides = {}) {
  return {
    id,
    name: id,
    backend: 'claude-code',
    model: 'claude-model-x',
    revision: 'rev-1',
    capabilities: CAPS,
    readiness: { state: 'ready' },
    harness: { name: 'claude-code', version: '2.1.317' },
    policy: { permissionMode: 'manual' },
    authExpectation: 'claude-subscription',
    limits: { maxActiveSessions: 1 },
    ...overrides,
  };
}

const CASES = [
  ['nc-incomplete', 'profile_incomplete', 'Choose a complete execution profile before starting.'],
  ['nc-missing', 'profile_unavailable', 'This execution profile is unavailable. Contact the execution host owner.'],
  ['nc-ghost', 'execution_settings_changed', 'Execution settings changed. Ask a project administrator to select an available profile.'],
  ['nc-signin', 'sign_in_required', 'Sign in to the selected tool on the execution host, then try again.'],
];

describe('native Start over real HTTP', () => {
  let server;
  let baseUrl;
  let manager;
  let projectId;
  let hostToken;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();
    const legacy = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9801, login: 'native-route-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, legacy, 'native-route-org', 'admin');
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Route Owner', email: 'route-owner@example.test' });
    manager = { id: principal.id, sessionVersion: principal.sessionVersion };
    const actor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
    const ws = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: 'native-route-org', name: 'Route Client', idempotencyKey: 'native-route-ws' });
    projectId = (await db.createCollabProject({ actor, workspaceId: ws.id, name: 'Route P1' })).id;
    const host = await db.createExecutionHost({ actor, name: 'Route PC' });
    hostToken = host.token;
    await db.createProjectHostMapping({
      actor,
      projectId,
      hostId: host.id,
      repositoryKey: 'route/repo',
      profileIds: CASES.map(([id]) => id),
      defaultProfileId: 'nc-incomplete',
    });
    await db.registerConnector({
      token: hostToken,
      instanceId: 'route-inst',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: {
        formatVersion: 2,
        capacity: { 'claude-code': 1, codex: 1 },
        repositories: [{ key: 'route/repo' }],
        profiles: [
          profile('nc-incomplete', { readiness: { state: 'incomplete' } }),
          profile('nc-missing', { readiness: { state: 'not_installed' } }),
          profile('nc-signin', { readiness: { state: 'sign_in_required' } }),
        ],
      },
    });
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    globalThis.__nativeRouteDb = db;
    globalThis.__nativeRouteActor = actor;
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('422 bodies are {error:{code,message}} with the exact copy and no internals', async () => {
    for (const [profileId, code, message] of CASES) {
      const task = await globalThis.__nativeRouteDb.createCollabTask({ actor: globalThis.__nativeRouteActor, projectId, title: `Route ${profileId}` });
      const res = await fetch(`${baseUrl}/api/collab/v1/tasks/${task.id}/runs`, {
        method: 'POST',
        headers: {
          'x-fluent-flow-actor': signCollaborationActor({ principalId: manager.id, sessionVersion: manager.sessionVersion }, TEST_AUTH_SECRET),
          'idempotency-key': `native-route-${profileId}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion: 1, profileId }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toEqual({ error: { code, message, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(JSON.stringify(body)).not.toMatch(/claude-code|rev-1|readiness|collab_|catalog|2\.1\.317/);
    }
  });
});
