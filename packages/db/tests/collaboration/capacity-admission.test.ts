import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedLegacyUser,
  seedLegacyOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { closePool } from '../../src/pool.js';
import {
  ensureGithubPrincipal,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  createExecutionHost,
  createProjectHostMapping,
  startCollabRun,
  registerConnector,
  pollConnectorCommands,
  getCollabRun,
  submitSessionCommand,
  ackConnectorCommand,
  reconcileConnectorCommand,
  heartbeatConnector,
  listExecutionHosts,
  listProjectHostMappings,
} from '../../src/collaboration/identity.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

const CLAUDE_CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];
const CODEX_CAPS = [...CLAUDE_CAPS, 'secret_questions'];
const PASEO_CAPS = ['timeline', 'permissions', 'cancel', 'artifacts', 'wrapup'];

function entry(id: string, backend: 'claude-code' | 'codex' | 'paseo') {
  return {
    id,
    name: `Profile ${id}`,
    backend,
    model: backend === 'paseo' ? null : `${backend}-model-x`,
    revision: 'rev-1',
    capabilities: backend === 'claude-code' ? CLAUDE_CAPS : backend === 'codex' ? CODEX_CAPS : PASEO_CAPS,
    readiness: { state: 'ready' },
    harness: backend === 'claude-code' ? { name: 'claude-code', version: '2.1.317' } : backend === 'codex' ? { name: 'codex', version: '0.162.1' } : null,
    policy:
      backend === 'claude-code'
        ? { permissionMode: 'manual' }
        : backend === 'codex'
          ? { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }
          : null,
    authExpectation: backend === 'claude-code' ? 'claude-subscription' : backend === 'codex' ? 'chatgpt-subscription' : 'paseo',
    limits: backend === 'paseo' ? null : { maxActiveSessions: 1 },
  };
}

const capacity = { 'claude-code': { limit: 1, available: null, observedAt: null }, codex: { limit: 1, available: null, observedAt: null } };

