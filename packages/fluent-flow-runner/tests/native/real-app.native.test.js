import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { startTestSupervisor } from './harness/start-test-supervisor.js';
import { createConnectorRuntime } from '../../src/connector/runtime.js';
import { loadConnectorConfig } from '../../src/connector/config.js';
import { profileRevision } from '../../src/connector/catalog.js';
import { connectSupervisor } from '../../src/supervisor/client.js';

vi.mock('@getpaseo/client', () => {
  const error = new Error("Cannot find package '@getpaseo/client' imported from real-app.native.test.js");
  Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' });
  throw error;
});

const run = promisify(execFile);

const databaseUrl = process.env.COLLAB_CONNECTOR_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_CONNECTOR_TEST_DATABASE_URL must name a dedicated loopback ff_connector_* database.');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/(ff_connector_[a-z0-9_]+|ff_c)$/.test(parsed.pathname)) throw new Error('Unsafe connector integration database.');
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'connector-native-secret-0123456789abcdef0123456789abcdef';

const claudeBin = requireNativeBinary('claude-code');
const codexBin = requireNativeBinary('codex');
const CLAUDE_MODEL = 'ff-e2e-claude-model';
const BIG_UNIT = '大きな出力🎉 native output ';
const BIG_TEXT = BIG_UNIT.repeat(Math.ceil((1024 * 1024 + 200_000) / Buffer.byteLength(BIG_UNIT, 'utf8')));
const CODEX_MODEL = 'ff-e2e-codex-model';

