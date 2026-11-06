import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } =
  await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();

const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING = Symbol('pending');
const stateAfter = (promise, ms) => Promise.race([promise, sleep(ms).then(() => PENDING)]);

describe('connector poll waits for work, wakes on new work, and cancels cleanly', () => {
  let server;
  let baseUrl;
  let manager;
  let projectId;
  let hostId;
  let hostToken;
  let connector;
  let taskCounter = 0;

  async function connectorCall(path, body, { signal } = {}) {
    const res = await fetch(`${baseUrl}/api/connector/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const poll = (body, opts) => connectorCall('/poll', { ...connector, limit: 10, ...body }, opts);

  async function timed(promise) {
    const started = performance.now();
    const result = await promise;
    return { ...result, elapsedMs: performance.now() - started };
  }

  async function queueLaunch() {
    taskCounter += 1;
    const actor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
    const task = await db.createCollabTask({ actor, projectId, title: `Poll task ${taskCounter}` });
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks/${task.id}/runs`, {
      method: 'POST',
      headers: {
        'x-fluent-flow-actor': db.signCollaborationActor(actor, TEST_AUTH_SECRET),
        'idempotency-key': `poll-run-${taskCounter}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1, instructions: 'Do it', profileId: 'ai3-coder' }),
    });
    expect(res.status).toBe(202);
    return (await res.json()).data.run.id;
  }

  async function ackApplied(commandId) {
    const ack = await connectorCall(`/commands/${commandId}/ack`, { ...connector, state: 'applied', result: {} });
    expect(ack.status).toBe(200);
    return ack;
  }

  async function lastHeartbeatMs() {
    const { rows } = await db.getPool().query('SELECT last_heartbeat_at FROM collab_hosts WHERE id = $1', [hostId]);
    return rows[0].last_heartbeat_at.getTime();
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    await db.runMigrations();

    const legacyAdmin = await seedLegacyUser(process.env.DATABASE_URL, { githubId: 9701, login: 'poll-owner' });
    await seedLegacyOrgMembership(process.env.DATABASE_URL, legacyAdmin, 'poll-org', 'admin');
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacyAdmin, displayName: 'Poll Owner', email: 'poll-owner@example.test' });
    manager = { id: principal.id, sessionVersion: principal.sessionVersion };
    const actor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
    const ws = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: 'poll-org', name: 'Poll Client', idempotencyKey: 'poll-ws-01' });
    projectId = (await db.createCollabProject({ actor, workspaceId: ws.id, name: 'Poll P1' })).id;
    const host = await db.createExecutionHost({ actor, name: 'Poll PC' });
    hostId = host.id;
    hostToken = host.token;
    await db.createProjectHostMapping({
      actor, projectId, hostId: host.id, repositoryKey: 'poll/repo', profileIds: ['ai3-coder'], defaultProfileId: 'ai3-coder',
    });

    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const registered = await connectorCall('/register', {
      instanceId: 'poll-1', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {},
      catalog: { repositories: [{ key: 'poll/repo' }], profiles: [{ id: 'ai3-coder', provider: 'omp' }] },
    });
    expect(registered.status).toBe(200);
    connector = { connectorSessionId: registered.body.data.connectorSessionId, leaseEpoch: registered.body.data.leaseEpoch };
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await db.closePool();
  });

  it('waitMs 0 with no work answers immediately with an empty batch', async () => {
    const res = await timed(poll({ waitMs: 0 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { commands: [] } });
    expect(res.elapsedMs).toBeLessThan(400);
  });

  it('a positive wait with no work stays pending, then expires empty at the deadline', async () => {
    const pending = timed(poll({ waitMs: 1500 }));
    expect(await stateAfter(pending, 1000)).toBe(PENDING);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { commands: [] } });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1400);
    expect(res.elapsedMs).toBeLessThan(2500);
  });

  it('already-queued work returns at once even with the maximum wait', async () => {
    const runId = await queueLaunch();
    const res = await timed(poll({ waitMs: 25_000 }));
    expect(res.status).toBe(200);
    expect(res.body.data.commands).toHaveLength(1);
    expect(res.body.data.commands[0]).toMatchObject({ runId, kind: 'launch', leaseEpoch: connector.leaseEpoch });
    expect(res.elapsedMs).toBeLessThan(1000);
    await ackApplied(res.body.data.commands[0].id);
  });

  it('a newly queued command wakes a waiting poll promptly', async () => {
    const pending = poll({ waitMs: 10_000 });
    expect(await stateAfter(pending, 300)).toBe(PENDING);
    const queuedAt = performance.now();
    const runId = await queueLaunch();
    const res = await pending;
    const latencyMs = performance.now() - queuedAt;
    expect(res.status).toBe(200);
    expect(res.body.data.commands.map((c) => c.runId)).toEqual([runId]);
    expect(latencyMs).toBeLessThan(1500);
    await ackApplied(res.body.data.commands[0].id);
  });

  it('heartbeat, ack and another claim proceed while a poll is waiting', async () => {
    const waiting = poll({ waitMs: 4000 });
    expect(await stateAfter(waiting, 300)).toBe(PENDING);

    const beat = await timed(connectorCall('/heartbeat', { ...connector, activeRunIds: [] }));
    expect(beat.status).toBe(200);
    expect(beat.elapsedMs).toBeLessThan(500);

    await queueLaunch();
    const claim = await timed(poll({ waitMs: 0 }));
    expect(claim.status).toBe(200);
    expect(claim.elapsedMs).toBeLessThan(500);
    const ack = await timed(connectorCall(`/commands/${claim.body.data.commands[0]?.id ?? (await waiting).body.data.commands[0].id}/ack`, { ...connector, state: 'applied', result: {} }));
    expect(ack.status).toBe(200);
    expect(ack.elapsedMs).toBeLessThan(500);

    const settled = await waiting;
    expect(settled.status).toBe(200);
    const delivered = [...claim.body.data.commands, ...settled.body.data.commands];
    expect(delivered).toHaveLength(1);
  });

  it('a client disconnect stops further rechecks for that poll', async () => {
    const controller = new AbortController();
    const waiting = poll({ waitMs: 10_000 }, { signal: controller.signal }).catch((err) => err);
    await sleep(200);
    const early = await lastHeartbeatMs();
    await sleep(1200);
    expect(await lastHeartbeatMs()).toBeGreaterThan(early);

    controller.abort();
    expect((await waiting).name).toBe('AbortError');
    await sleep(300);
    const afterAbort = await lastHeartbeatMs();
    await sleep(1500);
    expect(await lastHeartbeatMs()).toBe(afterAbort);
  });

  it('a client that disconnects while authentication is still pending never starts the poll', async () => {
    const blocker = await db.getPool().connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await blocker.query('ROLLBACK');
      blocker.release();
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE collab_hosts IN ACCESS EXCLUSIVE MODE');
      const controller = new AbortController();
      const waiting = poll({ waitMs: 10_000 }, { signal: controller.signal }).catch((err) => err);
      for (let i = 0; ; i++) {
        const { rows } = await blocker.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE relation = 'collab_hosts'::regclass AND NOT granted`,
        );
        if (rows[0].n > 0) break;
        if (i > 200) throw new Error('poll authentication never reached the lock');
        await sleep(10);
      }
      controller.abort();
      expect((await waiting).name).toBe('AbortError');
      await sleep(100);
      const beforeRelease = await blocker.query('SELECT last_heartbeat_at FROM collab_hosts WHERE id = $1', [hostId]);
      await release();
      await sleep(1500);
      expect(await lastHeartbeatMs()).toBe(beforeRelease.rows[0].last_heartbeat_at.getTime());
    } finally {
      await release();
    }
  });

  it('a superseded lease ends a waiting poll promptly with stale_lease', async () => {
    const waiting = timed(poll({ waitMs: 10_000 }));
    expect(await stateAfter(waiting, 300)).toBe(PENDING);
    const supersededAt = performance.now();
    await db.getPool().query('UPDATE collab_hosts SET lease_epoch = lease_epoch + 1 WHERE id = $1', [hostId]);
    try {
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('stale_lease');
      expect(performance.now() - supersededAt).toBeLessThan(1500);
    } finally {
      await db.getPool().query('UPDATE collab_hosts SET lease_epoch = lease_epoch - 1 WHERE id = $1', [hostId]);
    }
  });

  it('a revoked host token ends a waiting poll promptly with 401', async () => {
    const waiting = timed(poll({ waitMs: 10_000 }));
    expect(await stateAfter(waiting, 300)).toBe(PENDING);
    const revokedAt = performance.now();
    await db.getPool().query('UPDATE collab_hosts SET revoked_at = now() WHERE id = $1', [hostId]);
    const res = await waiting;
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
    expect(performance.now() - revokedAt).toBeLessThan(1500);
  });
});
