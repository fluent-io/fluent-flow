import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNetworkIsolation } from './harness/isolation.js';
import { platformCodex, requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { startTestSupervisor } from './harness/start-test-supervisor.js';
import { createConnectorRuntime } from '../../src/connector/runtime.js';
import { loadConnectorConfig } from '../../src/connector/config.js';
import { connectSupervisor } from '../../src/supervisor/client.js';

vi.mock('@getpaseo/client', () => {
  const error = new Error("Cannot find package '@getpaseo/client' imported from capacity.native.test.js");
  Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' });
  throw error;
});

const databaseUrl = process.env.COLLAB_CONNECTOR_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_CONNECTOR_TEST_DATABASE_URL must name a dedicated loopback ff_connector_* database.');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/(ff_connector_[a-z0-9_]+|ff_c)$/.test(parsed.pathname)) throw new Error('Unsafe connector integration database.');
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'connector-native-secret-0123456789abcdef0123456789abcdef';

const codexBin = requireNativeBinary('codex');
const FIRST_MODEL = 'ff-capacity-first';
const SECOND_MODEL = 'ff-capacity-second';
const LIMIT_MODEL = 'ff-capacity-limit';
const INSTANCE = 'native-capacity';
const USAGE_LIMIT = { status: 429, body: { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_in_seconds: 3600 } } };