async function rawQuery(text: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

type Host = { id: string; token: string; mappingId: string; connector: Awaited<ReturnType<typeof registerConnector>> };

describe('capacity admission (real Postgres)', () => {
  let manager;
  let operator;
  let projectId;
  let taskCounter = 0;
  const hosts: Record<string, Host> = {};

  async function addHost(name: string, catalog: Record<string, unknown>, profileIds: string[]) {
    const host = await createExecutionHost({ actor: manager, name });
    const mapping = await createProjectHostMapping({ actor: manager, projectId, hostId: host.id, repositoryKey: `repo/${name}`, profileIds, defaultProfileId: profileIds[0] });
    const connector = await registerConnector({ token: host.token, instanceId: `inst-${name}`, protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: catalog as never });
    hosts[name] = { id: host.id, token: host.token, mappingId: mapping.id, connector };
  }

  async function start(host: string, profileId: string) {
    taskCounter += 1;
    const taskId = (await createCollabTask({ actor: manager, projectId, title: `Capacity task ${taskCounter}` })).id;
    const started = await startCollabRun({ actor: operator, taskId, expectedVersion: 1, idempotencyKey: `capacity-${taskCounter}-key`, mappingId: hosts[host].mappingId, profileId });
    const launch = await rawQuery(`SELECT id, session_id FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`, [started.run.id]);
    return { runId: started.run.id as string, sessionId: launch[0].session_id as string, launchId: launch[0].id as string };
  }

  function poll(host: string, extra: Record<string, unknown> = {}) {
    const h = hosts[host];
    return pollConnectorCommands({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch, waitMs: 0, limit: 10, ...extra } as never);
  }

  async function commandRow(id: string) {
    return (await rawQuery(`SELECT state, claimed_at, lease_epoch, result FROM collab_connector_commands WHERE id = $1`, [id]))[0];
  }

  async function drain(host: string) {
    await rawQuery(`UPDATE collab_connector_commands SET state = 'applied', updated_at = now() WHERE host_id = $1 AND state IN ('pending', 'claimed', 'accepted')`, [hosts[host].id]);
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();
    const legacy = await seedLegacyUser(DATABASE_URL, { githubId: 9801, login: 'capacity-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacy, 'capacity-org', 'admin');
    const principal = await ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Capacity Owner', email: 'capacity-owner@example.test' });
    manager = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({ actor: manager, legacyOrgId: 'capacity-org', name: 'Capacity Client', idempotencyKey: 'capacity-ws-01' });
    projectId = (await createCollabProject({ actor: manager, workspaceId: ws.id, name: 'Capacity P1' })).id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'operator'`, [ws.id]);
    const op = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Capacity Operator', 'capacity-op@example.test') RETURNING id, session_version`);
    await rawQuery(`INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`, [ws.id, op[0].id, role[0].id]);
    operator = { principalId: op[0].id, sessionVersion: op[0].session_version };
    const v2 = (repo: string) => ({ formatVersion: 2, capacity, repositories: [{ key: repo }], profiles: [entry('cx', 'codex'), entry('cc', 'claude-code'), entry('px', 'paseo')] });
    await addHost('native', v2('repo/native'), ['cx', 'cc', 'px']);
    await addHost('legacy', { repositories: [{ key: 'repo/legacy' }], profiles: [{ id: 'ai3-coder', provider: 'omp', model: 'glm' }] }, ['ai3-coder']);
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('launches beyond availableSlots stay pending and are not redelivered after the claim lease', async () => {
    await drain('native');
    const runs = [await start('native', 'cx'), await start('native', 'cx'), await start('native', 'cx')];
    const first = await poll('native', { availableSlots: { codex: 1 } });
    expect(first.commands.map((c) => c.id)).toEqual([runs[0].launchId]);
    expect(first.commands[0].slotGranted).toBe(true);
    for (const waiting of runs.slice(1)) {
      expect(await commandRow(waiting.launchId)).toMatchObject({ state: 'pending', claimed_at: null, lease_epoch: null });
    }
    const catalog = (await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [hosts.native.id]))[0].catalog;
    expect(catalog.capacity.codex).toEqual({ limit: 1, available: 0, observedAt: expect.any(String) });
    expect(new Date(catalog.capacity.codex.observedAt).toString()).not.toBe('Invalid Date');
    expect(catalog.capacity['claude-code']).toEqual({ limit: 1, available: null, observedAt: null });
    expect(catalog.profiles.map((p: { id: string }) => p.id)).toEqual(['cx', 'cc', 'px']);

    await rawQuery(`UPDATE collab_connector_commands SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [runs[0].launchId]);
    const again = await poll('native', { availableSlots: { codex: 0 } });
    expect(again.commands.map((c) => c.id)).toEqual([runs[0].launchId]);
    expect(again.commands[0].slotGranted).toBeUndefined();
    for (const waiting of runs.slice(1)) {
      expect(await commandRow(waiting.launchId)).toMatchObject({ state: 'pending', claimed_at: null, lease_epoch: null });
    }
    expect((await poll('native', { availableSlots: { codex: 0 } })).commands).toEqual([]);
  });

  it('controls for active sessions are claimed while launches wait', async () => {
    await drain('native');
    const active = await start('native', 'cx');
    expect((await poll('native', { availableSlots: { codex: 1 } })).commands.map((c) => c.id)).toEqual([active.launchId]);
    await rawQuery(`UPDATE collab_sessions SET state = 'running' WHERE id = $1`, [active.sessionId]);
    await rawQuery(`UPDATE collab_runs SET state = 'running' WHERE id = $1`, [active.runId]);
    const backlog = [];
    for (let i = 0; i < 12; i += 1) backlog.push(await start('native', 'cx'));
    const claude = await start('native', 'cc');
    const steer = await submitSessionCommand({ actor: operator, sessionId: active.sessionId, idempotencyKey: 'capacity-steer-1', command: { kind: 'prompt', text: 'keep going', behavior: 'steer' } });
    const cancel = await submitSessionCommand({ actor: operator, sessionId: active.sessionId, idempotencyKey: 'capacity-cancel-1', command: { kind: 'cancel' } });

    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await poll('native', { availableSlots: { codex: 0, 'claude-code': 1 }, limit: 1 });
      seen.push(...res.commands.map((c) => c.id));
    }
    expect(seen).toEqual([claude.launchId, steer.commandId, cancel.commandId]);
    const delivered = await rawQuery(`SELECT id FROM collab_connector_commands WHERE id = ANY($1) AND state = 'claimed'`, [[steer.commandId, cancel.commandId]]);
    expect(delivered).toHaveLength(2);
    for (const waiting of backlog) expect((await commandRow(waiting.launchId)).state).toBe('pending');
  });

  it('per-backend FIFO with a created_at, id tie-break', async () => {
    await drain('native');
    const a = await start('native', 'cx');
    const b = await start('native', 'cx');
    const c = await start('native', 'cx');
    const other = await start('native', 'cc');
    await rawQuery(`UPDATE collab_connector_commands SET created_at = '2026-11-05T10:00:00Z' WHERE id = $1`, [a.launchId]);
    await rawQuery(`UPDATE collab_connector_commands SET created_at = '2026-11-05T10:00:01Z' WHERE id = ANY($1)`, [[b.launchId, c.launchId]]);
    const [lower, higher] = [b.launchId, c.launchId].sort();
    const order = [];
    for (let i = 0; i < 3; i += 1) order.push(...(await poll('native', { availableSlots: { codex: 1 } })).commands.map((cmd) => cmd.id));
    expect(order).toEqual([a.launchId, lower, higher]);
    expect((await commandRow(other.launchId)).state).toBe('pending');
    expect((await poll('native', { availableSlots: { 'claude-code': 1 } })).commands.map((cmd) => cmd.id)).toEqual([other.launchId]);
  });

  it('missing availableSlots withholds only native launches', async () => {
    await drain('native');
    await drain('legacy');
    const nativeRun = await start('native', 'cx');
    const paseoRun = await start('native', 'px');
    const legacyRun = await start('legacy', 'ai3-coder');
    const idle = await start('native', 'cc');
    await rawQuery(`UPDATE collab_connector_commands SET state = 'applied' WHERE id = $1`, [idle.launchId]);
    await rawQuery(`UPDATE collab_sessions SET state = 'idle' WHERE id = $1`, [idle.sessionId]);
    await rawQuery(`UPDATE collab_runs SET state = 'idle' WHERE id = $1`, [idle.runId]);
    const followUp = await submitSessionCommand({ actor: operator, sessionId: idle.sessionId, idempotencyKey: 'capacity-followup-1', command: { kind: 'prompt', text: 'one more thing', behavior: 'steer' } });

    const catalogBefore = (await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [hosts.native.id]))[0].catalog;
    const nativeOld = await poll('native');
    expect(nativeOld.commands.map((c) => c.id)).toEqual([paseoRun.launchId]);
    expect((await poll('legacy')).commands.map((c) => c.id)).toEqual([legacyRun.launchId]);
    for (const id of [nativeRun.launchId, followUp.commandId]) expect(await commandRow(id)).toMatchObject({ state: 'pending', claimed_at: null });
    expect((await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [hosts.native.id]))[0].catalog.capacity).toEqual(catalogBefore.capacity);
    expect((await poll('native', { availableSlots: { codex: 1, 'claude-code': 1 } })).commands.map((c) => c.id)).toEqual([nativeRun.launchId, followUp.commandId]);
  });

  it('a cancelled pending launch is never delivered', async () => {
    await drain('native');
    const queued = await start('native', 'cx');
    const cancel = await submitSessionCommand({ actor: operator, sessionId: queued.sessionId, idempotencyKey: 'capacity-cancel-queued', command: { kind: 'cancel' } });
    expect(await commandRow(queued.launchId)).toMatchObject({ state: 'cancelled', claimed_at: null, lease_epoch: null });
    expect(await commandRow(cancel.commandId)).toMatchObject({ state: 'applied', claimed_at: null, result: { dispatched: false } });
    expect((await rawQuery(`SELECT state FROM collab_runs WHERE id = $1`, [queued.runId]))[0].state).toBe('cancelled');
    expect((await rawQuery(`SELECT state FROM collab_sessions WHERE id = $1`, [queued.sessionId]))[0].state).toBe('cancelled');
    expect((await poll('native', { availableSlots: { codex: 1 } })).commands).toEqual([]);
    expect((await getCollabRun(operator, queued.runId)).queue).toBeNull();
  });

  it("queue shows only the actor's own queuedAt and reason", async () => {
    await drain('native');
    const admitted = await start('native', 'cx');
    const waiting = await start('native', 'cx');
    const later = await start('native', 'cx');
    expect((await poll('native', { availableSlots: { codex: 1 } })).commands.map((c) => c.id)).toEqual([admitted.launchId]);
    const createdAt = async (id: string) => new Date((await rawQuery(`SELECT created_at FROM collab_connector_commands WHERE id = $1`, [id]))[0].created_at).toISOString();

    const view = await getCollabRun(operator, waiting.runId);
    expect(view.queue).toEqual({ queuedAt: await createdAt(waiting.launchId), reason: 'capacity' });
    expect(Object.keys(view.queue ?? {}).sort()).toEqual(['queuedAt', 'reason']);
    expect((await getCollabRun(operator, later.runId)).queue).toEqual({ queuedAt: await createdAt(later.launchId), reason: 'capacity' });
    expect((await getCollabRun(operator, admitted.runId)).queue).toBeNull();

    await rawQuery(`UPDATE collab_hosts SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [hosts.native.id]);
    expect((await getCollabRun(operator, waiting.runId)).queue).toEqual({ queuedAt: await createdAt(waiting.launchId), reason: 'host_offline' });
    await rawQuery(`UPDATE collab_hosts SET last_heartbeat_at = now() WHERE id = $1`, [hosts.native.id]);
  });

  it('claims a host still holds are reported, redelivered as slotHeld at zero capacity, and an accepted lost ACK needs no slot', async () => {
    await drain('native');
    const a = await start('native', 'cx');
    const b = await start('native', 'cx');
    expect((await poll('native', { availableSlots: { codex: 2 } })).commands.map((c) => c.id)).toEqual([a.launchId, b.launchId]);
    const quiet = await poll('native', { availableSlots: { codex: 0 } });
    expect(quiet.commands).toEqual([]);
    expect(quiet.heldClaims).toEqual({ 'claude-code': 0, codex: 2 });
    await rawQuery(`UPDATE collab_connector_commands SET claimed_at = now() - interval '10 minutes' WHERE id = ANY($1)`, [[a.launchId, b.launchId]]);
    const first = await poll('native', { availableSlots: { codex: 0 }, limit: 1 });
    expect(first.commands.map((c) => [c.id, c.slotHeld, c.slotGranted])).toEqual([[a.launchId, true, undefined]]);
    expect(first.heldClaims).toEqual({ 'claude-code': 0, codex: 1 });
    const second = await poll('native', { availableSlots: { codex: 0 }, limit: 1 });
    expect(second.commands.map((c) => [c.id, c.slotHeld])).toEqual([[b.launchId, true]]);
    expect(second.heldClaims).toEqual({ 'claude-code': 0, codex: 1 });
    const h = hosts.native;
    expect(await ackConnectorCommand({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch, commandId: a.launchId, state: 'accepted', result: {} })).toEqual({ state: 'accepted' });
    await rawQuery(`UPDATE collab_connector_commands SET acked_at = now() - interval '1 minute' WHERE id = $1`, [a.launchId]);
    const replay = await poll('native', { availableSlots: { codex: 0 } });
    expect(replay.commands.map((c) => [c.id, c.slotHeld, c.slotGranted])).toEqual([[a.launchId, undefined, undefined]]);
    expect(replay.heldClaims.codex).toBe(1); // `b`, delivered above and not yet acknowledged
  });

  it('payload-less controls of a native run carry its frozen backend, legacy ones do not', async () => {
    await drain('native');
    await drain('legacy');
    const nativeRun = await start('native', 'cx');
    expect((await poll('native', { availableSlots: { codex: 1 } })).commands.map((c) => c.id)).toEqual([nativeRun.launchId]);
    await submitSessionCommand({ actor: operator, sessionId: nativeRun.sessionId, idempotencyKey: 'capacity-owner-cancel', command: { kind: 'cancel' } });
    const [cancel] = (await poll('native', { availableSlots: { codex: 0 } })).commands;
    expect(cancel).toMatchObject({ kind: 'cancel', nativeBackend: 'codex' });
    expect(cancel.payload.execution).toBeUndefined();
    const legacyRun = await start('legacy', 'ai3-coder');
    expect((await poll('legacy')).commands.map((c) => c.id)).toEqual([legacyRun.launchId]);
    await submitSessionCommand({ actor: operator, sessionId: legacyRun.sessionId, idempotencyKey: 'capacity-legacy-cancel', command: { kind: 'cancel' } });
    const [legacyCancel] = (await poll('legacy')).commands;
    expect(legacyCancel.kind).toBe('cancel');
    expect(legacyCancel.nativeBackend).toBeUndefined();
  });

  it('invalid waiting launches fail or cancel undelivered with no free slot, while valid ones keep waiting', async () => {
    const gatedCatalog = (profiles: Array<Record<string, unknown>>) => ({ formatVersion: 2, capacity, repositories: [{ key: 'repo/gated' }], profiles });
    await addHost('gated', gatedCatalog([entry('g-ok', 'codex'), entry('g-rev', 'codex'), entry('g-unready', 'codex'), entry('g-auth', 'codex')]), ['g-ok', 'g-rev', 'g-unready', 'g-auth']);
    const ws = (await rawQuery(`SELECT workspace_id FROM collab_projects WHERE id = $1`, [projectId]))[0].workspace_id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'operator'`, [ws]);
    const other = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Leaving Operator', 'leaving-op@example.test') RETURNING id, session_version`);
    await rawQuery(`INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`, [ws, other[0].id, role[0].id]);
    const ok = await start('gated', 'g-ok');
    const rev = await start('gated', 'g-rev');
    const unready = await start('gated', 'g-unready');
    taskCounter += 1;
    const authTask = (await createCollabTask({ actor: manager, projectId, title: `Capacity task ${taskCounter}` })).id;
    const authRun = await startCollabRun({ actor: { principalId: other[0].id, sessionVersion: other[0].session_version }, taskId: authTask, expectedVersion: 1, idempotencyKey: 'capacity-leaving', mappingId: hosts.gated.mappingId, profileId: 'g-auth' });
    const authLaunch = (await rawQuery(`SELECT id FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`, [authRun.run.id]))[0].id;
    await rawQuery(`UPDATE collab_principals SET disabled_at = now() WHERE id = $1`, [other[0].id]);
    hosts.gated.connector = await registerConnector({ token: hosts.gated.token, instanceId: 'inst-gated', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: gatedCatalog([entry('g-ok', 'codex'), { ...entry('g-rev', 'codex'), revision: 'rev-2' }, { ...entry('g-unready', 'codex'), readiness: { state: 'sign_in_required' } }, entry('g-auth', 'codex')]) as never });
    for (const slots of [undefined, { codex: 0 }]) {
      expect((await poll('gated', slots ? { availableSlots: slots } : {})).commands).toEqual([]);
    }
    expect(await rawQuery(`SELECT id, state, error_code, claimed_at FROM collab_connector_commands WHERE id = ANY($1) ORDER BY created_at`, [[ok.launchId, rev.launchId, unready.launchId, authLaunch]])).toEqual([
      { id: ok.launchId, state: 'pending', error_code: null, claimed_at: null },
      { id: rev.launchId, state: 'failed', error_code: 'execution_settings_changed', claimed_at: null },
      { id: unready.launchId, state: 'failed', error_code: 'execution_settings_changed', claimed_at: null },
      { id: authLaunch, state: 'cancelled', error_code: 'authorization_withdrawn', claimed_at: null },
    ]);
    expect((await getCollabRun(operator, ok.runId)).queue?.reason).toBe('capacity');
    hosts.gated.connector = await registerConnector({ token: hosts.gated.token, instanceId: 'inst-gated', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: { repositories: [{ key: 'repo/gated' }], profiles: [{ id: 'g-ok', provider: 'omp', model: 'x' }] } });
    expect((await poll('gated')).commands).toEqual([]);
    expect(await commandRow(ok.launchId)).toMatchObject({ state: 'failed', claimed_at: null });
  });

  it('a launch requeued by operator redelivery is not cancelled inline; its Cancel goes to the native owner', async () => {
    await drain('native');
    const run = await start('native', 'cx');
    expect((await poll('native', { availableSlots: { codex: 1 } })).commands.map((c) => c.id)).toEqual([run.launchId]);
    const h = hosts.native;
    expect(await ackConnectorCommand({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch, commandId: run.launchId, state: 'ambiguous', errorCode: 'reconciling' })).toEqual({ state: 'ambiguous' });
    expect(await reconcileConnectorCommand({ actor: manager, commandId: run.launchId, action: 'redeliver' })).toEqual({ state: 'pending' });
    const cancel = await submitSessionCommand({ actor: operator, sessionId: run.sessionId, idempotencyKey: 'capacity-requeued-cancel', command: { kind: 'cancel' } });
    expect(await commandRow(cancel.commandId)).toMatchObject({ state: 'pending', result: null });
    expect((await rawQuery(`SELECT state, error_code FROM collab_connector_commands WHERE id = $1`, [run.launchId]))[0]).toEqual({ state: 'ambiguous', error_code: 'redelivery_withdrawn_by_cancel' });
    expect((await rawQuery(`SELECT state FROM collab_runs WHERE id = $1`, [run.runId]))[0].state).toBe('reconciling');
    const delivered = await poll('native', { availableSlots: { codex: 1 }, limit: 1 });
    expect(delivered.commands.map((c) => [c.id, c.kind, c.nativeBackend])).toEqual([[cancel.commandId, 'cancel', 'codex']]);
    expect((await poll('native', { availableSlots: { codex: 1 }, limit: 10 })).commands).toEqual([]);
    expect((await commandRow(run.launchId)).state).toBe('ambiguous');
    expect((await getCollabRun(operator, run.runId)).unresolvedCommands.find((c) => c.id === run.launchId)).toMatchObject({ state: 'ambiguous', errorCode: 'redelivery_withdrawn_by_cancel' });
    const fresh = await start('native', 'cx');
    const inline = await submitSessionCommand({ actor: operator, sessionId: fresh.sessionId, idempotencyKey: 'capacity-fresh-cancel', command: { kind: 'cancel' } });
    expect(await commandRow(inline.commandId)).toMatchObject({ state: 'applied', result: { dispatched: false } });
    expect((await commandRow(fresh.launchId)).state).toBe('cancelled');
  });

  it('a poll past its notAfter claims no slot work, even when it was delayed behind a later answer', async () => {
    await drain('native');
    const h = hosts.native;
    const registered = await registerConnector({ token: h.token, instanceId: 'inst-native', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: (await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [h.id]))[0].catalog });
    expect(new Date(registered.serverTime as string).toString()).not.toBe('Invalid Date');
    const waiting = await start('native', 'cx');
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    const notAfter = new Date(Date.now() + 100).toISOString();
    const p1 = pollConnectorCommands({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch, waitMs: 0, limit: 10, availableSlots: { codex: 1 }, notAfter,
      beforeClaim: async () => { reached(); await gate; } } as never);
    await atGate;
    while (Date.now() <= Date.parse(notAfter) + 20) await new Promise((r) => setTimeout(r, 10));
    const p2 = await poll('native', { availableSlots: { codex: 0 } });
    expect(Date.parse(p2.serverTime as string)).toBeGreaterThan(Date.parse(notAfter));
    expect(p2.heldClaims).toEqual({ 'claude-code': 0, codex: 0 });
    open();
    const late = await p1;
    expect(late.commands).toEqual([]);
    expect(await commandRow(waiting.launchId)).toMatchObject({ state: 'pending', claimed_at: null, lease_epoch: null });
    const timely = await poll('native', { availableSlots: { codex: 1 }, notAfter: new Date(Date.now() + 60_000).toISOString() });
    expect(timely.commands.map((c) => c.id)).toEqual([waiting.launchId]);
  });

  it('a backwards database clock cannot reopen a poll whose deadline an earlier answer already passed', async () => {
    await drain('native');
    const h = hosts.native;
    const waiting = await start('native', 'cx');
    const ahead = new Date(Date.now() + 10 * 60_000);
    await rawQuery(`UPDATE collab_hosts SET catalog = jsonb_set(catalog, '{pollAuthority}', to_jsonb($2::text)) WHERE id = $1`, [h.id, ahead.toISOString()]);
    const notAfter = new Date(Date.now() + 5 * 60_000).toISOString();
    const late = await poll('native', { availableSlots: { codex: 1 }, notAfter });
    expect(Date.parse(late.serverTime as string)).toBeGreaterThanOrEqual(ahead.getTime());
    expect(late.commands).toEqual([]);
    expect(await commandRow(waiting.launchId)).toMatchObject({ state: 'pending', claimed_at: null });
    await heartbeatConnector({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch });
    expect(new Date((await rawQuery(`SELECT last_heartbeat_at FROM collab_hosts WHERE id = $1`, [h.id]))[0].last_heartbeat_at).getTime()).toBeLessThan(ahead.getTime());
    expect((await poll('native', { availableSlots: { codex: 1 }, notAfter })).commands).toEqual([]);
  });

  it('a forward authority stamp never reopens an old poll, while a corrected-clock real heartbeat restores freshness and a disconnect ages out', async () => {
    const clocked = (repo: string) => ({ formatVersion: 2, capacity, repositories: [{ key: repo }], profiles: [entry('k-cx', 'codex')] });
    await addHost('clocked', clocked('repo/clocked'), ['k-cx']);
    const h = hosts.clocked;
    const waiting = await start('clocked', 'k-cx');
    const realNow = Date.now();
    const forward = new Date(realNow + 10 * 60_000);
    await rawQuery(`UPDATE collab_hosts SET last_heartbeat_at = $2, catalog = jsonb_set(catalog, '{pollAuthority}', to_jsonb($3::text)) WHERE id = $1`, [h.id, forward, forward.toISOString()]);
    const notAfter = new Date(realNow + 5 * 60_000).toISOString();
    const pollWith = (extra: Record<string, unknown>) => pollConnectorCommands({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch, waitMs: 0, limit: 10, ...extra } as never);
    await heartbeatConnector({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch });
    const contact = new Date((await rawQuery(`SELECT last_heartbeat_at FROM collab_hosts WHERE id = $1`, [h.id]))[0].last_heartbeat_at).getTime();
    expect(contact).toBeLessThan(realNow + 60_000);
    const old = await pollWith({ availableSlots: { codex: 1 }, notAfter });
    expect(old.commands).toEqual([]);
    expect(Date.parse(old.serverTime as string)).toBeGreaterThanOrEqual(forward.getTime());
    h.connector = await registerConnector({ token: h.token, instanceId: 'inst-clocked', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: { ...clocked('repo/clocked'), pollAuthority: '2000-01-01T00:00:00.000Z' } as never });
    expect(Date.parse(h.connector.serverTime as string)).toBeGreaterThanOrEqual(forward.getTime());
    expect((await pollWith({ availableSlots: { codex: 1 }, notAfter })).commands).toEqual([]);
    expect(await commandRow(waiting.launchId)).toMatchObject({ state: 'pending', claimed_at: null });
    const reads = JSON.stringify([await listExecutionHosts(manager), await listProjectHostMappings(manager, projectId), await getCollabRun(operator, waiting.runId)]);
    expect(reads).not.toContain('pollAuthority');
    const lastContact = new Date((await rawQuery(`SELECT last_heartbeat_at FROM collab_hosts WHERE id = $1`, [h.id]))[0].last_heartbeat_at).getTime();
    expect(lastContact).toBeLessThan(realNow + 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.max(lastContact, Date.now()) + 3 * 60_000);
    const host = (await listExecutionHosts(manager)).find((x) => x.id === h.id);
    expect(host?.reachability).toBe('offline');
    expect((await listProjectHostMappings(manager, projectId)).find((m) => m.hostId === h.id)?.hostReachability).toBe('offline');
    const view = await getCollabRun(operator, waiting.runId);
    expect(view.run.hostReachability).toBe('offline');
    expect(Date.parse(view.run.hostLastSeenAt as string)).toBe(lastContact);
    expect(view.queue?.reason).toBe('host_offline');
    const replacement = await registerConnector({ token: h.token, instanceId: 'inst-clocked-replacement', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: clocked('repo/clocked') as never });
    expect(replacement.connectorSessionId).not.toBe(h.connector.connectorSessionId);
    expect(Date.parse(replacement.serverTime as string)).toBeGreaterThanOrEqual(forward.getTime());
    vi.useRealTimers();
    await expect(pollWith({ availableSlots: { codex: 1 }, notAfter })).rejects.toMatchObject({ code: 'stale_lease' });
    expect((await commandRow(waiting.launchId)).state).toBe('pending');
  });

  it('legacy connector liveness is unchanged: a heartbeat records the contact and a disconnect ages out', async () => {
    const h = hosts.legacy;
    await heartbeatConnector({ token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch });
    expect((await listExecutionHosts(manager)).find((x) => x.id === h.id)?.reachability).toBe('online');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect((await listExecutionHosts(manager)).find((x) => x.id === h.id)?.reachability).toBe('offline');
    vi.useRealTimers();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
