import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { startTestSupervisor } from './harness/start-test-supervisor.js';
import { createConnectorRuntime } from '../../src/connector/runtime.js';
import { loadConnectorConfig } from '../../src/connector/config.js';
import { connectSupervisor } from '../../src/supervisor/client.js';
import { LOCAL_ANSWER_WARNING, runLocalAnswer } from '../../src/supervisor/cli.js';

vi.mock('@getpaseo/client', () => {
  const error = new Error("Cannot find package '@getpaseo/client' imported from answers.native.test.js");
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
const CLAUDE_MODEL = 'ff-answers-claude-model';
const CLAUDE_WEB_MODEL = 'ff-answers-claude-web';
const CLAUDE_WEB_NOTE = 'claude-web-note-41';
const CLAUDE_SEQ_MODEL = 'ff-answers-claude-seq';
const SEQ_OPTIONS = [{ label: 'Blue', description: 'b' }, { label: 'Green', description: 'g' }, { label: 'Red', description: 'r' }];
const CODEX_SECRET_MODEL = 'ff-answers-codex-secret';
const CODEX_WAIT_MODEL = 'ff-answers-codex-wait';
const INSTANCE = 'native-answers';
const SECRET = 'tok-local-7Qx9-secret';
const CLAUDE_NOTE = 'claude-local-note-93';
const SECRET_Q = { id: 'token', header: 'Token', question: 'Paste the deploy token', allowOther: true, secret: true };
const WAIT_Q = { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] };
const CLAUDE_QUESTIONS = [{ question: 'Which color do you want?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }];

async function until(predicate, timeoutMs = 90_000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
const needlesOf = (value) => [value, ...['sha1', 'sha256', 'md5'].flatMap((alg) => [createHash(alg).update(value).digest('hex'), createHash(alg).update(value).digest('base64')])];

function terminal(answers) {
  const input = new PassThrough();
  let reads = 0;
  Object.assign(input, {
    isTTY: true,
    setRawMode(on) {
      if (on) {
        const next = answers[reads++];
        setImmediate(() => input.write(`${next}\r`));
      }
      return input;
    },
  });
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => (text += c));
  return { input, output, text: () => text };
}

describe.skipIf(!claudeBin || !codexBin)('pending requests and answers through the actual app (Task 9)', () => {
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
    return { status: response.status, data: result?.data, error: result?.error, nextCursor: result?.nextCursor };
  }
  const query = async (text, params) => (await db.getPool().query(text, params)).rows;
  const pendingOf = async (sessionId) => (await request('GET', `/sessions/${sessionId}/pending-requests`)).data ?? [];
  const answer = (sessionId, r, response) => request('POST', `/sessions/${sessionId}/commands`, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: r.generation, response }, randomUUID());
  const ledgerRecords = () => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  beforeAll(async () => {
    await assertNetworkIsolation();
    db = await import('@fluent-flow/db');
    const { createApp } = await import('../../../fluent-flow/src/app.js');
    await db.runMigrations();
    const suffix = randomUUID();
    const legacy = await db.getPool().query('INSERT INTO users(github_id,login,email,is_superadmin) VALUES($1,$2,$3,true) RETURNING id', [Math.floor(Math.random() * 1e9), `answers-${suffix}`, `${suffix}@example.test`]);
    const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy.rows[0].id, displayName: 'Answers owner', email: `${suffix}@example.test` });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const orgId = `answers-${suffix}`;
    await db.getPool().query('INSERT INTO orgs(id,name) VALUES($1,$1)', [orgId]);
    const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Answers fixture', idempotencyKey: suffix });
    project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native answers' });
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
        { tool: 'AskUserQuestion', input: { questions: CLAUDE_QUESTIONS } },
        { text: (body) => (JSON.stringify(body).includes(CLAUDE_NOTE) && JSON.stringify(body).includes('Blue') ? `Noted: Blue and ${CLAUDE_NOTE}` : 'no host answer seen') },
      ],
      modelScripts: {
        [CLAUDE_SEQ_MODEL]: [
          { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which colors do you like?', header: 'Colors', multiSelect: true, options: SEQ_OPTIONS }] } },
          { tool: 'AskUserQuestion', input: { questions: [{ question: 'Pick one for the logo', header: 'Logo', multiSelect: false, options: SEQ_OPTIONS }] } },
          { text: (body) => `Second answer: ${JSON.stringify(body.messages?.at(-1)).includes('Green') ? 'Green' : 'unknown'}` },
        ],
        [CLAUDE_WEB_MODEL]: [
          { tool: 'AskUserQuestion', input: { questions: CLAUDE_QUESTIONS } },
          { text: (body) => (JSON.stringify(body).includes(CLAUDE_WEB_NOTE) && JSON.stringify(body).includes('Red') ? `Web answer received: Red and ${CLAUDE_WEB_NOTE}` : 'no web answer seen') },
        ],
      },
    });
    openai = await startOpenAiFixture({
      mainModel: CODEX_SECRET_MODEL,
      script: [
        { tool: 'mcp__ff_questions.ask', input: { questions: [SECRET_Q] } },
        { text: (body) => (JSON.stringify(body).includes(SECRET) ? `The token you gave is ${SECRET}.` : 'no host answer seen') },
      ],
      modelScripts: {
        [CODEX_WAIT_MODEL]: [{ tool: 'mcp__ff_questions.ask', input: { questions: [WAIT_Q] } }, { text: 'declined, continuing' }],
      },
    });
    const host = await db.createExecutionHost({ actor, name: 'Answers fixture PC' });
    const tokenFile = join(root, 'host-token');
    writeFileSync(tokenFile, `${host.token}\n`, { mode: 0o600 });
    configFile = join(root, 'connector.json');
    const codexProfile = (id, model) => ({ id, name: id, backend: 'codex', executable: codexBin.executable, contextDir: codexContext, model, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false } });
    writeFileSync(configFile, JSON.stringify({
      serverUrl: base, tokenFile, instanceId: INSTANCE, repositories: { repo: ctx.repoDir },
      capacity: { 'claude-code': 8, codex: 8 },
      profiles: [
        { id: 'cc-ask', name: 'Claude ask', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: CLAUDE_MODEL, policy: { permissionMode: 'manual' } },
        { id: 'cc-seq', name: 'Claude sequential', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: CLAUDE_SEQ_MODEL, policy: { permissionMode: 'manual' } },
        { id: 'cc-web', name: 'Claude web', backend: 'claude-code', executable: claudeBin.executable, contextDir: ctx.contextDir, model: CLAUDE_WEB_MODEL, policy: { permissionMode: 'manual' } },
        codexProfile('cx-secret', CODEX_SECRET_MODEL),
        codexProfile('cx-wait', CODEX_WAIT_MODEL),
      ],
    }));
    stateDir = join(root, `connector-${INSTANCE}`);
    mkdirSync(stateDir, { mode: 0o700 });
    supervisor = await startTestSupervisor({ stateDir, instanceId: INSTANCE, configFile, fixtures: { anthropicUrl: anthropic.url, openaiUrl: openai.url, parentEnv: ctx.parentEnv, spawnEnvExtras: probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }) } });
    client = await connectSupervisor({ instanceId: INSTANCE, stateDir, role: 'connector' });
    runtime = await createConnectorRuntime({ config: loadConnectorConfig({ file: configFile }), journalDir: stateDir, supervisor: client, intervals: { pollWaitMs: 0, baseBackoffMs: 10, maxBackoffMs: 50 }, log: (l) => logs.push(l) });
    await runtime.loop.register();
    mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'repo', profileIds: ['cc-ask', 'cc-seq', 'cc-web', 'cx-secret', 'cx-wait'], defaultProfileId: 'cc-ask' });
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

  async function startOverHttp(profileId) {
    const task = await request('POST', `/projects/${project.id}/tasks`, { title: `Answers ${profileId} task` });
    expect(task.status).toBe(201);
    const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId }, randomUUID());
    expect(started.status, JSON.stringify(started.error)).toBe(202);
    const runId = started.data.run.id;
    const [{ id: sessionId }] = await query('SELECT id FROM collab_sessions WHERE run_id=$1', [runId]);
    return { taskId: task.data.id, runId, sessionId };
  }

  async function approveAskCall(sessionId) {
    const approval = await until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'permission'), 120_000, 'ff_questions call approval');
    expect(approval).toMatchObject({ backend: 'codex', generation: 1, hostOnly: false });
    const accept = approval.choices.find((c) => c.id === 'accept');
    expect(accept).toEqual({ id: 'accept', label: 'Allow once', scope: 'once', behavior: 'allow' });
    expect((await answer(sessionId, approval, { behavior: 'allow', selectedActionId: 'accept' })).status).toBe(202);
    return until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'question'), 60_000, 'pending ff_questions question');
  }

  it('Codex ff_questions secret request: browser allow is 409 answer_on_host, a local answer reaches the tool, the model\'s echo is spooled as [redacted], and commands, observations, task events and audit hold no answer bytes', async () => {
    const { runId, sessionId, taskId } = await startOverHttp('cx-secret');
    const question = await approveAskCall(sessionId);
    expect(question).toMatchObject({ kind: 'question', backend: 'codex', generation: 1, hostOnly: true, questions: [{ id: 'token', question: 'Paste the deploy token', secret: true, options: null, allowOther: true }] });
    const commandsBefore = (await query('SELECT count(*)::int AS n FROM collab_connector_commands WHERE session_id=$1', [sessionId]))[0].n;
    const browser = await answer(sessionId, question, { behavior: 'allow', selections: { token: { selected: [], other: 'browser-typed-value' } } });
    expect(browser).toMatchObject({ status: 409, error: { code: 'answer_on_host', message: 'Answer this request on the execution host.' } });
    expect((await query('SELECT count(*)::int AS n FROM collab_connector_commands WHERE session_id=$1', [sessionId]))[0].n).toBe(commandsBefore);
    const tty = terminal([SECRET]);
    expect(await runLocalAnswer({ configFile, requestId: question.requestId, input: tty.input, output: tty.output })).toBe(0);
    expect(tty.text().indexOf(LOCAL_ANSWER_WARNING)).toBeGreaterThanOrEqual(0);
    expect(tty.text().indexOf(LOCAL_ANSWER_WARNING)).toBeLessThan(tty.text().indexOf('Answer: '));
    expect(tty.text()).not.toContain(SECRET);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'codex secret session idle');
    const followUp = openai.requestsFor(CODEX_SECRET_MODEL)[1];
    expect(JSON.stringify(followUp.body)).toContain(SECRET);
    const events = ledgerRecords().filter((r) => r.type === 'event' && r.sessionId === sessionId);
    expect(JSON.stringify(events)).toContain('The token you gave is [local answer].');
    expect(events.some((r) => r.payload.event?.item?.server === 'ff_questions' && r.payload.event.item.resultWithheld === 'ff_question_answer')).toBe(true);
    expect(events.some((r) => r.payload.event?.resolvedBy === 'host' && r.payload.event.nativeRequestId)).toBe(true);
    expect(await pendingOf(sessionId)).toEqual([]);
    const history = await request('GET', `/sessions/${sessionId}/timeline?limit=200`);
    expect(JSON.stringify(history.data)).toContain('[local answer]');
    const needles = needlesOf(SECRET);
    const rows = JSON.stringify([
      await query('SELECT payload, result FROM collab_connector_commands WHERE run_id=$1', [runId]),
      await query('SELECT payload FROM collab_connector_observations WHERE run_id=$1', [runId]),
      await query('SELECT payload FROM collab_task_events WHERE task_id=$1', [taskId]),
      await query('SELECT * FROM audit_log'),
      await query('SELECT * FROM collab_idempotency_records'),
      history.data,
    ]);
    for (const needle of needles) expect(rows.includes(needle), 'database rows or HTTP history hold the answer or a digest of it').toBe(false);
    for (const file of filesUnder(stateDir)) {
      const bytes = readFileSync(file);
      for (const needle of needles) expect(bytes.includes(needle), `${file} holds the answer or a digest of it`).toBe(false);
    }
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(openai.unexpected).toEqual([]);
    expect(proxy.attempts).toEqual([]);
  }, 240_000);

  it('a Claude question can be answered locally', async () => {
    const { sessionId } = await startOverHttp('cc-ask');
    const question = await until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'question'), 120_000, 'claude question');
    expect(question).toMatchObject({ backend: 'claude-code', generation: 1, hostOnly: false, questions: [{ id: 'q0', header: 'Color', question: 'Which color do you want?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], allowOther: true, secret: false }] });
    const tty = terminal(['2', CLAUDE_NOTE]);
    expect(await runLocalAnswer({ configFile, input: tty.input, output: tty.output })).toBe(0);
    expect(tty.text()).not.toContain(CLAUDE_NOTE);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'claude session idle');
    const followUp = anthropic.requestsFor(CLAUDE_MODEL)[1];
    expect(JSON.stringify(followUp.body)).toContain('Blue');
    expect(JSON.stringify(followUp.body)).toContain(CLAUDE_NOTE);
    const events = ledgerRecords().filter((r) => r.type === 'event' && r.sessionId === sessionId);
    expect(JSON.stringify(events)).toContain('Noted: [local answer] and [local answer]');
    expect(JSON.stringify(events)).not.toContain(CLAUDE_NOTE);
    expect(events.some((r) => r.payload.event?.resolvedBy === 'host')).toBe(true);
    expect(await pendingOf(sessionId)).toEqual([]);
    const again = terminal(['1', 'x']);
    expect(await runLocalAnswer({ configFile, requestId: question.requestId, input: again.input, output: again.output })).toBe(1);
    expect(again.text()).toContain('This request is no longer available. Refresh the session.');
    expect(anthropic.unexpected).toEqual([]);
  }, 240_000);

  it('an ordinary Claude question can be answered in the browser (concern evidence: actual web positive)', async () => {
    const { runId, sessionId } = await startOverHttp('cc-web');
    const question = await until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'question'), 120_000, 'claude web question');
    expect(question).toMatchObject({ backend: 'claude-code', generation: 1, hostOnly: false });
    const selections = { q0: { optionIds: ['o0'], other: CLAUDE_WEB_NOTE } };
    const answered = await answer(sessionId, question, { behavior: 'allow', selections });
    expect(answered.status, JSON.stringify(answered.error)).toBe(202);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'claude web session idle');
    expect(JSON.stringify(anthropic.requestsFor(CLAUDE_WEB_MODEL)[1].body)).toContain(CLAUDE_WEB_NOTE);
    const [command] = await query("SELECT payload, state FROM collab_connector_commands WHERE run_id=$1 AND kind='permission'", [runId]);
    expect(command).toMatchObject({ state: 'applied', payload: { requestId: question.requestId, generation: 1, fingerprint: question.fingerprint, response: { behavior: 'allow', selections } } });
    const history = await request('GET', `/sessions/${sessionId}/timeline?limit=200`);
    expect(JSON.stringify(history.data)).toContain(`Web answer received: Red and ${CLAUDE_WEB_NOTE}`);
    const events = ledgerRecords().filter((r) => r.type === 'event' && r.sessionId === sessionId);
    expect(events.some((r) => r.payload.event?.resolvedBy === 'host')).toBe(false);
    expect(await pendingOf(sessionId)).toEqual([]);
    expect(anthropic.unexpected).toEqual([]);
  }, 240_000);

  it('fix 1 I2: a later ordinary question offering earlier local answers is answered from the web by option id', async () => {
    const { runId, sessionId } = await startOverHttp('cc-seq');
    const first = await until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'question'), 120_000, 'first claude question');
    const tty = terminal(['1,2', '']);
    expect(await runLocalAnswer({ configFile, requestId: first.requestId, input: tty.input, output: tty.output })).toBe(0);
    const second = await until(async () => (await pendingOf(sessionId)).find((r) => r.kind === 'question' && r.requestId !== first.requestId), 120_000, 'second claude question');
    expect(second.questions[0].options).toEqual([
      { id: 'o0', label: '[local answer]', description: 'b' },
      { id: 'o1', label: '[local answer]', description: 'g' },
      { id: 'o2', label: 'Red', description: 'r' },
    ]);
    expect(second.hostOnly).toBe(false);
    const answered = await answer(sessionId, second, { behavior: 'allow', selections: { q0: { optionIds: ['o1'] } } });
    expect(answered.status, JSON.stringify(answered.error)).toBe(202);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'claude sequential session idle');
    const toolResult = JSON.stringify(anthropic.requestsFor(CLAUDE_SEQ_MODEL)[2].body.messages.at(-1));
    expect(toolResult).toContain('Green');
    expect(toolResult).not.toContain('Blue');
    const [command] = await query("SELECT payload FROM collab_connector_commands WHERE run_id=$1 AND kind='permission'", [runId]);
    expect(command.payload.response).toEqual({ behavior: 'allow', selections: { q0: { optionIds: ['o1'] } } });
    const events = ledgerRecords().filter((r) => r.type === 'event' && r.sessionId === sessionId);
    const registeredAt = events.find((r) => r.payload.event?.resolvedBy === 'host').seq;
    const later = events.filter((r) => r.seq > registeredAt);
    expect(later.length).toBeGreaterThan(0);
    expect(JSON.stringify(later)).not.toMatch(/Blue|Green/);
    const observed = await query("SELECT payload FROM collab_connector_observations WHERE session_id=$1 AND (payload->'source'->>'seq')::int > $2", [sessionId, registeredAt]);
    expect(JSON.stringify(observed)).not.toMatch(/Blue|Green/);
    expect(JSON.stringify(later)).toContain('Second answer: [local answer]');
    expect(JSON.stringify(events.filter((r) => r.seq < registeredAt))).toContain('Green');
    expect(await pendingOf(sessionId)).toEqual([]);
    expect(anthropic.unexpected).toEqual([]);
  }, 240_000);

  it('an unanswered question gets no FF response for 15 s', async () => {
    const { sessionId } = await startOverHttp('cx-wait');
    const question = await approveAskCall(sessionId);
    const respondBarriersBefore = ledgerRecords().filter((r) => r.type === 'barrier' && r.effect === 'respond').length;
    const requestsBefore = openai.requestsFor(CODEX_WAIT_MODEL).length;
    await new Promise((r) => setTimeout(r, 15_000));
    expect(ledgerRecords().filter((r) => r.type === 'barrier' && r.effect === 'respond')).toHaveLength(respondBarriersBefore);
    const records = ledgerRecords().filter((r) => r.type === 'event' && r.sessionId === sessionId && r.payload.event?.nativeRequestId);
    expect(records.map((r) => r.payload.event.record).filter(Boolean)).toEqual(['question_pending']);
    expect(openai.requestsFor(CODEX_WAIT_MODEL)).toHaveLength(requestsBefore);
    expect((await pendingOf(sessionId)).map((r) => r.requestId)).toContain(question.requestId);
    expect((await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state).not.toBe('idle');
    const decline = question.choices.find((c) => c.behavior === 'deny');
    expect((await answer(sessionId, question, { behavior: 'deny', selectedActionId: decline.id })).status).toBe(202);
    await until(async () => (await query('SELECT state FROM collab_sessions WHERE id=$1', [sessionId]))[0].state === 'idle', 120_000, 'codex wait session idle');
    expect(JSON.stringify(openai.requestsFor(CODEX_WAIT_MODEL).at(-1).body)).toContain('declined');
    expect(await pendingOf(sessionId)).toEqual([]);
    expect(openai.unexpected).toEqual([]);
  }, 240_000);
});
