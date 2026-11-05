import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, existsSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { startTestSupervisor } from './harness/start-test-supervisor.js';
import { createConnectorRuntime } from '../../src/connector/runtime.js';
import { createJournal } from '../../src/connector/journal.js';
import { loadConnectorConfig } from '../../src/connector/config.js';
import { connectSupervisor } from '../../src/supervisor/client.js';
import { assistantTextOf } from '../../src/supervisor/summary.js';

vi.mock('@getpaseo/client', () => {
  const error = new Error("Cannot find package '@getpaseo/client' imported from evidence.native.test.js");
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

const claudeBin = requireNativeBinary('claude-code');
const codexBin = requireNativeBinary('codex');
const WORK_MODEL = 'ff-t8-work-model';
const SUMMARY_MODEL = 'ff-t8-summary-model';
const CODEX_WORK_MODEL = 'ff-t8-codex-work-model';
const CODEX_SUMMARY_MODEL = 'ff-t8-codex-summary-model';
const EARLIER = 'EARLIER-SENTINEL alpha finding';
const LATER = 'LATER-SENTINEL omega finding';
const GIANT_UNIT = '大きな凍結ソース🎉 frozen source ';
const GIANT = GIANT_UNIT.repeat(Math.ceil((1024 * 1024 + 50_000) / Buffer.byteLength(GIANT_UNIT, 'utf8')));
const CX_EARLIER = 'CODEX-EARLIER-SENTINEL beta finding';
const CX_LATER = 'CODEX-LATER-SENTINEL psi finding';
const SUMMARY_TEXT = 'Summary: the alpha finding is in place.';
const CX_SUMMARY_TEXT = 'Summary: the beta finding is in place.';
const DEDUP_TEXT = 'Deduplicated summary body.';
const REPORT_SUMMARY = 'mcp__ff_reporting__collaboration_report_summary';
const HISTORY_MARK = '{"history":';

async function until(predicate, timeoutMs = 120_000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function findString(value, needle) {
  if (typeof value === 'string') return value.includes(needle) ? value : null;
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findString(item, needle);
      if (found) return found;
    }
  }
  return null;
}

function historyOf(request) {
  const text = findString(request.body, HISTORY_MARK);
  expect(text, 'the summary request carries the host-composed frozen history').toBeTruthy();
  return JSON.parse(text.slice(text.indexOf(HISTORY_MARK))).history;
}

describe.skipIf(!claudeBin || !codexBin)('native evidence and wrap-up through the actual app (Task 8)', () => {
  let db;
  let server;
  let base;
  let actor;
  let ctx;
  let proxy;
  let anthropic;
  let openai;
  let supervisor;
  let client;
  let runtime;
  let running;
  let stateDir;
  let host;
  const projects = {};
  const logs = [];

  async function request(method, path, body, key) {
    const response = await fetch(`${base}/api/collab/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, process.env.FF_COLLAB_AUTH_SECRET), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    return { status: response.status, data: result?.data, error: result?.error };
  }
  const query = async (text, params) => (await db.getPool().query(text, params)).rows;
  const ledger = () => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sessionEvents = (sessionId) => ledger().filter((r) => r.type === 'event' && r.sessionId === sessionId);

  async function project(name, { work, summary }) {
    const created = await db.createCollabProject({ actor, workspaceId: projects.workspaceId, name });
    const mapping = await db.createProjectHostMapping({ actor, projectId: created.id, hostId: host.id, repositoryKey: 'repo', profileIds: ['cc-work', 'cc-summary', 'cx-work', 'cx-summary'], defaultProfileId: work });
    if (summary) {
      await db.updateProjectExecutionDefaults({ actor, projectId: created.id, expectedVersion: created.version, executionDefaults: { mappingId: mapping.id, profileId: work, model: null, summary: { enabled: true, profileId: summary, model: null } } });
    }
    return { id: created.id, mappingId: mapping.id, work };
  }

  async function startRun(target) {
    const task = await request('POST', `/projects/${target.id}/tasks`, { title: `Task 8 ${randomUUID()}` });
    expect(task.status).toBe(201);
    const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: target.mappingId, profileId: target.work }, randomUUID());
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const runId = started.data.run.id;
    const [{ id: sessionId }] = await query("SELECT id FROM collab_sessions WHERE run_id=$1 AND role='work'", [runId]);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'work session idle');
    return { runId, sessionId };
  }

  async function prompt(sessionId, text, behavior) {
    const sent = await request('POST', `/sessions/${sessionId}/commands`, { kind: 'prompt', text, behavior }, randomUUID());
    expect(sent.status, JSON.stringify(sent.error)).toBe(202);
  }

  function completedText(sessionId, text) {
    const events = sessionEvents(sessionId);
    const found = events.find((r) => r.kind === 'timeline' && assistantTextOf(r.payload.event) === text);
    return found && events.some((r) => r.seq > found.seq && r.payload.terminal === 'completed') ? found : null;
  }

  async function command(id) {
    return until(async () => {
      const [row] = await query('SELECT state, error_code, result FROM collab_connector_commands WHERE id=$1', [id]);
      return row && ['applied', 'failed', 'ambiguous'].includes(row.state) ? row : null;
    }, 60_000, `command ${id}`);
  }

  async function wrapupPreflight(runId) {
    const queued = await request('POST', `/runs/${runId}/wrap-up-preflights`, undefined, randomUUID());
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const done = await command(queued.data.commandId);
    expect(done.state).toBe('applied');
    return { id: queued.data.commandId, result: done.result };
  }

  async function wrapup(runId, mode) {
    const pre = await wrapupPreflight(runId);
    const queued = await request('POST', `/runs/${runId}/wrap-ups`, { preflightId: pre.id, mode }, randomUUID());
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    return { preflight: pre.result, commandId: queued.data.commandId, ...(await command(queued.data.commandId)) };
  }

  async function summarizeWithLaterOutput({ runId, sessionId, promptLater, laterText, earlierSeq, backend }) {
    await runtime.nativePump.stop();
    let frozen;
    let queued;
    let later;
    try {
      await promptLater();
      later = await until(() => completedText(sessionId, laterText), 120_000, 'later output spooled in the ledger');
      [frozen] = await query('SELECT timeline_epoch, timeline_seq FROM collab_sessions WHERE id=$1', [sessionId]);
      expect(frozen.timeline_epoch).toBe(`ff-native-v1:${backend}`);
      expect(Number(frozen.timeline_seq)).toBeGreaterThanOrEqual(earlierSeq);
      expect(Number(frozen.timeline_seq)).toBeLessThan(later.seq);
      queued = await request('POST', `/runs/${runId}/summaries`, undefined, randomUUID());
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    } finally {
      runtime.nativePump.start();
    }
    const [cmd] = await query('SELECT session_id, payload FROM collab_connector_commands WHERE id=$1', [queued.data.commandId]);
    expect(cmd.payload.sourceCursor).toEqual({ epoch: `ff-native-v1:${backend}`, seq: frozen.timeline_seq });
    expect(cmd.payload.prompt).not.toContain(HISTORY_MARK);
    const done = await command(queued.data.commandId);
    expect(done.state, JSON.stringify(done)).toBe('applied');
    const [summary] = await until(async () => {
      const rows = await query('SELECT body, model, source_epoch, source_seq, session_id FROM collab_summaries WHERE session_id=$1', [cmd.session_id]);
      return rows.length ? rows : null;
    }, 180_000, 'summary recorded');
    return { frozen, cmd, summary };
  }

  async function closeAndArchive({ runId, expectedClosed }) {
    const [execution] = await query('SELECT workspace_ref FROM collab_run_execution WHERE run_id=$1', [runId]);
    const worktree = realpathSync(join(stateDir, 'worktrees', execution.workspace_ref));
    execFileSync('git', ['-C', worktree, 'push', '-q', '-u', 'origin', `ff/run-${runId}`]);
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const runSessions = new Set(ledger().filter((r) => r.type === 'accept' && r.runId === runId).map((r) => r.sessionId));
    const workers = ledger().filter((r) => r.type === 'worker' && runSessions.has(r.sessionId));
    expect(workers).toHaveLength(expectedClosed);
    const leafStates = async () => (await client.request('status')).workers.filter((w) => runSessions.has(w.sessionId)).map((w) => w.populated);
    expect(await leafStates()).toEqual(workers.map(() => true));

    const blocked = await wrapup(runId, 'archive_owned_workspace');
    expect(blocked.preflight.blockers.map((b) => b.code)).toContain('owned_activity');
    expect(blocked).toMatchObject({ state: 'failed', error_code: 'wrapup_blocked' });
    expect(existsSync(worktree)).toBe(true);

    const closed = await wrapup(runId, 'archive_sessions');
    expect(closed.state, JSON.stringify(closed)).toBe('applied');
    expect(closed.result).toMatchObject({ ok: true, archivedSessions: expectedClosed });
    for (const w of workers) {
      const exit = ledger().filter((r) => r.type === 'worker_exit' && r.sessionId === w.sessionId && r.generation === w.generation).at(-1).exit;
      expect(exit).toMatchObject({ kind: 'owned_stop', reason: 'wrapup', stop: 'quiesced' });
    }
    expect(await leafStates()).toEqual(workers.map(() => false));

    const archived = await wrapup(runId, 'archive_owned_workspace');
    expect(archived.preflight.blockers).toEqual([]);
    expect(archived.state, JSON.stringify(archived)).toBe('applied');
    expect(existsSync(worktree)).toBe(false);
    expect(execFileSync('git', ['-C', ctx.repoDir, 'rev-parse', `refs/heads/ff/run-${runId}`], { encoding: 'utf8' }).trim()).toBe(head);
    expect(execFileSync('git', ['-C', ctx.repoDir, 'log', '-1', '--format=%H', `refs/heads/ff/run-${runId}`], { encoding: 'utf8' }).trim()).toBe(head);
    const receipt = createJournal({ dir: stateDir }).workspaceArchive(runId, execution.workspace_ref);
    expect(receipt).toMatchObject({ git: { headCommit: head, upstream: `origin/ff/run-${runId}` } });
    const observed = await until(async () => {
      const rows = await query("SELECT payload FROM collab_connector_observations WHERE run_id=$1 AND kind='wrapup' AND event_id=$2", [runId, `wrapup:${archived.commandId}`]);
      return rows.length ? rows : null;
    }, 30_000, 'archive observation of this exact wrap-up command');
    expect(observed).toHaveLength(1);
    expect(observed[0].payload).toMatchObject({ phase: 'archive', ok: true, archivedWorkspace: true });
  }

  beforeAll(async () => {
    await assertNetworkIsolation();
    db = await import('@fluent-flow/db');
    const { createApp } = await import('../../../fluent-flow/src/app.js');
    await db.runMigrations();
    const suffix = randomUUID();
    const legacy = await db.getPool().query('INSERT INTO users(github_id,login,email,is_superadmin) VALUES($1,$2,$3,true) RETURNING id', [Math.floor(Math.random() * 1e9), `t8-${suffix}`, `${suffix}@example.test`]);
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy.rows[0].id, displayName: 'Task 8 owner', email: `${suffix}@example.test` });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const orgId = `t8-${suffix}`;
    await db.getPool().query('INSERT INTO orgs(id,name) VALUES($1,$1)', [orgId]);
    projects.workspaceId = (await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Task 8 fixture', idempotencyKey: suffix })).id;
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    ctx = await createProbeContext('claude-code');
    const codexContext = join(ctx.root, 'codex-context');
    mkdirSync(codexContext, { mode: 0o700 });
    chmodSync(codexContext, 0o700);
    const remote = join(ctx.root, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', ctx.repoDir, remote]);
    execFileSync('git', ['-C', ctx.repoDir, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', ctx.repoDir, 'fetch', '-q', 'origin']);
    proxy = await startDenyProxy();
    anthropic = await startAnthropicFixture({
      mainModel: WORK_MODEL,
      script: [
        { text: EARLIER },
        { text: GIANT },
        { text: LATER },
        { text: 'Disabled-summary project work.' },
        { text: 'Wrap-up run work.' },
      ],
      modelScripts: {
        [SUMMARY_MODEL]: [
          { text: SUMMARY_TEXT },
          { tool: 'ToolSearch', input: { query: `select:${REPORT_SUMMARY}`, max_results: 1 } },
          { tool: REPORT_SUMMARY, input: { body: DEDUP_TEXT } },
          { tool: REPORT_SUMMARY, input: { body: DEDUP_TEXT } },
          { text: DEDUP_TEXT },
        ],
      },
    });
    openai = await startOpenAiFixture({
      mainModel: CODEX_WORK_MODEL,
      script: [{ text: CX_EARLIER }, { text: CX_LATER }],
      modelScripts: { [CODEX_SUMMARY_MODEL]: [{ text: CX_SUMMARY_TEXT }] },
    });
    host = await db.createExecutionHost({ actor, name: 'Task 8 fixture PC' });
    const tokenFile = join(ctx.root, 'host-token');
    writeFileSync(tokenFile, `${host.token}\n`, { mode: 0o600 });
    const configFile = join(ctx.root, 'connector.json');
    const codexPolicy = { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false };
    writeFileSync(configFile, JSON.stringify({
      serverUrl: base, tokenFile, instanceId: 'native-t8', repositories: { repo: ctx.repoDir },
      capacity: { 'claude-code': 8, codex: 8 },
      profiles: [
        { id: 'cc-work', name: 'Claude work', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: WORK_MODEL, policy: { permissionMode: 'bypassPermissions' } },
        { id: 'cc-summary', name: 'Claude summary', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: SUMMARY_MODEL, policy: { permissionMode: 'bypassPermissions' } },
        { id: 'cx-work', name: 'Codex work', backend: 'codex', executable: codexBin.executable, contextDir: codexContext, model: CODEX_WORK_MODEL, policy: codexPolicy },
        { id: 'cx-summary', name: 'Codex summary', backend: 'codex', executable: codexBin.executable, contextDir: codexContext, model: CODEX_SUMMARY_MODEL, policy: codexPolicy },
      ],
    }));
    stateDir = join(ctx.root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    supervisor = await startTestSupervisor({ stateDir, instanceId: 'native-t8', configFile, pidNamespace: true, fixtures: { anthropicUrl: anthropic.url, openaiUrl: openai.url, parentEnv: ctx.parentEnv, spawnEnvExtras: probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }) } });
    client = await connectSupervisor({ instanceId: 'native-t8', stateDir, role: 'connector' });
    runtime = await createConnectorRuntime({ config: loadConnectorConfig({ file: configFile }), journalDir: stateDir, supervisor: client, intervals: { pollWaitMs: 0, baseBackoffMs: 10, maxBackoffMs: 50 }, log: (l) => logs.push(l) });
    await runtime.loop.register();
    projects.enabled = await project('Task 8 summaries enabled', { work: 'cc-work', summary: 'cc-summary' });
    projects.disabled = await project('Task 8 summaries disabled', { work: 'cc-work', summary: null });
    projects.codex = await project('Task 8 codex summaries', { work: 'cx-work', summary: 'cx-summary' });
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

  let summaryRun;

  it('claude-code: an explicit summary uses the frozen backend and cursor, and a frozen source larger than one IPC frame reaches the summary model whole', async () => {
    expect(Buffer.byteLength(GIANT, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(GIANT.length).toBeGreaterThan(200_000);
    const { runId, sessionId } = await startRun(projects.enabled);
    summaryRun = { runId, sessionId };
    const earlier = await until(() => completedText(sessionId, EARLIER), 30_000, 'EARLIER spooled');
    await prompt(sessionId, 'Write the long report.', 'steer');
    const giant = await until(() => completedText(sessionId, GIANT), 120_000, 'GIANT spooled');
    await until(async () => Number((await query('SELECT timeline_seq FROM collab_sessions WHERE id=$1', [sessionId]))[0].timeline_seq) > giant.seq, 120_000, 'server cursor past GIANT');
    const { frozen, cmd, summary } = await summarizeWithLaterOutput({ runId, sessionId, backend: 'claude-code', earlierSeq: giant.seq, laterText: LATER,
      promptLater: () => prompt(sessionId, 'Continue with the next finding.', 'steer') });
    expect(cmd.payload.execution).toMatchObject({ schemaVersion: 2, backend: 'claude-code', profileId: 'cc-summary' });
    expect(summary).toMatchObject({ body: SUMMARY_TEXT, model: SUMMARY_MODEL, source_epoch: 'ff-native-v1:claude-code', source_seq: frozen.timeline_seq, session_id: cmd.session_id });

    const [seen] = anthropic.requestsFor(SUMMARY_MODEL);
    expect(seen, 'one request on the frozen summary model').toBeTruthy();
    expect(JSON.stringify(seen.body)).not.toContain(LATER);
    const history = historyOf(seen);
    expect(history.sourceSessionId).toBe(sessionId);
    expect(history.sourceCursor).toEqual({ epoch: 'ff-native-v1:claude-code', seq: frozen.timeline_seq });
    expect(history.assistantText.length).toBe(`${EARLIER}\n\n${GIANT}`.length);
    expect(history.assistantText === `${EARLIER}\n\n${GIANT}`, 'the frozen source arrives byte for byte').toBe(true);
    expect(earlier.seq).toBeLessThan(giant.seq);
    expect(ledger().find((r) => r.type === 'accept' && r.sessionId === cmd.session_id)).toMatchObject({ kind: 'summarize', backend: 'claude-code' });
    expect((await query('SELECT backend FROM collab_session_execution WHERE session_id=$1', [cmd.session_id]))[0].backend).toBe('claude-code');
    expect(anthropic.requests).toHaveLength(3);
    expect(openai.requestsFor(CODEX_SUMMARY_MODEL)).toEqual([]);
    expect(anthropic.unexpected).toEqual([]);
    expect(proxy.attempts).toEqual([]);
  }, 360_000);

  it('duplicate reporting calls are deduplicated by the server', async () => {
    const before = anthropic.requestsFor(SUMMARY_MODEL).length;
    const queued = await request('POST', `/runs/${summaryRun.runId}/summaries`, undefined, randomUUID());
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const [cmd] = await query('SELECT session_id FROM collab_connector_commands WHERE id=$1', [queued.data.commandId]);
    const done = await command(queued.data.commandId);
    expect(done.state, JSON.stringify(done)).toBe('applied');
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [cmd.session_id]))[0].state === 'idle', 180_000, 'dedup summary idle');
    expect(anthropic.requestsFor(SUMMARY_MODEL).length - before).toBe(4);
    await until(async () => (await query("SELECT 1 FROM collab_connector_observations WHERE session_id=$1 AND kind='summary'", [cmd.session_id])).length > 0, 60_000, 'summary observation');
    const rows = await query('SELECT body, provenance, visibility FROM collab_summaries WHERE session_id=$1', [cmd.session_id]);
    expect(rows).toEqual([{ body: DEDUP_TEXT, provenance: 'agent', visibility: 'internal' }]);
    expect(anthropic.unexpected).toEqual([]);
  }, 240_000);

  it('disabled summaries start no worker', async () => {
    const { runId } = await startRun(projects.disabled);
    const before = { requests: anthropic.requestsFor(SUMMARY_MODEL).length, accepts: ledger().filter((r) => r.type === 'accept').length };
    const refused = await request('POST', `/runs/${runId}/summaries`, undefined, randomUUID());
    expect(refused.status).toBe(422);
    expect(refused.error.code).toBe('summary_unavailable');
    expect(await query("SELECT id FROM collab_sessions WHERE run_id=$1 AND role='summary'", [runId])).toEqual([]);
    expect(await query("SELECT id FROM collab_connector_commands WHERE run_id=$1 AND kind='summarize'", [runId])).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_000));
    expect({ requests: anthropic.requestsFor(SUMMARY_MODEL).length, accepts: ledger().filter((r) => r.type === 'accept').length }).toEqual(before);
  }, 240_000);

  it('claude-code: a real idle worker blocks archive until wrap-up closes it; then the clean pushed worktree archives without force and its receipt stays readable', async () => {
    const { runId } = await startRun(projects.enabled);
    await closeAndArchive({ runId, expectedClosed: 1 });
    expect(proxy.attempts).toEqual([]);
  }, 240_000);

  it('codex: an explicit summary uses the frozen backend, profile and cursor; its idle workers block archive until wrap-up closes them; the pushed worktree archives with branch, history and receipt kept', async () => {
    const { runId, sessionId } = await startRun(projects.codex);
    const earlier = await until(() => completedText(sessionId, CX_EARLIER), 30_000, 'codex EARLIER spooled');
    const { frozen, cmd, summary } = await summarizeWithLaterOutput({ runId, sessionId, backend: 'codex', earlierSeq: earlier.seq, laterText: CX_LATER,
      promptLater: () => prompt(sessionId, 'Continue with the next finding.', 'interrupt') });
    expect(cmd.payload.execution).toMatchObject({ schemaVersion: 2, backend: 'codex', profileId: 'cx-summary' });
    expect(summary).toMatchObject({ body: CX_SUMMARY_TEXT, model: CODEX_SUMMARY_MODEL, source_epoch: 'ff-native-v1:codex', source_seq: frozen.timeline_seq, session_id: cmd.session_id });
    const [seen] = openai.requestsFor(CODEX_SUMMARY_MODEL);
    expect(seen, 'one request on the frozen codex summary model').toBeTruthy();
    expect(JSON.stringify(seen.body)).not.toContain(CX_LATER);
    expect(historyOf(seen)).toEqual({ sourceSessionId: sessionId, sourceCursor: { epoch: 'ff-native-v1:codex', seq: frozen.timeline_seq }, assistantText: CX_EARLIER });
    expect(ledger().find((r) => r.type === 'accept' && r.sessionId === cmd.session_id)).toMatchObject({ kind: 'summarize', backend: 'codex' });
    expect(openai.requests).toHaveLength(2);
    expect(anthropic.requestsFor(SUMMARY_MODEL).filter((r) => JSON.stringify(r.body).includes(CX_EARLIER))).toEqual([]);
    await closeAndArchive({ runId, expectedClosed: 2 });
    expect(openai.unexpected).toEqual([]);
    expect(proxy.attempts).toEqual([]);
  }, 360_000);
});
