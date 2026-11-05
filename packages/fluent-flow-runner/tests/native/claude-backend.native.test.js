
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeBackend } from '../../src/native/claude-backend.js';
import { claudeSubscriptionAuth } from '../../src/native/claude-auth.js';
import { readProcessDetails } from '../../src/supervisor/process-identity.js';
import { createLedger } from '../../src/supervisor/ledger.js';
import { createCommandBarrier, openEffects } from '../../src/supervisor/backend-contract.js';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startMcpFixture } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { syntheticClaudeAuth } from './harness/synthetic-auth.js';
import { createEvidence } from './harness/evidence.js';

const MODEL = 'ff-probe-model';
const MCP_TOKEN = 'ff-backend-dummy-mcp-token';
const binary = requireNativeBinary('claude-code');
const suite = binary ? describe : describe.skip;

suite('claude-code backend (native)', () => {
  /** @type {Awaited<ReturnType<typeof createProbeContext>>} */
  let ctx;
  let mcp;
  let proxy;
  let privateDir;
  const fixtures = [];
  const workers = new Set();
  const children = new Set();

  beforeAll(async () => {
    await assertNetworkIsolation();
    ctx = await createProbeContext('claude-code');
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    proxy = await startDenyProxy();
    privateDir = join(ctx.root, 'ff-private');
    mkdirSync(privateDir, { mode: 0o700 });
  });

  afterAll(async () => {
    for (const w of workers) await w.close({ reason: 'test_cleanup' }).catch(() => {
    });
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    for (const fx of fixtures) await fx.close();
    await mcp?.close();
    await proxy?.close();
    await ctx?.cleanup();
  });

  async function fixture(script) {
    const fx = await startAnthropicFixture({ script, mainModel: MODEL });
    fixtures.push(fx);
    return fx;
  }

  const profile = (permissionMode = 'manual') => ({
    id: 'claude-test',
    name: 'Claude test',
    backend: 'claude-code',
    executable: binary.executable,
    contextDir: ctx.contextDir,
    model: MODEL,
    policy: { permissionMode },
    complete: true,
  });

  function testSpawn(spawned, extraEnv = {}) {
    return async ({ executable, args, env, cwd }) => {
      const writes = [];
      const results = [];
      const entry = { args, env, writes, results, onWrite: null };
      spawned.push(entry);
      const child = spawn(executable, args, { cwd, env: { ...env, ...probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let stdoutTail = '';
      child.stdout.on('data', (d) => {
        const lines = (stdoutTail + d).split('\n');
        stdoutTail = lines.pop();
        for (const line of lines) if (line.includes('"type":"result"')) {
          const r = JSON.parse(line);
          results.push({ subtype: r.subtype, is_error: r.is_error, terminal_reason: r.terminal_reason });
        }
      });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        const lines = String(chunk).split('\n').filter(Boolean).map((line) => JSON.parse(line));
        writes.push(...lines);
        const written = write(chunk, ...rest);
        for (const line of lines) entry.onWrite?.(line);
        return written;
      };
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const details = await readProcessDetails(child.pid);
      return { child, identity: { ...details, pgid: details.pgid ?? child.pid } };
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
      async absent({ nativeSessionId, evidence }) {
        order.push({ step: 'absent', nativeSessionId, evidence });
      },
    };
  }

  function callBarrier(order, effect) {
    return async (ref) => {
      order.push({ step: 'call_barrier', effect, ref });
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

  async function openWorker({ fx, auth, sessionId = randomUUID(), resume = null, reportingUrl, order = [], spawned = [], extraEnv, permissionMode, generation = 1, effects, readAuthStatus }) {
    const backendLog = log();
    const backend = createClaudeBackend({ privateDir, log: backendLog, auth: auth ?? syntheticClaudeAuth({ fixture: fx }), parentEnv: ctx.parentEnv, readAuthStatus });
    const worker = await backend.open({
      sessionId,
      runId: randomUUID(),
      profile: profile(permissionMode),
      workspaceDir: ctx.worktreeDir,
      reporting: { url: reportingUrl ?? mcp.url, credential: MCP_TOKEN },
      resume,
      generation,
      spawn: testSpawn(spawned, extraEnv),
      effects: effects ?? recordingEffects(order),
    });
    workers.add(worker);
    return { worker, sessionId, order, spawned, events: collect(worker), logLines: backendLog.lines };
  }

  const terminalOf = (events) => events.find((e) => e.terminal);
  const errorCode = (promise) => promise.then(() => null, (err) => err.code ?? String(err));

  it('binds the FF session id and a connected reporter before the first prompt', async () => {
    const fx = await fixture([{ text: 'hello' }]);
    const { worker, sessionId, order, events, spawned } = await openWorker({ fx });
    expect(order).toEqual([
      { step: 'barrier', effect: 'create_native_session', ref: { uuid: sessionId } },
      { step: 'bind', nativeSessionId: sessionId },
    ]);
    expect(worker.nativeSessionId).toBe(sessionId);
    expect(fx.requests.length).toBe(0);
    expect(spawned[0]?.args.slice(-2)).toEqual(['--session-id', sessionId]);

    const sessionDir = join(privateDir, sessionId);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(sessionDir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(sessionDir, 'settings.json'), 'utf8'))).toEqual({ disableAllHooks: true });
    expect(JSON.parse(readFileSync(join(sessionDir, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { ff_reporting: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${MCP_TOKEN}` } } },
    });

    const commandId = randomUUID();
    const { receipt } = await worker.send({ commandId, text: 'hello', mode: 'start', barrier: callBarrier(order, 'prompt') });
    expect(order.at(-1)).toEqual({ step: 'call_barrier', effect: 'prompt', ref: { uuid: commandId } });
    expect(receipt).toMatchObject({ uuid: commandId });
    const terminal = await until(() => terminalOf(events));
    expect(terminal?.terminal).toBe('completed');
    const init = events.find((e) => e.kind === 'state' && e.payload.phase === 'init');
    expect(init?.payload.mcpServers).toEqual([{ name: 'ff_reporting', status: 'connected' }]);
    expect(events.find((e) => e.receiptFor === commandId)?.payload.text).toBe('hello');
    expect(fx.requests.length).toBe(1);
  });

  it('an unreachable reporting MCP refuses the first prompt with startup_failed', async () => {
    const fx = await fixture([{ text: 'never' }]);
    const { worker, order } = await openWorker({ fx, reportingUrl: 'http://127.0.0.1:1/mcp' });
    const before = order.length;
    const code = await errorCode(worker.send({ commandId: randomUUID(), text: 'hi', mode: 'start', barrier: callBarrier(order, 'prompt') }));
    expect(code).toBe('startup_failed');
    expect(order.length).toBe(before);
    expect(fx.requests.length).toBe(0);
  });

  it('flag-like and slash-command text is delivered verbatim', async () => {
    const fx = await fixture([{ text: 'ok' }]);
    const { worker, events } = await openWorker({ fx });
    const text = '/login --resume x @README.md\n--model other -p "$(id)"';
    const commandId = randomUUID();
    await worker.send({ commandId, text, mode: 'start', barrier: async () => {} });
    await until(() => terminalOf(events));
    expect(events.find((e) => e.receiptFor === commandId)?.payload.text).toBe(text);
    const carrying = fx.requests.filter((r) =>
      r.body.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'text' && c.text === text)),
    );
    expect(carrying.length).toBe(1);
    expect(JSON.stringify(fx.requests.map((r) => r.body)).includes('# readme')).toBe(false);
  });

  it('permission requests offer only native choices, each with its behavior, and round-trip', async () => {
    const allowedMarker = join(ctx.worktreeDir, 'allowed-marker');
    const deniedMarker = join(ctx.worktreeDir, 'denied-marker');
    const fx = await fixture([
      { tool: 'Bash', input: { command: `touch ${allowedMarker}`, description: 'allowed' } },
      { tool: 'Bash', input: { command: `touch ${deniedMarker}`, description: 'denied' } },
      { text: 'done' },
    ]);
    const { worker, events } = await openWorker({ fx });
    await worker.send({ commandId: randomUUID(), text: 'run', mode: 'start', barrier: async () => {} });

    const first = await until(() => worker.pending()[0]);
    expect(first?.kind).toBe('permission');
    expect(first.secret).toBe(false);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.choices).toEqual([
      { id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' },
      { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' },
    ]);
    expect(events.some((e) => e.kind === 'attention' && e.payload.nativeRequestId === first.nativeRequestId)).toBe(true);

    const respondOrder = [];
    const mismatched = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: first.nativeRequestId,
      response: { selectedActionId: 'allow_once', behavior: 'deny', fingerprint: first.fingerprint },
      source: 'web',
      barrier: callBarrier(respondOrder, 'respond'),
    });
    expect(mismatched).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    const unoffered = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: first.nativeRequestId,
      response: { selectedActionId: 'allow_session', behavior: 'allow', fingerprint: first.fingerprint },
      source: 'web',
      barrier: callBarrier(respondOrder, 'respond'),
    });
    expect(unoffered).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(respondOrder).toEqual([]);

    const allowed = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: first.nativeRequestId,
      response: { selectedActionId: 'allow_once', behavior: 'allow', fingerprint: first.fingerprint },
      source: 'web',
      barrier: callBarrier(respondOrder, 'respond'),
    });
    expect(allowed).toEqual({ state: 'dispatched' });
    expect(respondOrder).toEqual([{ step: 'call_barrier', effect: 'respond', ref: { nativeRequestId: first.nativeRequestId, requestKind: 'permission', fingerprint: first.fingerprint, source: 'web', operation: 'answer' } }]);
    const again = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: first.nativeRequestId,
      response: { selectedActionId: 'allow_once', behavior: 'allow', fingerprint: first.fingerprint },
      source: 'web',
      barrier: callBarrier(respondOrder, 'respond'),
    });
    expect(again).toEqual({ state: 'failed', errorCode: 'request_unavailable' });

    const second = await until(() => worker.pending().find((p) => p.nativeRequestId !== first.nativeRequestId));
    expect(second?.kind).toBe('permission');
    const denied = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: second.nativeRequestId,
      response: { selectedActionId: 'deny', behavior: 'deny', fingerprint: second.fingerprint },
      source: 'local',
      barrier: async () => {},
    });
    expect(denied).toEqual({ state: 'dispatched' });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    expect(existsSync(allowedMarker)).toBe(true);
    expect(existsSync(deniedMarker)).toBe(false);
    expect(worker.pending()).toEqual([]);
  });

  it('duplicate headers, comma labels, multi-select and other text reach the tool losslessly', async () => {
    const questions = [
      { question: 'Which colors?', header: 'Pick', multiSelect: true, options: [{ label: 'Red, bright', description: 'warm' }, { label: 'Blue', description: 'cool' }, { label: 'Green', description: 'g' }] },
      { question: 'Which size?', header: 'Pick', multiSelect: false, options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }] },
    ];
    const fx = await fixture([{ tool: 'AskUserQuestion', input: { questions } }, { text: 'ok' }]);
    const { worker, events } = await openWorker({ fx });
    await worker.send({ commandId: randomUUID(), text: 'ask', mode: 'start', barrier: async () => {} });
    const request = await until(() => worker.pending()[0]);
    expect(request?.kind).toBe('question');
    expect(request.secret).toBe(false);
    expect(request.questions).toEqual([
      { id: 'q0', header: 'Pick', question: 'Which colors?', options: [{ label: 'Red, bright', description: 'warm' }, { label: 'Blue', description: 'cool' }, { label: 'Green', description: 'g' }], multiSelect: true, allowOther: true, secret: false },
      { id: 'q1', header: 'Pick', question: 'Which size?', options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }], multiSelect: false, allowOther: true, secret: false },
    ]);
    const invalid = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: request.nativeRequestId,
      response: { fingerprint: request.fingerprint, selections: { q0: { selected: ['Red'] }, q1: { selected: ['Small'] } } },
      source: 'web',
      barrier: async () => {},
    });
    expect(invalid).toEqual({ state: 'failed', errorCode: 'invalid_response' });

    const result = await worker.respond({
      commandId: randomUUID(),
      nativeRequestId: request.nativeRequestId,
      response: { fingerprint: request.fingerprint, selections: { q0: { selected: ['Red, bright', 'Blue'] }, q1: { selected: ['Small'], other: 'Other, with "quotes"' } } },
      source: 'web',
      barrier: async () => {},
    });
    expect(result).toEqual({ state: 'dispatched' });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    const toolResult = events.find((e) => e.kind === 'timeline' && e.payload.type === 'tool_result');
    expect(toolResult?.payload.toolUseResult).toMatchObject({
      answers: { 'Which colors?': JSON.stringify(['Red, bright', 'Blue']), 'Which size?': 'Small' },
      annotations: { 'Which size?': { notes: 'Other, with "quotes"' } },
    });
  });

  it('interrupt waits for receipt and terminal result', async () => {
    const fx = await fixture([{ hold: true }]);
    const { worker, events } = await openWorker({ fx });
    const started = randomUUID();
    await worker.send({ commandId: started, text: 'long', mode: 'start', barrier: async () => {} });
    await until(() => fx.requests.length === 1);
    const queued = randomUUID();
    const steer = worker.send({ commandId: queued, text: 'queued', mode: 'steer', barrier: async () => {} });
    const lifecycle = await until(() => events.find((e) => e.kind === 'state' && e.payload.phase === 'command' && e.payload.commandId === queued && e.payload.lifecycle === 'queued'));
    expect(lifecycle).not.toBeNull();
    const order = [];
    const commandId = randomUUID();
    const { receipt, terminal, settled } = await worker.interrupt({ commandId, barrier: callBarrier(order, 'interrupt') });
    expect(order).toEqual([{ step: 'call_barrier', effect: 'interrupt', ref: { cancelQueued: true } }]);
    expect(settled).toEqual([
      { commandId: started, outcome: 'interrupted', dispatched: true },
      { commandId: queued, outcome: 'cancelled', dispatched: true },
    ]);
    expect(receipt).toMatchObject({ cancelled: [queued], still_queued: [] });
    expect(terminal).toBe('interrupted');
    expect((await until(() => terminalOf(events), 5_000))?.terminal).toBe('interrupted');
    expect(fx.requests.length).toBe(1);
    expect(fx.requests[0].aborted).toBe(true);
    expect((await steer).receipt).toMatchObject({ uuid: queued });
  });

  it('an interrupt after the prompt write but before started settles that exact command from native evidence', async () => {
    const fx = await fixture([{ hold: true }]);
    const { worker, events, spawned } = await openWorker({ fx });
    const commandId = randomUUID();
    let startedBefore = null;
    /** @type {Promise<any> | null} */
    let interrupted = null;
    spawned[0].onWrite = (line) => {
      if (line.type !== 'user' || line.uuid !== commandId || interrupted) return;
      startedBefore = events.some((e) => e.kind === 'state' && e.payload.phase === 'command' && e.payload.commandId === commandId);
      interrupted = worker.interrupt({ commandId: randomUUID(), barrier: async () => {} });
    };
    const send = worker.send({ commandId, text: 'race', mode: 'start', barrier: async () => {} });
    await until(() => interrupted, 5_000);
    expect(startedBefore).toBe(false);
    const result = await interrupted;
    expect(result.settled).toHaveLength(1);
    expect(result.settled[0].commandId).toBe(commandId);
    const { outcome } = result.settled[0];
    expect(['cancelled', 'interrupted']).toContain(outcome);
    if (outcome === 'cancelled') {
      expect(result.receipt.cancelled.includes(commandId) || events.some((e) => e.payload?.lifecycle === 'cancelled' && e.payload.commandId === commandId)).toBe(true);
      expect(fx.requests.length).toBe(0);
    } else {
      expect(result.terminal).toBe('interrupted');
      expect(fx.requests.every((r) => r.aborted)).toBe(true);
    }
    expect((await send).receipt).toMatchObject({ uuid: commandId });
    const count = fx.requests.length;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(fx.requests.length).toBe(count);
    const evidence = createEvidence({ backend: 'claude-code', version: binary.version, root: ctx.root });
    evidence.record('T5-interrupt-race', { nativeResults: spawned[0].results, startedBeforeInterrupt: startedBefore, settled: result.settled.map((x) => ({ ...x, commandId: '<prompt>' })), receipt: { still_queued: result.receipt.still_queued, cancelled: result.receipt.cancelled.map((id) => (id === commandId ? '<prompt>' : id)) }, terminal: result.terminal, modelRequests: count });
    evidence.flush();
  });

  it('interrupt on a proven idle worker returns no terminal and settles nothing', async () => {
    const fx = await fixture([{ text: 'one' }]);
    const { worker, events } = await openWorker({ fx });
    const fresh = await worker.interrupt({ commandId: randomUUID(), barrier: async () => {} });
    expect(fresh.terminal).toBeNull();
    expect(fresh.settled).toEqual([]);
    await worker.send({ commandId: randomUUID(), text: 'go', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    const afterTurn = await worker.interrupt({ commandId: randomUUID(), barrier: async () => {} });
    expect(afterTurn.terminal).toBeNull();
    expect(afterTurn.settled).toEqual([]);
    expect(fx.requests.length).toBe(1);
  });

  it('resume makes no model request', async () => {
    const fx = await fixture([{ text: 'first' }, { text: 'second' }]);
    const first = await openWorker({ fx });
    await first.worker.send({ commandId: randomUUID(), text: 'one', mode: 'start', barrier: async () => {} });
    await until(() => terminalOf(first.events));
    await first.worker.close({ reason: 'test' });
    workers.delete(first.worker);

    const order = [];
    const spawned = [];
    const resumed = await openWorker({ fx, sessionId: first.sessionId, resume: { nativeSessionId: first.sessionId }, order, spawned, generation: 2 });
    expect(spawned[0]?.args.slice(-2)).toEqual(['--resume', first.sessionId]);
    expect(order).toEqual([]);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(fx.requests.length).toBe(1);
    await resumed.worker.send({ commandId: randomUUID(), text: 'two', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(resumed.events)))?.terminal).toBe('completed');
    expect(fx.requests.length).toBe(2);
  });

  it('a create barrier without bind resumes or recreates the same UUID, never a new one', async () => {
    const fx = await fixture([{ text: 'after recreate' }, { text: 'state' }]);
    const sessionId = randomUUID();
    const crashSpawned = [];
    const failingBind = {
      async barrier() {},
      async bind() {
        throw new Error('simulated crash before bind');
      },
    };
    const crashed = await openWorker({ fx, sessionId, spawned: crashSpawned, effects: failingBind }).then(
      () => 'opened',
      (err) => err.message,
    );
    expect(crashed).toBe('simulated crash before bind');
    expect(crashSpawned.map((s) => s.args.slice(-2))).toEqual([['--session-id', sessionId]]);

    const recreated = await openWorker({ fx, sessionId, resume: { nativeSessionId: sessionId, bound: false }, generation: 2 });
    expect(recreated.spawned.map((s) => s.args.slice(-2))).toEqual([
      ['--resume', sessionId],
      ['--session-id', sessionId],
    ]);
    expect(recreated.order).toEqual([
      { step: 'absent', nativeSessionId: sessionId, evidence: 'resume_not_found' },
      { step: 'barrier', effect: 'create_native_session', ref: { uuid: sessionId } },
      { step: 'bind', nativeSessionId: sessionId },
    ]);
    await recreated.worker.send({ commandId: randomUUID(), text: 'go', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(recreated.events)))?.terminal).toBe('completed');
    await recreated.worker.close({ reason: 'test' });
    workers.delete(recreated.worker);

    const found = await openWorker({ fx, sessionId, resume: { nativeSessionId: sessionId, bound: false }, generation: 3 });
    expect(found.spawned.map((s) => s.args.slice(-2))).toEqual([['--resume', sessionId]]);
    expect(found.order).toEqual([{ step: 'bind', nativeSessionId: sessionId }]);
    await found.worker.send({ commandId: randomUUID(), text: 'again', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(found.events)))?.terminal).toBe('completed');
    expect(fx.requests.length).toBe(2);
    const allArgs = [...crashSpawned, ...recreated.spawned, ...found.spawned].map((s) => s.args.at(-1));
    expect(new Set(allArgs)).toEqual(new Set([sessionId]));
  });

  it('a fresh auth status other than claude.ai refuses the first prompt even when the init account is admitted', async () => {
    const fx = await fixture([{ text: 'must not run' }]);
    const reads = [];
    const readAuthStatus = async (profile, opts) => {
      reads.push({ contextDir: profile.contextDir, ...opts });
      return { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' };
    };
    const auth = { ...claudeSubscriptionAuth(), admitInit: () => ({ ok: true }) };
    const { worker, order, spawned, sessionId } = await openWorker({ fx, auth, readAuthStatus });
    expect(reads.length).toBe(1);
    expect(reads[0].cwd).toBe(join(privateDir, sessionId));
    expect(reads[0].env?.CLAUDE_CONFIG_DIR).toBe(ctx.contextDir);
    expect(Object.keys(reads[0].env).filter((k) => /ANTHROPIC|PROXY/i.test(k))).toEqual([]);
    const before = order.length;
    const code = await errorCode(worker.send({ commandId: randomUUID(), text: 'hi', mode: 'start', barrier: callBarrier(order, 'prompt') }));
    expect(code).toBe('sign_in_required');
    expect(order.length).toBe(before);
    expect((spawned[0]?.writes ?? []).some((w) => w.type === 'user')).toBe(false);
    expect(fx.requests.length).toBe(0);
  });

  it('with claudeSubscriptionAuth() the dummy context never receives a prompt', async () => {
    const fx = await fixture([{ text: 'must not run' }]);
    const extraEnv = { ANTHROPIC_BASE_URL: fx.url, ANTHROPIC_API_KEY: 'sk-ant-ff-backend-dummy-key' };
    const { worker, order } = await openWorker({ fx, auth: claudeSubscriptionAuth(), extraEnv });
    const before = order.length;
    const code = await errorCode(worker.send({ commandId: randomUUID(), text: 'hi', mode: 'start', barrier: callBarrier(order, 'prompt') }));
    expect(code).toBe('sign_in_required');
    expect(order.length).toBe(before);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(fx.requests.length).toBe(0);
  });

  it('admission reads initialize, mcp_status and get_settings before any prompt, and the reporter bearer never leaves the private file', async () => {
    const fx = await fixture([{ text: 'admitted' }]);
    const { worker, spawned, events, logLines } = await openWorker({ fx });
    const writes = spawned[0]?.writes ?? [];
    expect(writes.some((w) => w.type === 'user')).toBe(false);
    expect(fx.requests.length).toBe(0);
    const subtypes = writes.filter((w) => w.type === 'control_request').map((w) => w.request.subtype);
    expect(subtypes[0]).toBe('initialize');
    expect(subtypes.at(-1)).toBe('get_settings');
    expect(subtypes.slice(1, -1).length).toBeGreaterThan(0);
    expect(subtypes.slice(1, -1).every((s) => s === 'mcp_status')).toBe(true);
    const commandId = randomUUID();
    await worker.send({ commandId, text: 'go', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');
    expect(JSON.stringify(events).includes(MCP_TOKEN)).toBe(false);
    expect(JSON.stringify(logLines).includes(MCP_TOKEN)).toBe(false);
  });

  it('respond barriers pass the real Task 4 ledger with typed request metadata only', async () => {
    const ledgerDir = join(ctx.root, `ledger-${randomUUID()}`);
    mkdirSync(ledgerDir, { mode: 0o700 });
    const ledger = createLedger({ dir: ledgerDir });
    const questions = [{ question: 'Proceed, really?', header: 'Go', multiSelect: false, options: [{ label: 'Yes, go', description: 'y' }, { label: 'No', description: 'n' }] }];
    const fx = await fixture([
      { tool: 'Bash', input: { command: `touch ${join(ctx.worktreeDir, 'ledger-allowed')}`, description: 'allowed' } },
      { tool: 'AskUserQuestion', input: { questions } },
      { tool: 'Bash', input: { command: `touch ${join(ctx.worktreeDir, 'ledger-denied')}`, description: 'denied' } },
      { text: 'done' },
    ]);
    const { worker, sessionId, events } = await openWorker({ fx });
    await worker.send({ commandId: randomUUID(), text: 'go', mode: 'start', barrier: async () => {} });
    const respondCommand = () => {
      const commandId = randomUUID();
      ledger.submit({ commandId, digest: `d-${commandId}`, runId: 'run-ledger', sessionId, backend: 'claude-code', kind: 'respond' });
      return { commandId, barrier: createCommandBarrier({ ledger, commandId, effect: 'respond', generation: 1 }) };
    };
    const respond = (request, response, source = 'web') => {
      const cmd = respondCommand();
      return worker
        .respond({ commandId: cmd.commandId, nativeRequestId: request.nativeRequestId, response, source, barrier: cmd.barrier })
        .then((r) => ({ ...r, commandId: cmd.commandId }), (err) => ({ thrown: err.code ?? String(err), commandId: cmd.commandId }));
    };

    const permission = await until(() => worker.pending()[0]);
    expect(permission?.kind).toBe('permission');
    const allowed = await respond(permission, { selectedActionId: 'allow_once', behavior: 'allow', fingerprint: permission.fingerprint });
    expect(allowed).toMatchObject({ state: 'dispatched' });
    const repeated = await respond(permission, { selectedActionId: 'allow_once', behavior: 'allow', fingerprint: permission.fingerprint });
    expect(repeated).toMatchObject({ state: 'failed', errorCode: 'request_unavailable' });

    const question = await until(() => worker.pending().find((p) => p.kind === 'question'));
    const invalid = await respond(question, { fingerprint: question.fingerprint, selections: { q0: { selected: ['Yes'] } } });
    expect(invalid).toMatchObject({ state: 'failed', errorCode: 'invalid_response' });
    const answered = await respond(question, { fingerprint: question.fingerprint, selections: { q0: { selected: ['Yes, go'], other: 'secret-ish text' } } }, 'local');
    expect(answered).toMatchObject({ state: 'dispatched' });

    const denial = await until(() => worker.pending().find((p) => p.kind === 'permission' && p.nativeRequestId !== permission.nativeRequestId));
    const denied = await respond(denial, { selectedActionId: 'deny', behavior: 'deny', fingerprint: denial.fingerprint });
    expect(denied).toMatchObject({ state: 'dispatched' });
    expect((await until(() => terminalOf(events)))?.terminal).toBe('completed');

    const records = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const barriers = records.filter((r) => r.type === 'barrier');
    expect(barriers.map((b) => [b.commandId, b.effect, b.generation, b.ref])).toEqual([
      [allowed.commandId, 'respond', 1, { nativeRequestId: permission.nativeRequestId, requestKind: 'permission', fingerprint: permission.fingerprint, source: 'web', operation: 'answer' }],
      [answered.commandId, 'respond', 1, { nativeRequestId: question.nativeRequestId, requestKind: 'question', fingerprint: question.fingerprint, source: 'local', operation: 'answer' }],
      [denied.commandId, 'respond', 1, { nativeRequestId: denial.nativeRequestId, requestKind: 'permission', fingerprint: denial.fingerprint, source: 'web', operation: 'decline' }],
    ]);
    expect(ledger.classify(repeated.commandId)).toBe('undispatched');
    expect(ledger.classify(invalid.commandId)).toBe('undispatched');
    const ledgerBytes = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8');
    expect(ledgerBytes.includes('Yes, go')).toBe(false);
    expect(ledgerBytes.includes('secret-ish text')).toBe(false);
  });

  it('with the real ledger, recreation after a barrier without bind needs its own command and keeps the same UUID', async () => {
    const ledgerDir = join(ctx.root, `ledger-${randomUUID()}`);
    mkdirSync(ledgerDir, { mode: 0o700 });
    const ledger = createLedger({ dir: ledgerDir });
    const fx = await fixture([{ text: 'recreated' }]);
    const sessionId = randomUUID();
    const runId = randomUUID();
    const accept = (kind) => {
      const commandId = randomUUID();
      ledger.submit({ commandId, digest: `d-${commandId}`, runId, sessionId, backend: 'claude-code', kind });
      return commandId;
    };
    const scoped = (commandId, generation, prior = null) => openEffects({ ledger, commandId, sessionId, runId, backend: 'claude-code', generation, workspaceDir: ctx.worktreeDir, prior });

    const c1 = accept('launch');
    const c1g1 = scoped(c1, 1);
    const crashed = await openWorker({ fx, sessionId, effects: { barrier: c1g1.barrier, bind: async () => { throw new Error('simulated crash before bind'); } } }).then(
      () => 'opened',
      (err) => err.message,
    );
    expect(crashed).toBe('simulated crash before bind');
    expect(ledger.classify(c1)).toEqual({ create_native_session: 'uncertain' });

    const sameSpawned = [];
    const sameCommand = await openWorker({ fx, sessionId, resume: { nativeSessionId: sessionId, bound: false }, generation: 2, spawned: sameSpawned, effects: scoped(c1, 2) }).then(
      () => 'opened',
      (err) => err.name,
    );
    expect(sameCommand).toBe('BackendContractError');
    expect(ledger.commandRecord(c1).barriers.map((b) => b.effect)).toEqual(['create_native_session']);
    expect(sameSpawned.map((s) => s.args.slice(-2))).toEqual([['--resume', sessionId]]);

    const c2 = accept('recover');
    const recSpawned = [];
    const order = [];
    const prior = { nativeSessionId: sessionId, onAbsent: async (nativeSessionId) => {
      order.push('absent');
      ledger.recordResolution(c1, { effect: 'create_native_session', kind: 'native_absent', by: c2, evidence: { nativeSessionId, source: 'claude_resume_not_found', generation: 2 } });
    } };
    const c2Effects = scoped(c2, 2, prior);
    const recovered = await openWorker({ fx, sessionId, resume: { nativeSessionId: sessionId, bound: false }, generation: 2, spawned: recSpawned, effects: { ...c2Effects, barrier: async (effect, ref) => { order.push('barrier'); return c2Effects.barrier(effect, ref); } } });
    expect(order).toEqual(['absent', 'barrier']);
    expect(recSpawned.map((s) => s.args.slice(-2))).toEqual([['--resume', sessionId], ['--session-id', sessionId]]);
    expect(ledger.classify(c2)).toEqual({ create_native_session: 'receipted' });
    expect(ledger.bindings().map((b) => [b.nativeSessionId, b.generation])).toEqual([[sessionId, 2]]);
    expect(ledger.classify(c1)).toEqual({ create_native_session: 'resolved' });
    expect(ledger.commandRecord(c1).receipts).toEqual([]);
    await recovered.worker.send({ commandId: randomUUID(), text: 'go', mode: 'start', barrier: async () => {} });
    expect((await until(() => terminalOf(recovered.events)))?.terminal).toBe('completed');
    expect(fx.requests.length).toBe(1);
  });

  it('every fixture saw only expected traffic', () => {
    expect(fixtures.flatMap((fx) => fx.unexpected.map((u) => ({ ...u, body: undefined })))).toEqual([]);
    expect(proxy.attempts).toEqual([]);
  });
});