async function until(predicate, timeoutMs = 90_000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!claudeBin || !codexBin)('actual app with native backends (Task 7)', () => {
  let db;
  let server;
  let base;
  let actor;
  let project;
  let ctx;
  let root;
  let proxy;
  let anthropic;
  let openai;
  let supervisor;
  let client;
  let runtime;
  let running;
  let mapping;
  let stateDir;
  let configFile;
  const logs = [];

  async function request(method, path, body, key) {
    const response = await fetch(`${base}/api/collab/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, process.env.FF_COLLAB_AUTH_SECRET), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    return { status: response.status, data: result?.data, error: result?.error };
  }
  const query = async (text, params) => (await db.getPool().query(text, params)).rows;

  beforeAll(async () => {
    await assertNetworkIsolation();
    db = await import('@fluent-flow/db');
    const { createApp } = await import('../../../fluent-flow/src/app.js');
    await db.runMigrations();
    const suffix = randomUUID();
    const legacy = await db.getPool().query('INSERT INTO users(github_id,login,email,is_superadmin) VALUES($1,$2,$3,true) RETURNING id', [Math.floor(Math.random() * 1e9), `native-${suffix}`, `${suffix}@example.test`]);
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy.rows[0].id, displayName: 'Native owner', email: `${suffix}@example.test` });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const orgId = `native-${suffix}`;
    await db.getPool().query('INSERT INTO orgs(id,name) VALUES($1,$1)', [orgId]);
    const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Native fixture', idempotencyKey: suffix });
    project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native app composition' });
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    ctx = await createProbeContext('claude-code');
    root = ctx.root;
    const codexContext = join(root, 'codex-context');
    mkdirSync(codexContext, { mode: 0o700 });
    chmodSync(codexContext, 0o700);
    proxy = await startDenyProxy();
    anthropic = await startAnthropicFixture({
      mainModel: CLAUDE_MODEL,
      script: [
        { tool: 'ToolSearch', input: { query: 'select:mcp__ff_reporting__collaboration_report_progress', max_results: 1 } },
        { tool: 'mcp__ff_reporting__collaboration_report_progress', input: { text: 'E2E claude progress', percent: 50 } },
        { text: 'E2E claude output complete' },
        { text: BIG_TEXT },
      ],
    });
    openai = await startOpenAiFixture({
      mainModel: CODEX_MODEL,
      script: [
        { tool: 'mcp__ff_reporting.collaboration_report_progress', input: { text: 'E2E codex progress', percent: 60 } },
        { text: 'E2E codex output complete' },
      ],
    });
    const host = await db.createExecutionHost({ actor, name: 'Native fixture PC' });
    const tokenFile = join(root, 'host-token');
    writeFileSync(tokenFile, `${host.token}\n`, { mode: 0o600 });
    configFile = join(root, 'connector.json');
    writeFileSync(configFile, JSON.stringify({
      serverUrl: base, tokenFile, instanceId: 'native-e2e', repositories: { repo: ctx.repoDir },
      capacity: { 'claude-code': 8, codex: 8 },
      profiles: [
        { id: 'cc-e2e', name: 'Claude E2E', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: CLAUDE_MODEL, policy: { permissionMode: 'bypassPermissions' } },
        { id: 'cx-e2e', name: 'Codex E2E', backend: 'codex', executable: codexBin.executable, contextDir: codexContext, model: CODEX_MODEL, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false } },
      ],
    }));
    stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    supervisor = await startTestSupervisor({ stateDir, instanceId: 'native-e2e', configFile, fixtures: { anthropicUrl: anthropic.url, openaiUrl: openai.url, parentEnv: ctx.parentEnv, spawnEnvExtras: probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }) } });
    client = await connectSupervisor({ instanceId: 'native-e2e', stateDir, role: 'connector' });
    runtime = await createConnectorRuntime({ config: loadConnectorConfig({ file: configFile }), journalDir: stateDir, supervisor: client, intervals: { pollWaitMs: 0, baseBackoffMs: 10, maxBackoffMs: 50 }, log: (l) => logs.push(l) });
    await runtime.loop.register();
    mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'repo', profileIds: ['cc-e2e', 'cx-e2e'], defaultProfileId: 'cc-e2e' });
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
    await anthropic?.close();
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

  it('the unchanged COLLAB_CONNECTOR_TEST_DATABASE_URL passes the existing loopback guard and answers SELECT 1 through the bridge', async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.COLLAB_CONNECTOR_TEST_DATABASE_URL);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.port).not.toBe('');
    const pg = (await import('pg')).default;
    const direct = new pg.Client({ connectionString: databaseUrl });
    await direct.connect();
    try {
      expect((await direct.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      await direct.end();
    }
  });

  it('assertNetworkIsolation still passes while the bridge runs, and a loopback port other than the bridged one refuses connections', async () => {
    await assertNetworkIsolation();
    const other = Number(parsed.port) + 1;
    await expect(new Promise((resolveConnect, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: other });
      socket.once('connect', () => { socket.destroy(); resolveConnect('connected'); });
      socket.once('error', reject);
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(import('@getpaseo/client')).rejects.toThrow();
  });

  async function startOverHttp(profileId) {
    const task = await request('POST', `/projects/${project.id}/tasks`, { title: `Native ${profileId} task` });
    expect(task.status).toBe(201);
    const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId }, randomUUID());
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const runId = started.data.run.id;
    const [{ id: sessionId }] = await query('SELECT id FROM collab_sessions WHERE run_id=$1', [runId]);
    return { taskId: task.data.id, runId, sessionId };
  }

  async function assertNativeRun({ backend, runId, sessionId, taskId, progressText, outputText }) {
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, `${backend} session idle`);
    const [execution] = await query('SELECT workspace_ref FROM collab_run_execution WHERE run_id=$1', [runId]);
    expect(execution.workspace_ref).toMatch(/^ffw_[0-9a-f]{16}$/);
    const worktree = join(stateDir, 'worktrees', execution.workspace_ref);
    expect(execFileSync('git', ['-C', worktree, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(`refs/heads/ff/run-${runId}`);
    expect(await query('SELECT id FROM collab_sessions WHERE run_id=$1', [runId])).toHaveLength(1);
    const [session] = await query('SELECT native_session_id, binding_generation, backend FROM collab_session_execution WHERE session_id=$1', [sessionId]);
    expect(session).toMatchObject({ binding_generation: 1, backend });
    expect(session.native_session_id).toEqual(expect.any(String));
    expect((await query('SELECT paseo_agent_id FROM collab_sessions WHERE id=$1', [sessionId]))[0].paseo_agent_id).toBeNull();
    const ledger = readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const launch = ledger.find((r) => r.type === 'accept' && r.sessionId === sessionId && r.kind === 'launch');
    const bindAt = ledger.findIndex((r) => r.type === 'bind' && r.sessionId === sessionId);
    const promptAt = ledger.findIndex((r) => r.type === 'barrier' && r.commandId === launch.commandId && r.effect === 'prompt');
    expect(bindAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(bindAt);
    expect(ledger.filter((r) => r.type === 'barrier' && r.commandId === launch.commandId && r.effect === 'create_native_session')).toHaveLength(1);
    expect((await query('SELECT progress FROM collab_runs WHERE id=$1', [runId]))[0].progress).toMatchObject({ text: progressText });
    const history = await request('GET', `/sessions/${sessionId}/timeline?limit=200`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.data)).toContain(outputText);
    const usage = await query('SELECT tokens_in, tokens_out, unavailable_reason FROM collab_usage_samples WHERE run_id=$1', [runId]);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.tokens_in !== null || u.unavailable_reason !== null)).toBe(true);
    expect((await query('SELECT status FROM collab_tasks WHERE id=$1', [taskId]))[0].status).toBe('in_progress');
    expect((await query("SELECT payload FROM collab_task_events WHERE task_id=$1 AND kind='task_moved'", [taskId])).map((e) => e.payload.status)).toEqual(['in_progress']);
    expect(proxy.attempts).toEqual([]);
  }

  it('claude-code: Start over HTTP creates one worktree and session, binds before the first prompt, records progress through the actual FF MCP, streams output, reports usage availability and leaves task status unchanged', async () => {
    const { runId, sessionId, taskId } = await startOverHttp('cc-e2e');
    await assertNativeRun({ backend: 'claude-code', runId, sessionId, taskId, progressText: 'E2E claude progress', outputText: 'E2E claude output complete' });
    expect((await query('SELECT native_session_id FROM collab_session_execution WHERE session_id=$1', [sessionId]))[0].native_session_id).toBe(sessionId);
    expect(anthropic.unexpected).toEqual([]);
  }, 180_000);

  it('codex: Start over HTTP creates one worktree and session, binds before the first prompt, records progress through the actual FF MCP (after an HTTP approval), streams output, reports usage availability and leaves task status unchanged', async () => {
    const { runId, sessionId, taskId } = await startOverHttp('cx-e2e');
    const [pending] = await until(async () => {
      const listed = await request('GET', `/sessions/${sessionId}/pending-requests`);
      return listed.data?.length ? listed.data : null;
    }, 120_000, 'codex approval request');
    expect(pending.choices.map((c) => c.id)).toContain('accept');
    const answer = await request('POST', `/sessions/${sessionId}/commands`, { kind: 'permission', requestId: pending.requestId, fingerprint: pending.fingerprint, generation: pending.generation, response: { behavior: 'allow', selectedActionId: 'accept' } }, randomUUID());
    expect(answer.status, JSON.stringify(answer.error)).toBe(202);
    await assertNativeRun({ backend: 'codex', runId, sessionId, taskId, progressText: 'E2E codex progress', outputText: 'E2E codex output complete' });
    expect(openai.unexpected).toEqual([]);
    expect(readdirSync(join(stateDir, 'worktrees')).filter((n) => n.startsWith('ffw_'))).toHaveLength(2);
  }, 180_000);

  it('claude-code: a single >1 MiB multi-byte native event and the following events cross the whole chain intact: native -> ledger -> bounded IPC -> journal -> fragments over HTTP -> Postgres -> history', async () => {
    expect(Buffer.byteLength(BIG_TEXT, 'utf8')).toBeGreaterThan(1024 * 1024);
    const { runId, sessionId, taskId } = await startOverHttp('cc-e2e');
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'oversized session idle');
    const ledger = readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const spooled = ledger.filter((r) => r.type === 'event' && r.sessionId === sessionId);
    const big = spooled.find((r) => r.kind === 'timeline' && r.payload.event?.type === 'assistant_text' && r.payload.event.text === BIG_TEXT);
    expect(big, 'one normalized assistant_text event carrying the whole output').toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(big), 'utf8')).toBeGreaterThan(512 * 1024);
    const terminal = spooled.find((r) => r.kind === 'state' && r.payload.terminal === 'completed');
    expect(terminal.seq).toBeGreaterThan(big.seq);
    const eventId = `claude-code:${sessionId}:${big.generation}:${big.nativeEventId}`;
    const rows = await query('SELECT kind, payload FROM collab_connector_observations WHERE event_id=$1', [eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('timeline');
    expect(rows[0].payload.text).toBe(BIG_TEXT);
    expect(rows[0].payload.source).toEqual({ backend: 'claude-code', generation: big.generation, nativeEventId: big.nativeEventId, seq: big.seq });
    const fragments = await query("SELECT event_id FROM collab_connector_observations WHERE payload->>'fragmentOf'=$1 ORDER BY (payload->>'index')::int", [eventId]);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.map((f) => f.event_id)).toEqual(fragments.map((_, i) => `${eventId}#f${i}/${fragments.length}`));
    const following = await query("SELECT payload FROM collab_connector_observations WHERE session_id=$1 AND payload->'source'->>'seq' IS NOT NULL AND NOT (payload ? 'fragmentOf')", [sessionId]);
    expect(following.map((r) => Number(r.payload.source.seq))).toContain(terminal.seq);
    let entries = [];
    let cursor = null;
    for (;;) {
      const response = await fetch(`${base}/api/collab/v1/sessions/${sessionId}/timeline?limit=1${cursor ? `&cursor=${cursor}` : ''}`, { headers: { 'x-fluent-flow-actor': db.signCollaborationActor(actor, process.env.FF_COLLAB_AUTH_SECRET) } });
      expect(response.status).toBe(200);
      const page = await response.json();
      entries = entries.concat(page.data);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const nativeSeqs = entries.filter((e) => e.payload?.source?.backend === 'claude-code').map((e) => e.payload.source.seq);
    expect(nativeSeqs.length).toBeGreaterThan(1);
    expect(nativeSeqs).toEqual(spooled.filter((r) => r.kind === 'timeline' || r.kind === 'attention').map((r) => r.seq));
    expect(nativeSeqs).toContain(big.seq);
    expect(entries.some((e) => e.eventId.includes('#f'))).toBe(false);
    expect(entries.filter((e) => e.eventId.startsWith(eventId)).map((e) => e.eventId)).toEqual([eventId]);
    expect(entries.find((e) => e.eventId === eventId).payload.text).toBe(BIG_TEXT);
    const journal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const journaled = journal.find((r) => r.type === 'observation' && r.eventId === eventId);
    expect(journaled.payload.text).toBe(BIG_TEXT);
    expect(journal.some((r) => r.type === 'observation_accepted' && r.eventId === eventId)).toBe(true);
    expect(journal.some((r) => r.type === 'observation_accepted' && r.eventId.startsWith(`${eventId}#`))).toBe(false);
    expect(Math.max(...ledger.filter((r) => r.type === 'delivered').map((r) => r.seq))).toBeGreaterThanOrEqual(terminal.seq);
    expect((await query('SELECT status FROM collab_tasks WHERE id=$1', [taskId]))[0].status).toBe('in_progress');
    expect((await query('SELECT run_id FROM collab_sessions WHERE id=$1', [sessionId]))[0].run_id).toBe(runId);
  }, 180_000);

  it('the production supervisor entry never admits the dummy context: Start is refused with sign_in_required, or profile_unavailable where containment is unavailable, never accepted', async () => {
    const prodState = join(root, 'prod-state');
    mkdirSync(prodState, { mode: 0o700 });
    const prodHome = join(root, 'prod-home');
    mkdirSync(prodHome, { mode: 0o700 });
    const ownerLock = resolve(import.meta.dirname, '../../src/supervisor/owner-lock.js');
    const launched = await run(process.execPath, ['--input-type=module', '-e', `const { launchSupervisor } = await import(${JSON.stringify(ownerLock)}); const { pid } = await launchSupervisor({ stateDir: ${JSON.stringify(prodState)}, instanceId: 'native-prod', configFile: ${JSON.stringify(configFile)} }); console.log(pid);`], { env: { PATH: process.env.PATH ?? '', HOME: prodHome }, timeout: 60_000 });
    const prodPid = Number(launched.stdout.trim());
    const prodClient = await connectSupervisor({ instanceId: 'native-prod', stateDir: prodState, role: 'connector' });
    const before = { claude: anthropic.requests.length, codex: openai.requests.length };
    try {
      const status = await prodClient.request('status');
      for (const p of status.profiles) expect(['sign_in_required', 'platform_unsupported'], `${p.id}`).toContain(p.readiness.state);
      const prodHost = await db.createExecutionHost({ actor, name: 'Native production entry PC' });
      const prodConfig = { ...loadConnectorConfig({ file: configFile }), token: prodHost.token, instanceId: 'native-prod' };
      const prodRuntime = await createConnectorRuntime({ config: prodConfig, journalDir: join(prodState, 'journal'), supervisor: prodClient, intervals: { pollWaitMs: 0 }, log: () => {} });
      try {
        await prodRuntime.loop.register();
        const prodMapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: prodHost.id, repositoryKey: 'repo', profileIds: ['cc-e2e', 'cx-e2e'], defaultProfileId: 'cc-e2e' });
        for (const profileId of ['cc-e2e', 'cx-e2e']) {
          const task = await request('POST', `/projects/${project.id}/tasks`, { title: `Production refusal ${profileId}` });
          const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: prodMapping.id, profileId }, randomUUID());
          expect(started.status, profileId).toBe(422);
          expect(['sign_in_required', 'profile_unavailable'], profileId).toContain(started.error.code);
        }
      } finally {
        await prodRuntime.close();
      }
      const config = loadConnectorConfig({ file: configFile });
      for (const profile of config.profiles) {
        const result = await prodClient.request('submit', { commandId: randomUUID(), digest: 'd', runId: randomUUID(), sessionId: randomUUID(), backend: profile.backend, kind: 'launch', profileId: profile.id, profileRevision: profileRevision(profile, profile.backend === 'codex' ? '0.162.1' : '2.1.317'), repositoryKey: 'repo', branchName: `ff/prod-${profile.id}`, baseRef: 'main', role: 'work', reporting: { url: `${base}/mcp/collab`, credential: 'dummy-credential' } });
        expect(result.state, profile.id).toBe('failed');
        expect(['sign_in_required', 'profile_unavailable'], profile.id).toContain(result.errorCode);
      }
      expect({ claude: anthropic.requests.length, codex: openai.requests.length }).toEqual(before);
    } finally {
      await prodClient.close();
      try {
        process.kill(-prodPid, 'SIGTERM');
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  }, 120_000);
});