async function until(predicate, timeoutMs = 90_000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!codexBin)('capacity admission through the actual app (Task 10)', () => {
  let db;
  let server;
  let base;
  let actor;
  let project;
  let ctx;
  let proxy;
  let openai;
  let supervisor;
  let client;
  let runtime;
  let running;
  let mapping;
  let stateDir;
  let first;
  let second;
  let releasedAt;
  const logs = [];

  async function request(method, path, body, key) {
    const response = await fetch(`${base}/api/collab/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, process.env.FF_COLLAB_AUTH_SECRET), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    return { status: response.status, data: result?.data, error: result?.error };
  }
  const query = async (text, params) => (await db.getPool().query(text, params)).rows;
  const ledgerRecords = () => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sessionState = async (sessionId) => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state;
  const launchOf = async (runId) => (await query("SELECT id, state, claimed_at, lease_epoch FROM collab_connector_commands WHERE run_id=$1 AND kind='launch'", [runId]))[0];

  async function startOverHttp(profileId) {
    const task = await request('POST', `/projects/${project.id}/tasks`, { title: `Capacity ${profileId} task` });
    expect(task.status).toBe(201);
    const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId }, randomUUID());
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const runId = started.data.run.id;
    const [{ id: sessionId }] = await query('SELECT id FROM collab_sessions WHERE run_id=$1', [runId]);
    return { taskId: task.data.id, runId, sessionId };
  }

  beforeAll(async () => {
    await assertNetworkIsolation();
    db = await import('@fluent-flow/db');
    const { createApp } = await import('../../../fluent-flow/src/app.js');
    await db.runMigrations();
    const suffix = randomUUID();
    const legacy = await db.getPool().query('INSERT INTO users(github_id,login,email,is_superadmin) VALUES($1,$2,$3,true) RETURNING id', [Math.floor(Math.random() * 1e9), `capacity-${suffix}`, `${suffix}@example.test`]);
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy.rows[0].id, displayName: 'Capacity owner', email: `${suffix}@example.test` });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const orgId = `capacity-${suffix}`;
    await db.getPool().query('INSERT INTO orgs(id,name) VALUES($1,$1)', [orgId]);
    const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Capacity fixture', idempotencyKey: suffix });
    project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native capacity' });
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    ctx = await createProbeContext('codex');
    const codexContext = join(ctx.root, 'codex-context');
    mkdirSync(codexContext, { mode: 0o700 });
    chmodSync(codexContext, 0o700);
    proxy = await startDenyProxy();
    openai = await startOpenAiFixture({
      mainModel: FIRST_MODEL,
      script: [{ hold: true, text: 'first working' }, { hold: true, text: 'first steered' }],
      modelScripts: { [SECOND_MODEL]: [{ text: 'second done' }], [LIMIT_MODEL]: [{ httpError: USAGE_LIMIT }] },
    });
    const host = await db.createExecutionHost({ actor, name: 'Capacity fixture PC' });
    const tokenFile = join(ctx.root, 'host-token');
    writeFileSync(tokenFile, `${host.token}\n`, { mode: 0o600 });
    const configFile = join(ctx.root, 'connector.json');
    const executable = platformCodex(codexBin.executable);
    const profile = (id, model) => ({ id, name: id, backend: 'codex', executable, contextDir: codexContext, model, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false } });
    writeFileSync(configFile, JSON.stringify({
      serverUrl: base, tokenFile, instanceId: INSTANCE, repositories: { repo: ctx.repoDir },
      profiles: [profile('cx-first', FIRST_MODEL), profile('cx-second', SECOND_MODEL), profile('cx-limit', LIMIT_MODEL)],
    }));
    stateDir = join(ctx.root, `connector-${INSTANCE}`);
    mkdirSync(stateDir, { mode: 0o700 });
    supervisor = await startTestSupervisor({ stateDir, instanceId: INSTANCE, configFile, fixtures: { openaiUrl: openai.url, parentEnv: ctx.parentEnv, spawnEnvExtras: probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }) } });
    client = await connectSupervisor({ instanceId: INSTANCE, stateDir, role: 'connector' });
    runtime = await createConnectorRuntime({ config: loadConnectorConfig({ file: configFile }), journalDir: stateDir, supervisor: client, intervals: { baseBackoffMs: 10, maxBackoffMs: 50 }, log: (l) => logs.push(l) });
    await runtime.loop.register();
    mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'repo', profileIds: ['cx-first', 'cx-second', 'cx-limit'], defaultProfileId: 'cx-first' });
    running = runtime.start();
  }, 120_000);

  afterAll(async () => {
    if (runtime) {
      runtime.loop.stop();
      await running;
      await runtime.close();
    }
    if (client) {
      await client.request('stop', { scope: 'all', timeoutMs: 10_000 }).catch((err) => logs.push({ msg: 'stop failed', error: err.message }));
      await client.close();
    }
    await supervisor?.close();
    await openai?.close();
    await proxy?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (db) {
      await db.closePool();
      await db.pool.end();
    }
    await ctx?.cleanup();
  }, 60_000);

  it('a second Codex launch waits with reason capacity until the first settles', async () => {
    first = await startOverHttp('cx-first');
    await until(async () => openai.requestsFor(FIRST_MODEL).length >= 1 && (await sessionState(first.sessionId)) === 'running', 120_000, 'first turn running');
    second = await startOverHttp('cx-second');
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await launchOf(second.runId)).toMatchObject({ state: 'pending', claimed_at: null, lease_epoch: null });
    expect(openai.requestsFor(SECOND_MODEL)).toHaveLength(0);
    const view = await request('GET', `/runs/${second.runId}`);
    const [{ created_at: queuedAt }] = await query("SELECT created_at FROM collab_connector_commands WHERE run_id=$1 AND kind='launch'", [second.runId]);
    expect(view.data.queue).toEqual({ queuedAt: new Date(queuedAt).toISOString(), reason: 'capacity' });
    const [{ catalog }] = await query('SELECT catalog FROM collab_hosts WHERE id=(SELECT host_id FROM collab_runs WHERE id=$1)', [second.runId]);
    expect(catalog.capacity.codex).toMatchObject({ limit: 1, available: 0 });
    const steer = await request('POST', `/sessions/${first.sessionId}/commands`, { kind: 'prompt', text: 'Also note the capacity test.', behavior: 'steer' }, randomUUID());
    expect(steer.status, JSON.stringify(steer.error)).toBe(202);
    await until(async () => (await query('SELECT state FROM collab_connector_commands WHERE id=$1', [steer.data.commandId]))[0].state === 'applied', 60_000, 'steer applied');
    expect((await launchOf(second.runId)).state).toBe('pending');
  }, 240_000);

  it('once the first turn ends with no background process, the retained idle worker frees its slot and the queued launch starts while the first worker stays alive', async () => {
    releasedAt = new Date();
    openai.release(0);
    openai.release(1);
    await until(async () => (await sessionState(first.sessionId)) === 'idle', 120_000, 'first session idle');
    await until(async () => (await sessionState(second.sessionId)) === 'idle', 120_000, 'second session idle');
    const launch = await launchOf(second.runId);
    expect(['claimed', 'accepted', 'applied']).toContain(launch.state);
    expect(new Date(launch.claimed_at).getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
    expect(openai.requestsFor(SECOND_MODEL)).toHaveLength(1);
    expect((await request('GET', `/runs/${second.runId}`)).data.queue).toBeNull();
    const records = ledgerRecords();
    const firstWorker = records.find((r) => r.type === 'worker' && r.sessionId === first.sessionId);
    expect(() => process.kill(firstWorker.identity.pid, 0)).not.toThrow();
    expect(records.some((r) => r.type === 'worker_exit' && r.sessionId === first.sessionId)).toBe(false);
    const slotRecords = records.filter((r) => r.type.startsWith('slot_')).map((r) => [r.type, r.sessionId]);
    expect(slotRecords.slice(0, 3)).toEqual([['slot_reserve', first.sessionId], ['slot_release', first.sessionId], ['slot_reserve', second.sessionId]]);
    const status = await client.request('status', {});
    expect(status.workers.find((w) => w.sessionId === first.sessionId)).toMatchObject({ populated: true });
    expect(openai.unexpected).toEqual([]);
  }, 240_000);

  it('a synthetic account-limit error yields account_limited and no further FF prompt', async () => {
    await until(async () => (await request('GET', `/runs/${second.runId}`)).data.queue === null, 30_000, 'second admitted');
    const limited = await startOverHttp('cx-limit');
    await until(async () => (await sessionState(limited.sessionId)) === 'failed', 120_000, 'limited session failed');
    const [run] = await query('SELECT state, error_code FROM collab_runs WHERE id=$1', [limited.runId]);
    expect(run).toEqual({ state: 'failed', error_code: 'account_limited' });
    const terminal = await query("SELECT payload FROM collab_connector_observations WHERE session_id=$1 AND kind='state' AND payload->>'state'='failed'", [limited.sessionId]);
    expect(terminal.map((o) => o.payload.errorCode)).toContain('account_limited');
    await new Promise((r) => setTimeout(r, 5_000));
    expect(openai.requestsFor(LIMIT_MODEL)).toHaveLength(1);
    expect(await query('SELECT kind FROM collab_connector_commands WHERE session_id=$1', [limited.sessionId])).toEqual([{ kind: 'launch' }]);
    const prompts = ledgerRecords().filter((r) => r.type === 'barrier' && r.effect === 'prompt');
    const launchId = (await launchOf(limited.runId)).id;
    expect(prompts.filter((r) => r.commandId === launchId)).toHaveLength(1);
    const history = await request('GET', `/sessions/${limited.sessionId}/timeline?limit=200`);
    expect(JSON.stringify(history.data)).not.toContain('The usage limit has been reached');
  }, 240_000);
});
