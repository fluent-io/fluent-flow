
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createCodexBackend } from '../../src/native/codex-backend.js';
import { chatgptSubscriptionAuth } from '../../src/native/codex-auth.js';
import { readProcessDetails } from '../../src/supervisor/process-identity.js';
import { createLedger } from '../../src/supervisor/ledger.js';
import { createCommandBarrier } from '../../src/supervisor/backend-contract.js';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startMcpFixture, MCP_TOOL } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { syntheticCodexAuth } from './harness/synthetic-auth.js';

const MODEL = 'ff-probe-model';
const MCP_TOKEN = 'ff-codex-backend-dummy-mcp-token';
const binary = requireNativeBinary('codex');
const suite = binary ? describe : describe.skip;

const ORDINARY = { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: null }] };
const SECRET = { id: 'token', header: 'Token', question: 'Paste the token', options: null, secret: true };
const SECRET_ANSWER = 'FF-T6-SECRET-ANSWER-8812';

suite('codex backend (native)', () => {
  /** @type {Awaited<ReturnType<typeof createProbeContext>>} */
  let ctx;
  let mcp;
  let proxy;
  const contexts = [];
  const fixtures = [];
  const workers = new Set();
  const children = new Set();
  let worktreeSeq = 0;

  beforeAll(async () => {
    await assertNetworkIsolation();
    ctx = await createProbeContext('codex');
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    proxy = await startDenyProxy();
  });

  afterAll(async () => {
    for (const w of workers) await w.close({ reason: 'test_cleanup' }).catch(() => {
    });
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    for (const fx of fixtures) await fx.close();
    await mcp?.close();
    await proxy?.close();
    for (const c of contexts) await c.cleanup();
    await ctx?.cleanup();
  });

  async function fixture(script) {
    const fx = await startOpenAiFixture({ script, mainModel: MODEL });
    fixtures.push(fx);
    return fx;
  }

  function worktree(c = ctx) {
    const dir = join(c.root, `wt-${++worktreeSeq}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', `ff-t6-${worktreeSeq}`, dir], { cwd: c.repoDir, env: { PATH: process.env.PATH ?? '', HOME: c.home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
    return realpathSync(dir);
  }

  const profile = (c = ctx, approvalPolicy = 'on-request') => ({
    id: 'codex-test',
    name: 'Codex test',
    backend: 'codex',
    executable: binary.executable,
    contextDir: c.contextDir,
    model: MODEL,
    policy: { approvalPolicy, sandbox: 'workspace-write', networkAccess: false },
    complete: true,
  });

  function testSpawn(spawned, { transform, env: envPatch, c = ctx } = {}) {
    return async ({ executable, args, env, cwd }) => {
      const entry = { args, env, cwd, writes: [], raw: [], child: null, inject: null, stopped: 0 };
      spawned.push(entry);
      const childEnv = { ...env, ...probeSpawnExtras({ home: c.home, proxyUrl: proxy.url }), ...(envPatch ?? {}) };
      const child = spawn(executable, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      entry.child = child;
      const real = child.stdout;
      const out = new PassThrough();
      let chain = Promise.resolve();
      const forward = (produce) => {
        chain = chain.then(async () => {
          const msg = await produce();
          if (msg !== null && msg !== undefined && !out.destroyed) out.write(`${JSON.stringify(msg)}\n`);
        });
      };
      let tail = '';
      real.on('data', (d) => {
        const lines = (tail + d).split('\n');
        tail = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line);
          entry.raw.push(msg);
          forward(() => (transform ? transform(msg, entry) : msg));
        }
      });
      real.on('end', () => {
        chain = chain.then(() => out.end());
      });
      entry.inject = (msg) => forward(() => msg);
      Object.defineProperty(child, 'stdout', { value: out, configurable: true });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        entry.writes.push(...String(chunk).split('\n').filter(Boolean).map((line) => JSON.parse(line)));
        return write(chunk, ...rest);
      };
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const details = await readProcessDetails(child.pid);
      return { child, identity: { ...details, pgid: details.pgid ?? child.pid } };
    };
  }

  function ownedStop(spawned, stops, result = 'quiesced') {
    return async ({ reason }) => {
      stops.push(reason);
      const child = spawned.at(-1)?.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGKILL');
        await exited;
      }
      return result;
    };
  }

  function recordingEffects(order) {
    return {
      async barrier(effect, ref) {
        order.push({ step: 'barrier', effect, ref });
      },
      async bind(nativeSessionId) {
        order.push({ step: 'bind', nativeSessionId });
      },
    };
  }

  function log() {
    const lines = [];
    const write = (level) => (obj) => lines.push({ level, ...obj });
    return { lines, info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
  }

  function collect(worker) {
    const events = [];
    (async () => {
      for await (const e of worker.events) events.push(e);
    })().catch(() => {
    });
    return events;
  }

  async function until(pred, timeoutMs = 30_000) {
    const start = Date.now();
    for (;;) {
      const hit = pred();
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function openWorker({ fx, auth, c = ctx, dir, resume = null, reportingUrl, order = [], spawned = [], transform, env, generation = 1, effects, stopOwned, stops = [], approvalPolicy, backendLog = log() }) {
    const workspaceDir = dir ?? worktree(c);
    const backend = createCodexBackend({ log: backendLog, auth: auth ?? syntheticCodexAuth({ fixture: fx }), parentEnv: c.parentEnv });
    const worker = await backend.open({
      sessionId: randomUUID(),
      runId: randomUUID(),
      profile: profile(c, approvalPolicy),
      workspaceDir,
      reporting: { url: reportingUrl ?? mcp.url, credential: MCP_TOKEN },
      resume,
      generation,
      spawn: testSpawn(spawned, { transform, env, c }),
      effects: effects ?? recordingEffects(order),
      stopOwned: stopOwned ?? ownedStop(spawned, stops),
    });
    workers.add(worker);
    return { worker, order, spawned, stops, workspaceDir, events: collect(worker), logLines: backendLog.lines };
  }

  const need = (value, label) => {
    expect(value, label).toBeTruthy();
    return value;
  };
  const sp = (list, i = 0) => need(list[i], 'spawned native');
  const methods = (entry, ...names) => need(entry, 'spawned native').writes.filter((w) => names.includes(w.method));
  const terminalOf = (events) => events.find((e) => e.terminal);
  const errorCode = (promise) => promise.then(() => null, (err) => err.code ?? String(err));
  const noBarrier = (calls) => async (ref) => {
    calls.push(ref);
  };
  const pendingOf = (worker, kind) => worker.pending().find((r) => r.kind === kind);
  const accept = (worker, request, barrier = async () => {}) =>
    worker.respond({ commandId: randomUUID(), nativeRequestId: request.nativeRequestId, response: { fingerprint: request.fingerprint, selectedActionId: 'accept', behavior: 'allow' }, source: 'web', barrier });
  const askCall = (questions) => ({ tool: 'mcp__ff_questions.ask', input: { questions } });

  it('the thread id is bound before turn/start', async () => {
    const fx = await fixture([{ text: 'hello' }]);
    const order = [];
    const spawned = [];
    const { worker, events, workspaceDir } = await openWorker({ fx, order, spawned });
    const threadStart = methods(sp(spawned), 'thread/start');
    expect(threadStart).toHaveLength(1);
    expect(order).toEqual([
      { step: 'barrier', effect: 'create_native_session', ref: {} },
      { step: 'bind', nativeSessionId: worker.nativeSessionId },
    ]);
    expect(sp(spawned).cwd).toBe(workspaceDir);
    const commandId = randomUUID();
    const sendOrder = [];
    const sent = await worker.send({ commandId, text: 'hi', mode: 'start', barrier: async (ref) => sendOrder.push({ ref, turnStarts: methods(sp(spawned), 'turn/start').length }) });
    expect(sendOrder).toEqual([{ ref: { clientUserMessageId: commandId }, turnStarts: 0 }]);
    expect(sent.receipt).toMatchObject({ commandId, dispatched: true });
    const [turnStart] = methods(sp(spawned), 'turn/start');
    expect(turnStart.params).toMatchObject({ threadId: worker.nativeSessionId, clientUserMessageId: commandId });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    const receipt = events.find((e) => e.receiptFor === commandId);
    expect(receipt?.payload.item.type).toBe('userMessage');
    expect(fx.requests).toHaveLength(1);
  });

  it('a dropped thread/start response binds one unambiguous owned thread or stays reconciling, with no second thread/start', async () => {
    const fx = await fixture([]);
    const responseTo = (entry, method) => (msg) => msg.id !== undefined && msg.method === undefined && methods(entry, method).some((w) => w.id === msg.id);
    const run = async (extra) => {
      const order = [];
      const spawned = [];
      const lose = (msg, entry) => {
        if (responseTo(entry, 'thread/start')(msg)) {
          entry.dropped = msg.result.thread;
          return null;
        }
        return extra ? extra(msg, entry) : msg;
      };
      const opened = openWorker({ fx, order, spawned, transform: lose });
      const code = await errorCode(opened.then((o) => o));
      const entry = sp(spawned);
      expect(methods(entry, 'thread/start'), 'one thread/start only').toHaveLength(1);
      return { code, order, entry, opened };
    };

    const real = await run(null);
    expect(real.code).toBe('reconciling');
    const threadId = real.entry.dropped.id;
    expect(real.order).toEqual([
      { step: 'barrier', effect: 'create_native_session', ref: {} },
      { step: 'bind', nativeSessionId: threadId },
    ]);
    const calls = real.entry.writes.filter((w) => w.method).map((w) => w.method);
    expect(calls.indexOf('thread/loaded/list')).toBeLessThan(calls.indexOf('thread/start'));
    expect(calls.lastIndexOf('thread/loaded/list')).toBeGreaterThan(calls.indexOf('thread/start'));
    expect(methods(real.entry, 'thread/read').map((w) => w.params)).toEqual([{ threadId }]);
    expect(calls.lastIndexOf('config/read')).toBeGreaterThan(calls.indexOf('thread/read'));
    expect(calls.lastIndexOf('config/read')).toBeLessThan(calls.indexOf('thread/resume'));
    expect(methods(real.entry, 'thread/resume').map((w) => w.params)).toEqual([{ threadId }]);
    const rejoinId = methods(real.entry, 'thread/resume')[0].id;
    expect(real.entry.raw.find((m) => m.id === rejoinId && m.method === undefined)?.error?.message ?? '').toMatch(/no rollout found/);
    expect(methods(real.entry, 'thread/list', 'turn/start')).toEqual([]);
    expect(real.entry.child.exitCode !== null || real.entry.child.signalCode !== null).toBe(true);
    expect(fx.requests).toHaveLength(0);

    const ghost = randomUUID();
    const withGhost = (msg, entry) => {
      const lists = methods(entry, 'thread/loaded/list');
      if (lists.length > 1 && msg.id === lists.at(-1).id && msg.method === undefined) return { ...msg, result: { ...msg.result, data: [...msg.result.data, ghost] } };
      return msg;
    };
    const ambiguous = await run(withGhost);
    expect(ambiguous.code).toBe('reconciling');
    expect(ambiguous.order).toEqual([{ step: 'barrier', effect: 'create_native_session', ref: {} }]);
    expect(methods(ambiguous.entry, 'thread/resume')).toEqual([]);
    expect(fx.requests).toHaveLength(0);
  }, 240_000);

  it('a refused config gate sends no thread/start or thread/resume and fails startup_failed', async () => {
    const c = await createProbeContext('codex');
    contexts.push(c);
    const dir = worktree(c);
    writeFileSync(join(c.contextDir, 'config.toml'), `[projects."${dir}"]\ntrust_level = "trusted"\n`);
    const fx = await fixture([]);
    for (const resume of [null, { nativeSessionId: '01a1a98b-bcf4-7442-a439-94bbbbc8de0a' }]) {
      const order = [];
      const spawned = [];
      const backendLog = log();
      const code = await errorCode(openWorker({ fx, c, dir, resume, order, spawned, backendLog }));
      expect(code, JSON.stringify(resume)).toBe('startup_failed');
      expect(methods(sp(spawned), 'thread/start', 'thread/resume', 'turn/start')).toEqual([]);
      expect(methods(sp(spawned), 'config/read')[0]?.params).toEqual({ cwd: dir, includeLayers: true });
      expect(order).toEqual([]);
      expect(backendLog.lines.map((l) => l.reason)).toContain('project_layer_enabled');
      expect(sp(spawned).child.exitCode !== null || sp(spawned).child.signalCode !== null).toBe(true);
    }
    expect(fx.requests).toHaveLength(0);
  });

  it('thread/start, thread/resume and turn/start never carry cwd', async () => {
    const fx = await fixture([{ hold: true }, { text: 'two' }]);
    const spawned = [];
    const { worker, events, workspaceDir } = await openWorker({ fx, spawned });
    await worker.send({ commandId: randomUUID(), text: 'one', mode: 'start', barrier: async () => {} });
    await until(() => fx.requests.length === 1);
    await worker.send({ commandId: randomUUID(), text: 'steer', mode: 'steer', barrier: async () => {} });
    fx.release(0);
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    const threadId = worker.nativeSessionId;
    await worker.close({ reason: 'test' });
    const resumed = await openWorker({ fx, dir: workspaceDir, resume: { nativeSessionId: threadId }, spawned });
    expect(resumed.worker.nativeSessionId).toBe(threadId);
    const all = spawned.flatMap((s) => methods(s, 'thread/start', 'thread/resume', 'turn/start', 'turn/steer'));
    expect(all.map((w) => w.method).sort()).toEqual(['thread/resume', 'thread/start', 'turn/start', 'turn/steer']);
    for (const w of all) expect(Object.keys(w.params), w.method).not.toContain('cwd');
    expect(methods(sp(spawned, 1), 'thread/resume')[0].params).toEqual({ threadId });
    expect(spawned.map((s) => s.cwd)).toEqual([workspaceDir, workspaceDir]);
  });

  it('an unreachable reporting MCP refuses the first prompt with startup_failed, and a refused question MCP leaves the create reconciling', async () => {
    const fx = await fixture([{ text: 'never' }]);
    const spawned = [];
    const { worker } = await openWorker({ fx, spawned, reportingUrl: 'http://127.0.0.1:9/mcp' });
    const calls = [];
    expect(await errorCode(worker.send({ commandId: randomUUID(), text: 'hi', mode: 'start', barrier: noBarrier(calls) }))).toBe('startup_failed');
    expect(calls).toEqual([]);
    expect(methods(sp(spawned), 'turn/start')).toEqual([]);

    const spawned2 = [];
    const order2 = [];
    const code = await errorCode(openWorker({ fx, spawned: spawned2, order: order2, env: { FF_QUESTIONS_TOKEN: 'ff-wrong-questions-token' } }));
    expect(code).toBe('reconciling');
    expect(methods(sp(spawned2), 'thread/start')).toHaveLength(1);
    expect(methods(sp(spawned2), 'turn/start')).toEqual([]);
    expect(order2).toEqual([{ step: 'barrier', effect: 'create_native_session', ref: {} }]);
    expect(fx.requests).toHaveLength(0);
  });

  it('flag-like text is delivered verbatim', async () => {
    const text = '--model gpt-x -c approval_policy="never" --dangerously-bypass-approvals-and-sandbox\n-- `$(touch /tmp/x)` \u0000? "quoted" \\n';
    const fx = await fixture([{ text: 'ok' }]);
    const spawned = [];
    const { worker, events } = await openWorker({ fx, spawned });
    const argsBefore = [...sp(spawned).args];
    await worker.send({ commandId: randomUUID(), text, mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    expect(methods(sp(spawned), 'turn/start')[0].params.input).toEqual([{ type: 'text', text, text_elements: [] }]);
    const user = (fx.requests[0].body.input ?? []).filter((i) => i.role === 'user').flatMap((i) => i.content ?? []).map((c) => c.text);
    expect(user).toContain(text);
    expect(sp(spawned).args).toEqual(argsBefore);
  });

  it('a decision that was not offered, decline included, is refused before any write, and decline differs from cancel', async () => {
    const fx = await fixture([{ tool: 'exec_command', input: { cmd: 'touch t6-marker', sandbox_permissions: 'require_escalated', justification: 'probe' } }, { text: 'ok' }]);
    const spawned = [];
    const { worker, events, workspaceDir } = await openWorker({ fx, spawned });
    await worker.send({ commandId: randomUUID(), text: 'run it', mode: 'start', barrier: async () => {} });
    const request = need(await until(() => pendingOf(worker, 'permission')), 'pending permission');
    expect(request.choices.map((c) => [c.id.split(':')[0], c.label, c.behavior])).toEqual([
      ['accept', 'Allow once', 'allow'],
      ['acceptWithExecpolicyAmendment', "Allow and don't ask again for similar commands", 'allow'],
      ['cancel', 'Deny and stop this turn', 'deny'],
    ]);
    const rpcId = need(sp(spawned).raw.find((m) => m.method === 'item/commandExecution/requestApproval'), 'approval request').id;
    const answered = () => sp(spawned).writes.filter((w) => w.id === rpcId && w.method === undefined);
    const calls = [];
    const attempt = (selectedActionId, behavior) =>
      worker.respond({ commandId: randomUUID(), nativeRequestId: request.nativeRequestId, response: { fingerprint: request.fingerprint, selectedActionId, behavior }, source: 'web', barrier: noBarrier(calls) });
    expect(await attempt('decline', 'deny')).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await attempt('accept', 'deny')).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await worker.respond({ commandId: randomUUID(), nativeRequestId: request.nativeRequestId, response: { fingerprint: '0'.repeat(64), selectedActionId: 'cancel', behavior: 'deny' }, source: 'web', barrier: noBarrier(calls) })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(calls).toEqual([]);
    expect(answered()).toEqual([]);
    expect(await attempt('cancel', 'deny')).toEqual({ state: 'dispatched' });
    expect(calls).toEqual([{ nativeRequestId: request.nativeRequestId, requestKind: 'permission', fingerprint: request.fingerprint, source: 'web', operation: 'decline' }]);
    expect(answered().map((w) => w.result)).toEqual([{ decision: 'cancel' }]);
    expect((await until(() => terminalOf(events)))?.terminal).toBe('interrupted');
    expect(existsSync(join(workspaceDir, 't6-marker'))).toBe(false);
    const resolved = need(await until(() => events.find((e) => e.kind === 'attention' && e.payload.nativeRequestId === request.nativeRequestId && e.payload.state === 'resolved')), 'resolved attention');
    expect(resolved.payload.resolvedBy).toBe('ff');

    const fx2 = await fixture([{ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status: 't6' } }, { text: 'ok' }]);
    const second = await openWorker({ fx: fx2 });
    const before = mcp.calls.filter((x) => x.method === 'tools/call').length;
    await second.worker.send({ commandId: randomUUID(), text: 'report', mode: 'start', barrier: async () => {} });
    const mcpRequest = need(await until(() => pendingOf(second.worker, 'permission')), 'pending permission');
    expect(mcpRequest.choices.map((c) => [c.id, c.label, c.behavior])).toEqual([
      ['accept', 'Allow once', 'allow'],
      ['acceptForSession', 'Allow for this session', 'allow'],
      ['acceptAlways', "Allow and don't ask again in this session", 'allow'],
      ['decline', 'Deny and continue', 'deny'],
      ['cancel', 'Deny', 'deny'],
    ]);
    expect(await second.worker.respond({ commandId: randomUUID(), nativeRequestId: mcpRequest.nativeRequestId, response: { fingerprint: mcpRequest.fingerprint, selectedActionId: 'decline', behavior: 'deny' }, source: 'web', barrier: async () => {} })).toEqual({ state: 'dispatched' });
    expect((await until(() => terminalOf(second.events)))?.terminal).toBe('completed');
    expect(mcp.calls.filter((x) => x.method === 'tools/call').length).toBe(before);
  });

  it('an advertised session remember choice suppresses only the next equivalent approval within that session', async () => {
    const report = (status) => ({ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status } });
    const before = mcp.calls.filter((x) => x.method === 'tools/call').length;
    for (const choice of ['acceptForSession', 'acceptAlways']) {
      const fx = await fixture([report(`${choice}-1`), report(`${choice}-2`), { text: 'ok' }]);
      const configBefore = existsSync(join(ctx.contextDir, 'config.toml')) ? readFileSync(join(ctx.contextDir, 'config.toml'), 'utf8') : null;
      const { worker, events } = await openWorker({ fx });
      await worker.send({ commandId: randomUUID(), text: 'report twice', mode: 'start', barrier: async () => {} });
      const request = need(await until(() => pendingOf(worker, 'permission')), 'first approval');
      const offered = request.choices.find((c) => c.id === choice);
      expect(offered, choice).toBeTruthy();
      expect(await worker.respond({ commandId: randomUUID(), nativeRequestId: request.nativeRequestId, response: { fingerprint: request.fingerprint, selectedActionId: choice, behavior: 'allow' }, source: 'web', barrier: async () => {} })).toEqual({ state: 'dispatched' });
      expect((await until(() => terminalOf(events), 60_000))?.terminal, choice).toBe('completed');
      const asked = events.filter((e) => e.kind === 'attention' && e.payload.kind === 'permission' && e.payload.state === 'pending');
      expect(asked, `${choice}: second equivalent call not asked`).toHaveLength(1);
      expect(existsSync(join(ctx.contextDir, 'config.toml')) ? readFileSync(join(ctx.contextDir, 'config.toml'), 'utf8') : null, choice).toBe(configBefore);
      const fx2 = await fixture([report(`${choice}-3`), { text: 'ok' }]);
      const next = await openWorker({ fx: fx2 });
      await next.worker.send({ commandId: randomUUID(), text: 'report again', mode: 'start', barrier: async () => {} });
      const again = need(await until(() => pendingOf(next.worker, 'permission')), `${choice}: new session asks`);
      expect(await accept(next.worker, again)).toEqual({ state: 'dispatched' });
      expect((await until(() => terminalOf(next.events), 60_000))?.terminal).toBe('completed');
    }
    expect(mcp.calls.filter((x) => x.method === 'tools/call').length - before).toBe(6);
  });

  it('an ff_questions secret question marks the request secret and host-only', async () => {
    const fx = await fixture([askCall([ORDINARY, SECRET]), { text: 'ok' }]);
    const ledgerDir = join(ctx.root, `ledger-${randomUUID()}`);
    mkdirSync(ledgerDir, { mode: 0o700 });
    const ledger = createLedger({ dir: ledgerDir });
    const { worker, events } = await openWorker({ fx });
    await worker.send({ commandId: randomUUID(), text: 'ask me', mode: 'start', barrier: async () => {} });
    const approval = need(await until(() => pendingOf(worker, 'permission')), 'pending permission');
    expect(approval.detail.serverName).toBe('ff_questions');
    expect(await accept(worker, approval)).toEqual({ state: 'dispatched' });
    const question = need(await until(() => pendingOf(worker, 'question')), 'pending question');
    expect(question).toMatchObject({ kind: 'question', secret: true, hostOnly: true });
    expect(question.nativeRequestId).toMatch(/^[0-9a-f]{32}$/);
    expect(question.questions.map((q) => [q.id, q.secret])).toEqual([['color', false], ['token', true]]);
    const selections = { color: { selected: ['Red'], other: null }, token: { selected: [], other: SECRET_ANSWER } };
    const command = (commandId) => {
      ledger.submit({ commandId, digest: `d-${commandId}`, runId: 'run-t6', sessionId: 'session-t6', backend: 'codex', kind: 'respond' });
      return createCommandBarrier({ ledger, commandId, effect: 'respond', generation: 1 });
    };
    const web = randomUUID();
    expect(await worker.respond({ commandId: web, nativeRequestId: question.nativeRequestId, response: { fingerprint: question.fingerprint, selections }, source: 'web', barrier: command(web) })).toEqual({ state: 'failed', errorCode: 'answer_on_host' });
    expect(ledger.classify(web)).toBe('undispatched');
    const local = randomUUID();
    expect(await worker.respond({ commandId: local, nativeRequestId: question.nativeRequestId, response: { fingerprint: question.fingerprint, selections }, source: 'local', barrier: command(local) })).toEqual({ state: 'dispatched' });
    expect((await until(() => terminalOf(events), 60_000))?.terminal).toBe('completed');
    expect(JSON.stringify(fx.requests[1].body)).toContain(SECRET_ANSWER);
    const barriers = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'barrier');
    expect(barriers).toEqual([expect.objectContaining({ commandId: local, effect: 'respond', generation: 1, ref: { nativeRequestId: question.nativeRequestId, responseId: local, source: 'local', requestKind: 'question', fingerprint: question.fingerprint, operation: 'answer' } })]);
    expect(readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8')).not.toContain(SECRET_ANSWER);
    const spooled = events.filter((e) => e.kind === 'attention' && e.payload.nativeRequestId === question.nativeRequestId);
    expect(spooled.map((e) => e.payload.record ?? e.payload.state)).toEqual(expect.arrayContaining(['pending', 'answer_written', 'resolved']));
    expect(spooled.find((e) => e.payload.state === 'resolved')).toMatchObject({ receiptFor: local, payload: { resolvedBy: 'ff' } });
    expect(JSON.stringify(events.filter((e) => e.kind !== 'timeline'))).not.toContain(SECRET_ANSWER);
  });

  it('an unexpected MCP server startup stops the worker', async () => {
    const fx = await fixture([{ text: 'one' }]);
    const planted = (entry) => entry.inject({ method: 'mcpServer/startupStatus/updated', params: { threadId: null, name: 'ff_planted_extra', status: 'starting', error: null, failureReason: null } });
    const spawned = [];
    const stops = [];
    const { worker, events } = await openWorker({ fx, spawned, stops });
    planted(sp(spawned));
    planted(sp(spawned));
    await until(() => stops.length > 0, 10_000);
    const calls = [];
    expect(await errorCode(worker.send({ commandId: randomUUID(), text: 'hi', mode: 'start', barrier: noBarrier(calls) }))).toBe('startup_failed');
    expect(stops).toEqual(['unexpected_mcp_server']);
    expect(calls).toEqual([]);
    expect(sp(spawned).child.signalCode).toBe('SIGKILL');
    expect(fx.requests).toHaveLength(0);

    const spawned2 = [];
    const stops2 = [];
    const second = await openWorker({ fx, spawned: spawned2, stops: stops2, stopOwned: async ({ reason }) => (stops2.push(reason), 'uncertain') });
    await second.worker.send({ commandId: randomUUID(), text: 'one', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(second.events)))?.terminal).toBe('completed');
    planted(sp(spawned2));
    const state = need(await until(() => second.events.find((e) => e.kind === 'state' && e.payload.state === 'reconciling'), 10_000), 'reconciling state');
    expect(state.payload).toEqual({ state: 'reconciling' });
    expect(stops2).toEqual(['unexpected_mcp_server']);
    expect(second.logLines.some((l) => l.reason === 'unexpected_mcp_server' && l.stop === 'uncertain')).toBe(true);
    expect(await errorCode(second.worker.send({ commandId: randomUUID(), text: 'two', mode: 'start', barrier: async () => {} }))).toBe('reconciling');
    expect(events.find((e) => e.kind === 'state' && e.payload.state === 'reconciling')).toBeUndefined();
  });

  it('a reported model departure stops the owned worker once and fences later prompts', async () => {
    const fx = await fixture([{ hold: true }]);
    const spawned = [];
    const stops = [];
    const { worker, events } = await openWorker({ fx, spawned, stops });
    await worker.send({ commandId: randomUUID(), text: 'long', mode: 'start', barrier: async () => {} });
    await until(() => fx.requests.length === 1);
    const started = need(sp(spawned).raw.find((m) => m.method === 'turn/started'), 'turn/started');
    const reroute = { method: 'model/rerouted', params: { threadId: worker.nativeSessionId, turnId: started.params.turn.id, fromModel: MODEL, toModel: 'ff-other-model', reason: 'highRiskCyberActivity' } };
    sp(spawned).inject(reroute);
    sp(spawned).inject(reroute);
    const violation = need(await until(() => events.find((e) => e.kind === 'state' && e.payload.state === 'profile_violation'), 10_000), 'violation event');
    expect(violation.payload).toMatchObject({ errorCode: 'profile_unavailable', selectedModel: MODEL, actualModel: 'ff-other-model', turnId: started.params.turn.id });
    await until(() => sp(spawned).child.signalCode !== null, 10_000);
    expect(stops).toEqual(['model_rerouted']);
    expect(sp(spawned).child.signalCode).toBe('SIGKILL');
    const calls = [];
    expect(await errorCode(worker.send({ commandId: randomUUID(), text: 'more', mode: 'start', barrier: noBarrier(calls) }))).toBe('profile_unavailable');
    expect(calls).toEqual([]);
    expect(methods(sp(spawned), 'turn/start')).toHaveLength(1);
    expect(fx.requests).toHaveLength(1);
    expect(events.filter((e) => e.terminal && e.terminal === 'completed')).toEqual([]);
  });

  it('a stale steer fails and the active turn continues', async () => {
    const fx = await fixture([{ hold: true }]);
    const fake = randomUUID();
    let realTurn = null;
    const rewrite = (msg, entry) => {
      const start = msg.id !== undefined && methods(entry, 'turn/start').some((w) => w.id === msg.id);
      if (start) {
        realTurn = msg.result.turn.id;
        return { ...msg, result: { ...msg.result, turn: { ...msg.result.turn, id: fake } } };
      }
      if (msg.method === 'turn/started' && msg.params.turn.id === realTurn) return { ...msg, params: { ...msg.params, turn: { ...msg.params.turn, id: fake } } };
      return msg;
    };
    const spawned = [];
    const { worker } = await openWorker({ fx, spawned, transform: rewrite });
    await worker.send({ commandId: randomUUID(), text: 'start', mode: 'start', barrier: async () => {} });
    await until(() => fx.requests.length === 1);
    const calls = [];
    const stale = worker.send({ commandId: randomUUID(), text: 'FF-T6-STALE', mode: 'steer', barrier: noBarrier(calls) });
    expect(await errorCode(stale)).toBe('request_unavailable');
    expect(calls).toHaveLength(1);
    expect(methods(sp(spawned), 'turn/steer')[0].params).toMatchObject({ expectedTurnId: fake });
    fx.release(0);
    const done = need(await until(() => sp(spawned).raw.find((m) => m.method === 'turn/completed' && m.params.turn.id === realTurn)), 'native terminal');
    expect(done.params.turn.status).toBe('completed');
    expect(methods(sp(spawned), 'turn/start')).toHaveLength(1);
    expect(fx.requests).toHaveLength(1);
    expect(JSON.stringify(fx.requests.map((r) => r.body))).not.toContain('FF-T6-STALE');

    const fx2 = await fixture([{ text: 'one' }]);
    const spawned2 = [];
    const idle = await openWorker({ fx: fx2, spawned: spawned2 });
    const calls2 = [];
    expect(await errorCode(idle.worker.send({ commandId: randomUUID(), text: 'nothing running', mode: 'steer', barrier: noBarrier(calls2) }))).toBe('request_unavailable');
    expect(calls2).toEqual([]);
    expect(methods(sp(spawned2), 'turn/steer', 'turn/start')).toEqual([]);
    expect(fx2.requests).toHaveLength(0);
  });

  it('interrupt completes only on turn/completed interrupted', async () => {
    const fx = await fixture([{ hold: true }]);
    let releaseTerminal;
    const held = new Promise((r) => (releaseTerminal = r));
    let terminalSeen = false;
    const delayTerminal = (msg) => {
      if (msg.method !== 'turn/completed') return msg;
      terminalSeen = true;
      return held.then(() => msg);
    };
    const spawned = [];
    const { worker, events } = await openWorker({ fx, spawned, transform: delayTerminal });
    const commandId = randomUUID();
    await worker.send({ commandId, text: 'long', mode: 'start', barrier: async () => {} });
    await until(() => fx.requests.length === 1);
    const order = [];
    let resolved = false;
    const interrupted = worker.interrupt({ commandId: randomUUID(), barrier: async (ref) => order.push(ref) }).then((r) => ((resolved = true), r));
    await until(() => terminalSeen, 15_000);
    expect(methods(sp(spawned), 'turn/interrupt')).toHaveLength(1);
    expect(sp(spawned).raw.some((m) => m.method === 'turn/completed' && m.params.turn.status === 'interrupted')).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(resolved).toBe(false);
    releaseTerminal();
    const result = await interrupted;
    expect(order).toEqual([{}]);
    expect(result.terminal).toBe('interrupted');
    expect(result.settled).toEqual([{ commandId, outcome: 'interrupted', dispatched: true }]);
    expect((await until(() => terminalOf(events), 5_000))?.terminal).toBe('interrupted');
    expect(methods(sp(spawned), 'turn/interrupt')[0].params).toEqual({ threadId: worker.nativeSessionId, turnId: sp(spawned).raw.find((m) => m.method === 'turn/started').params.turn.id });

    const before = methods(sp(spawned), 'turn/interrupt').length;
    expect(await worker.interrupt({ commandId: randomUUID(), barrier: async () => {} })).toMatchObject({ terminal: null, settled: [], dispatched: false });
    expect(methods(sp(spawned), 'turn/interrupt')).toHaveLength(before);
  });

  it('an interrupted turn withdraws its held questions through withdrawTurn as turn_interrupted, and a later answer is request_unavailable', async () => {
    const fx = await fixture([askCall([ORDINARY])]);
    const { worker, events } = await openWorker({ fx });
    await worker.send({ commandId: randomUUID(), text: 'ask', mode: 'start', barrier: async () => {} });
    expect(await accept(worker, need(await until(() => pendingOf(worker, 'permission')), 'pending permission'))).toEqual({ state: 'dispatched' });
    const question = need(await until(() => pendingOf(worker, 'question')), 'pending question');
    expect(question.secret).toBe(false);
    const result = await worker.interrupt({ commandId: randomUUID(), barrier: async () => {} });
    expect(result.terminal).toBe('interrupted');
    const withdrawn = need(await until(() => events.find((e) => e.kind === 'attention' && e.payload.nativeRequestId === question.nativeRequestId && e.payload.record === 'question_withdrawn'), 10_000), 'withdrawal event');
    expect(withdrawn.payload.reason).toBe('turn_interrupted');
    expect(worker.pending().filter((r) => r.kind === 'question')).toEqual([]);
    const calls = [];
    expect(await worker.respond({ commandId: randomUUID(), nativeRequestId: question.nativeRequestId, response: { fingerprint: question.fingerprint, selections: { color: { selected: ['Red'] } } }, source: 'local', barrier: noBarrier(calls) })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(calls).toEqual([]);
  });

  it('resume does no work', async () => {
    const fx = await fixture([{ text: 'one' }]);
    const first = await openWorker({ fx });
    await first.worker.send({ commandId: randomUUID(), text: 'one', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(first.events)))?.terminal).toBe('completed');
    await first.worker.close({ reason: 'test' });
    const order = [];
    const spawned = [];
    const resumed = await openWorker({ fx, dir: first.workspaceDir, resume: { nativeSessionId: first.worker.nativeSessionId }, order, spawned });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(fx.requests).toHaveLength(1);
    expect(order).toEqual([]);
    expect(methods(sp(spawned), 'thread/start', 'turn/start', 'turn/steer')).toEqual([]);
    expect(sp(spawned).raw.filter((m) => m.id !== undefined && m.method !== undefined)).toEqual([]);
    expect(resumed.events.filter((e) => e.terminal)).toEqual([]);
  });

  it('an auth-mode change blocks further admission', async () => {
    const fx = await fixture([{ text: 'one' }, { text: 'two' }]);
    const spawned = [];
    const { worker, events } = await openWorker({ fx, spawned });
    await worker.send({ commandId: randomUUID(), text: 'one', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    sp(spawned).inject({ method: 'account/updated', params: { authMode: 'apikey', planType: null } });
    expect(await until(() => events.find((e) => e.kind === 'state' && e.payload.state === 'sign_in_required'), 10_000)).not.toBeNull();
    const calls = [];
    expect(await errorCode(worker.send({ commandId: randomUUID(), text: 'two', mode: 'start', barrier: noBarrier(calls) }))).toBe('sign_in_required');
    expect(calls).toEqual([]);
    expect(methods(sp(spawned), 'turn/start')).toHaveLength(1);
    expect(fx.requests).toHaveLength(1);
  });

  it('with chatgptSubscriptionAuth() the synthetic provider context never receives a prompt', async () => {
    const c = await createProbeContext('codex');
    contexts.push(c);
    const fx = await fixture([{ text: 'never' }]);
    writeFileSync(join(c.contextDir, 'config.toml'), `model_provider = "ffprobe"\n[model_providers.ffprobe]\nname = "ffprobe"\nbase_url = "${fx.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    const backend = createCodexBackend({ log: log(), auth: chatgptSubscriptionAuth(), parentEnv: c.parentEnv });
    expect((await backend.readiness(profile(c))).state).toBe('sign_in_required');
    const order = [];
    const spawned = [];
    expect(await errorCode(openWorker({ fx, c, auth: chatgptSubscriptionAuth(), order, spawned }))).toBe('sign_in_required');
    expect(methods(sp(spawned), 'account/read')[0].params).toEqual({ refreshToken: false });
    expect(methods(sp(spawned), 'thread/start', 'turn/start')).toEqual([]);
    expect(order).toEqual([]);
    expect(sp(spawned).args.join(' ')).not.toMatch(/model_provider|forced_login_method/);
    expect(fx.requests).toHaveLength(0);
  });
});
