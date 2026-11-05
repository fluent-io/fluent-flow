import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } = await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();

const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const { signCollaborationActor } = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

const CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];
const ffRequestId = (sessionId, generation, nativeRequestId) => createHash('sha256').update(`${sessionId}|claude-code|${generation}|${nativeRequestId}`).digest('hex').slice(0, 32);
const fp = (n) => createHash('sha256').update(`route-${n}`).digest('hex');

describe('pending requests over real HTTP', () => {
  let server;
  let baseUrl;
  let manager;
  let reader;
  let hostToken;
  let connector;
  let runId;
  let sessionId;

  async function collab(method, path, { actor = manager, body, key } = {}) {
    const res = await fetch(`${baseUrl}/api/collab/v1${path}`, {
      method,
      headers: {
        'x-fluent-flow-actor': signCollaborationActor({ principalId: actor.id, sessionVersion: actor.sessionVersion }, TEST_AUTH_SECRET),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function observe(events) {
    const res = await fetch(`${baseUrl}/api/connector/v1/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch, events: events.map((e) => ({ runId, sessionId, ...e })) }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.rejectedEventIds).toEqual([]);
  }

  const pending = (n, nativeRequestId, observedAt) => ({
    eventId: `claude-code:${sessionId}:1:request:${nativeRequestId}`, kind: 'attention', observedAt,
    payload: {
      nativeRequestId, kind: 'permission', fingerprint: fp(n), secret: false, questions: null, state: 'pending', attention: 'permission', requestId: nativeRequestId,
      choices: [{ id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' }, { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
      tool: { name: 'Bash', displayName: 'Bash', description: `Run step ${n}`, input: { command: `step ${n}` } },
      source: { backend: 'claude-code', generation: 1, nativeEventId: `request:${nativeRequestId}`, seq: n },
    },
  });

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const db = await import('@fluent-flow/db');
    await db.runMigrations();
    const legacy = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9811, login: 'pending-route-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, legacy, 'pending-route-org', 'admin');
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Route Owner', email: 'pending-route@example.test' });
    manager = { id: principal.id, sessionVersion: principal.sessionVersion };
    const actor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
    const ws = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: 'pending-route-org', name: 'Route Client', idempotencyKey: 'pending-route-ws' });
    const projectId = (await db.createCollabProject({ actor, workspaceId: ws.id, name: 'Route P1' })).id;
    const host = await db.createExecutionHost({ actor, name: 'Route PC' });
    hostToken = host.token;
    const mapping = await db.createProjectHostMapping({ actor, projectId, hostId: host.id, repositoryKey: 'route/repo', profileIds: ['cc-route'], defaultProfileId: 'cc-route' });
    connector = await db.registerConnector({
      token: hostToken, instanceId: 'pending-route-inst', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: {
        formatVersion: 2, capacity: { 'claude-code': 1, codex: 1 }, repositories: [{ key: 'route/repo' }],
        profiles: [{ id: 'cc-route', name: 'cc-route', backend: 'claude-code', model: 'claude-model-x', revision: 'rev-1', capabilities: CAPS, readiness: { state: 'ready' }, harness: { name: 'claude-code', version: '2.1.317' }, policy: { permissionMode: 'manual' }, authExpectation: 'claude-subscription', limits: { maxActiveSessions: 1 } }],
      },
    });
    const task = await db.createCollabTask({ actor, projectId, title: 'Pending route task' });
    const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: 1, idempotencyKey: 'pending-route-run', mappingId: mapping.id, profileId: 'cc-route' });
    runId = started.run.id;
    sessionId = (await db.getPool().query('SELECT id FROM collab_sessions WHERE run_id=$1', [runId])).rows[0].id;
    const { rows } = await db.getPool().query("INSERT INTO collab_principals(display_name) VALUES('Route Reader') RETURNING id,session_version");
    reader = { id: rows[0].id, sessionVersion: rows[0].session_version };
    await db.getPool().query(`INSERT INTO collab_memberships(workspace_id,project_id,principal_id,role_id)
      SELECT p.workspace_id,p.id,$2,role.id FROM collab_projects p JOIN collab_roles role ON role.workspace_id=p.workspace_id
      WHERE p.id=$1 AND role.name='collaborator'`, [projectId, reader.id]);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const t0 = Date.UTC(2026, 10, 5, 9, 0, 0);
    await observe([{ eventId: 'route-bound', kind: 'session_bound', observedAt: new Date(t0).toISOString(), payload: { backend: 'claude-code', nativeSessionId: 'native-route', generation: 1 } }]);
    await observe(Array.from({ length: 52 }, (_, n) => pending(n, `ctl-${n}`, new Date(t0 + 1000 * (n + 1)).toISOString())));
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('the plural route lists every outstanding request', async () => {
    const first = await collab('GET', `/sessions/${sessionId}/pending-requests`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(50);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await collab('GET', `/sessions/${sessionId}/pending-requests?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.data, ...second.body.data];
    expect(all.map((r) => r.requestId)).toEqual(Array.from({ length: 52 }, (_, n) => ffRequestId(sessionId, 1, `ctl-${n}`)));
    expect(all[0]).toEqual({
      requestId: ffRequestId(sessionId, 1, 'ctl-0'), kind: 'permission', backend: 'claude-code', generation: 1, fingerprint: fp(0), promptText: 'Run step 0',
      choices: [{ id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' }, { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
      questions: null, hostOnly: false, inputSchema: { command: 'step 0' }, expiresAt: null, observedAt: '2026-11-05T09:00:01.000Z',
    });
    expect((await collab('GET', `/sessions/${sessionId}/pending-requests?limit=3`)).body.data.map((r) => r.requestId)).toEqual(all.slice(0, 3).map((r) => r.requestId));
    expect((await collab('GET', `/sessions/${sessionId}/pending-requests?limit=500`)).body.data).toHaveLength(50);
    const bad = await collab('GET', `/sessions/${sessionId}/pending-requests?cursor=bogus`);
    expect(bad).toEqual({ status: 400, body: { error: { code: 'invalid_cursor', message: 'The update cursor is invalid. Refresh and try again.', requestId: expect.any(String) } } });
    expect((await collab('GET', `/sessions/${sessionId}/pending-requests`, { actor: reader })).status).toBe(403);
    expect((await collab('GET', '/sessions/00000000-0000-4000-8000-000000000000/pending-requests')).status).toBe(404);
    const target = all[1];
    const stale = await collab('POST', `/sessions/${sessionId}/commands`, { key: 'route-answer-stale', body: { kind: 'permission', requestId: target.requestId, fingerprint: fp(999), generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } } });
    expect(stale).toEqual({ status: 409, body: { error: { code: 'request_unavailable', message: 'This request is no longer available. Refresh the session.', requestId: expect.any(String) } } });
    const ok = await collab('POST', `/sessions/${sessionId}/commands`, { key: 'route-answer-ok', body: { kind: 'permission', requestId: target.requestId, fingerprint: target.fingerprint, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } } });
    expect(ok.status).toBe(202);
    await observe([{ eventId: 'route-resolved', kind: 'attention', observedAt: new Date().toISOString(), payload: { nativeRequestId: 'ctl-1', state: 'resolved', attention: 'permission_resolved', requestId: 'ctl-1', source: { backend: 'claude-code', generation: 1, nativeEventId: 'request:ctl-1:resolved', seq: 99 } } }]);
    const after = await collab('GET', `/sessions/${sessionId}/pending-requests`);
    expect(after.body.data.map((r) => r.requestId)).not.toContain(target.requestId);
  });

  it('the singular route returns the same legacy DTO for the most recent request', async () => {
    const singular = await collab('GET', `/sessions/${sessionId}/pending-request`);
    expect(singular).toEqual({
      status: 200,
      body: { data: { requestId: ffRequestId(sessionId, 1, 'ctl-51'), kind: 'permission', promptText: 'Run step 51', choices: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny and continue' }], inputSchema: { command: 'step 51' }, expiresAt: null } },
    });
  });
});
