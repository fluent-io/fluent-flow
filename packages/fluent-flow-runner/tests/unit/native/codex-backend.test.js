import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createCodexBackend, isCodexRetainedProcess, routeAnswerBarrier } from '../../../src/native/codex-backend.js';
import { BackendContractError, createCommandBarrier } from '../../../src/supervisor/backend-contract.js';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createFakeCodexChild } from './fixtures/fake-codex-child.js';

const TEST_AUTH = Object.freeze({ kind: 'test', readiness: () => ({ state: 'ready' }), admitsAuthMode: () => true, env: () => ({}), args: () => ({}) });
const roots = [];
const workers = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const w of workers.splice(0)) await w.close({ reason: 'test' });
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ff-codex-backend-')));
  roots.push(dir);
  return dir;
}

function recordingLog() {
  const lines = [];
  const write = (level) => (obj) => lines.push({ level, ...obj });
  return { lines, info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

async function openFake({ interruptEndsTurn = true, stopOwned = async () => 'quiesced', log = recordingLog(), spawnCalls = [], fakeOpts = {}, effects = { barrier: async () => {}, bind: async () => {} }, holder = {} } = {}) {
  const dir = root();
  let fake;
  const backend = createCodexBackend({ log, auth: TEST_AUTH, parentEnv: { HOME: dir } });
  const worker = await backend.open({
    sessionId: 'session-unit',
    runId: 'run-unit',
    profile: { id: 'codex-unit', backend: 'codex', executable: '/fake/codex', contextDir: dir, model: 'fixture-model', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, complete: true },
    workspaceDir: dir,
    reporting: { url: 'http://127.0.0.1:9/mcp', credential: 'unit-reporting-token' },
    resume: null,
    generation: 1,
    spawn: async ({ args, cwd, env }) => {
      spawnCalls.push({ args, cwd });
      holder.args = args;
      holder.env = env;
      fake = createFakeCodexChild({ args, cwd, interruptEndsTurn, ...fakeOpts });
      holder.fake = fake;
      holder.dir = dir;
      return { child: fake.child, identity: { pid: 1, startTicks: 1, bootId: 'boot', pgid: 1, cgroup: '/unit' } };
    },
    effects,
    stopOwned,
  });
  workers.push(worker);
  const events = [];
  (async () => {
    for await (const e of worker.events) events.push(e);
  })().catch(() => {
  });
  return { worker, fake: /** @type {ReturnType<typeof createFakeCodexChild>} */ (fake), events, log, holder };
}

function ledgerCommands() {
  const dir = root();
  const ledger = createLedger({ dir });
  const command = (commandId, effect) => {
    ledger.submit({ commandId, digest: `d-${commandId}`, runId: 'run-unit', sessionId: 'session-unit', backend: 'codex', kind: effect });
    return createCommandBarrier({ ledger, commandId, effect, generation: 1 });
  };
  return { ledger, command };
}

function held(barrier) {
  let release;
  const gate = new Promise((r) => (release = r));
  let entered = false;
  return {
    get entered() {
      return entered;
    },
    release: () => release(),
    barrier: async (ref) => {
      entered = true;
      await gate;
      return barrier(ref);
    },
  };
}

describe('isCodexRetainedProcess', () => {
  const worker = { pid: 100, startTicks: 1, bootId: 'boot' };
  const candidate = { pid: 101, ppid: 100, startTicks: 2, bootId: 'boot', cgroup: '/ff/worker' };
  const processes = {
    100: { ...worker, ppid: 1, cgroup: '/ff/worker' },
    101: candidate,
    102: { pid: 102, ppid: 100, startTicks: 3, bootId: 'boot', cgroup: '/ff/worker' },
  };
  const detailsFor = async (pid) => processes[pid] ?? null;
  const executableFor = (pid) => ({
    100: '/opt/codex/vendor/x86_64-unknown-linux-musl/codex',
    101: '/opt/codex/vendor/x86_64-unknown-linux-musl/codex-code-mode-host',
    102: '/opt/codex/vendor/x86_64-unknown-linux-musl/other',
  })[pid];

  it('recognizes only the same-lifetime sibling helper parented by the Codex worker', async () => {
    expect(await isCodexRetainedProcess({ worker, candidate, detailsFor, executableFor })).toBe(true);
    expect(await isCodexRetainedProcess({ worker, candidate: { ...candidate, ppid: 99 }, detailsFor, executableFor })).toBe(false);
    expect(await isCodexRetainedProcess({ worker, candidate: processes[102], detailsFor, executableFor })).toBe(false);
  });

  it('rejects a process whose identity changes around executable inspection', async () => {
    let candidateReads = 0;
    const changedDetails = async (pid) => {
      if (pid !== candidate.pid) return processes[pid] ?? null;
      candidateReads += 1;
      return candidateReads === 1 ? candidate : { ...candidate, startTicks: candidate.startTicks + 1 };
    };
    expect(await isCodexRetainedProcess({ worker, candidate, detailsFor: changedDetails, executableFor })).toBe(false);
  });
});

describe('codex backend ordering (in-memory child)', () => {
  it('open without the supervisor-bound stopOwned fails before spawn', async () => {
    const dir = root();
    const spawnCalls = [];
    const backend = createCodexBackend({ log: recordingLog(), auth: TEST_AUTH, parentEnv: { HOME: dir } });
    await expect(
      backend.open({
        sessionId: 's', runId: 'r', resume: null, generation: 1, workspaceDir: dir,
        profile: { backend: 'codex', executable: '/fake/codex', contextDir: dir, model: 'm', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, complete: true },
        reporting: { url: 'http://127.0.0.1:9/mcp', credential: 't' },
        spawn: async () => spawnCalls.push(1),
        effects: { barrier: async () => {}, bind: async () => {} },
      }),
    ).rejects.toBeInstanceOf(BackendContractError);
    expect(spawnCalls).toEqual([]);
  });

  it('a delayed send barrier never writes once the interrupt boundary formed first (real ledger)', async () => {
    const { worker, fake } = await openFake();
    const { ledger, command } = ledgerCommands();
    const send = held(command('prompt-1', 'prompt'));
    const sending = worker.send({ commandId: 'prompt-1', text: 'hi', mode: 'start', barrier: send.barrier });
    await flush();
    expect(send.entered).toBe(true);
    const interrupted = await worker.interrupt({ commandId: 'interrupt-1', barrier: command('interrupt-1', 'interrupt') });
    expect(interrupted).toEqual({ receipt: null, terminal: null, settled: [{ commandId: 'prompt-1', outcome: 'cancelled', dispatched: false }], dispatched: false });
    send.release();
    expect(await sending).toEqual({ receipt: { commandId: 'prompt-1', state: 'cancelled', dispatched: false } });
    await flush();
    expect(fake.sent('turn/start')).toEqual([]);
    expect(fake.sent('turn/interrupt')).toEqual([]);
    expect(ledger.classify('prompt-1')).toEqual({ prompt: 'uncertain' });
  });

  it('a send written during a delayed interrupt barrier is part of that interrupt evidence (real ledger)', async () => {
    const { worker, fake } = await openFake();
    const { command } = ledgerCommands();
    await worker.send({ commandId: 'prompt-1', text: 'first', mode: 'start', barrier: command('prompt-1', 'prompt') });
    const turnId = fake.activeTurn;
    const stop = held(command('interrupt-1', 'interrupt'));
    const interrupting = worker.interrupt({ commandId: 'interrupt-1', barrier: stop.barrier });
    await flush();
    expect(stop.entered).toBe(true);
    await worker.send({ commandId: 'prompt-2', text: 'steer', mode: 'steer', barrier: command('prompt-2', 'prompt') });
    expect(fake.sent('turn/steer')).toHaveLength(1);
    stop.release();
    const result = await interrupting;
    expect(fake.sent('turn/interrupt').map((w) => w.params)).toEqual([{ threadId: fake.threadId, turnId }]);
    expect(result.terminal).toBe('interrupted');
    expect(result.settled).toEqual([
      { commandId: 'prompt-1', outcome: 'interrupted', dispatched: true },
      { commandId: 'prompt-2', outcome: 'interrupted', dispatched: true },
    ]);
  });

  it('a request the native resolves during its response barrier settles request_unavailable with no write', async () => {
    const { worker, fake } = await openFake();
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    fake.request(41, 'item/commandExecution/requestApproval', { itemId: 'call_1', availableDecisions: ['accept', 'cancel'] });
    await flush();
    const [request] = worker.pending();
    expect(request.nativeRequestId).toBe('rpc:41');
    const { command } = ledgerCommands();
    const answer = held(command('respond-1', 'respond'));
    const responding = worker.respond({ commandId: 'respond-1', nativeRequestId: request.nativeRequestId, response: { fingerprint: request.fingerprint, selectedActionId: 'accept', behavior: 'allow' }, source: 'web', barrier: answer.barrier });
    await flush();
    expect(answer.entered).toBe(true);
    fake.notify('serverRequest/resolved', { threadId: fake.threadId, requestId: 41 });
    await flush();
    answer.release();
    expect(await responding).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    await flush();
    expect(fake.answers(41)).toEqual([]);
  });

  it('a channel that closes during a response barrier settles request_unavailable with no write', async () => {
    const { worker, fake } = await openFake();
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    fake.request(42, 'item/fileChange/requestApproval', { itemId: 'patch_1', startedAtMs: 1 });
    await flush();
    const [request] = worker.pending();
    const answer = held(async () => {});
    const responding = worker.respond({ commandId: 'respond-2', nativeRequestId: request.nativeRequestId, response: { fingerprint: request.fingerprint, selectedActionId: 'decline', behavior: 'deny' }, source: 'web', barrier: answer.barrier });
    await flush();
    fake.stop();
    await flush();
    answer.release();
    expect(await responding).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(fake.answers(42)).toEqual([]);
  });

  it('missing availableDecisions leaves the request visible with no choices and the session reconciling', async () => {
    const { worker, fake, events } = await openFake();
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    fake.request(43, 'item/commandExecution/requestApproval', { itemId: 'call_2' });
    await flush();
    const [request] = worker.pending();
    expect(request.choices).toEqual([]);
    expect(events.filter((e) => e.kind === 'state' && e.payload.state === 'reconciling')).toHaveLength(1);
    const calls = [];
    expect(await worker.respond({ commandId: 'respond-3', nativeRequestId: request.nativeRequestId, response: { selectedActionId: 'accept', behavior: 'allow' }, source: 'web', barrier: async (ref) => calls.push(ref) })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(calls).toEqual([]);
    await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'steer', barrier: async () => {} })).rejects.toMatchObject({ code: 'reconciling' });
  });

  it('an unsupported server request gets a JSON-RPC error and an attention event', async () => {
    const { fake, events } = await openFake();
    fake.request(44, 'item/tool/requestUserInput', { itemId: 'x', questions: [] });
    await flush();
    expect(fake.answers(44)).toEqual([{ id: 44, error: { code: -32601, message: 'Request not supported' } }]);
    expect(events.find((e) => e.kind === 'attention' && e.payload.nativeRequestId === 'rpc:44')?.payload).toEqual({ nativeRequestId: 'rpc:44', state: 'unsupported', method: 'item/tool/requestUserInput' });
  });

  it('an interrupt whose turn never reports its terminal is reconciling after the settle bound', async () => {
    const { worker, fake } = await openFake({ interruptEndsTurn: false });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const interrupting = worker.interrupt({ commandId: 'interrupt-1', barrier: async () => {} });
    const outcome = interrupting.then(
      () => null,
      (err) => ({ code: err.code, reason: err.reason }),
    );
    while (fake.sent('turn/interrupt').length === 0) await flush(1);
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    let early = null;
    outcome.then((o) => (early = o));
    await flush();
    expect(early).toBeNull();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await outcome).toEqual({ code: 'reconciling', reason: 'interrupt_unsettled' });
  });

  it('a thrown owned stop leaves the session reconciling and never reports quiescence', async () => {
    const log = recordingLog();
    const { worker, fake, events } = await openFake({ log, stopOwned: async () => Promise.reject(new Error('cgroup gone')) });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    fake.notify('mcpServer/startupStatus/updated', { threadId: null, name: 'planted', status: 'starting', error: null, failureReason: null });
    await flush();
    expect(events.filter((e) => e.kind === 'state' && e.payload.state === 'reconciling')).toHaveLength(1);
    expect(log.lines.find((l) => l.msg === 'codex owned stop finished')?.stop).toBe('uncertain');
    expect(log.lines.some((l) => l.stop === 'quiesced')).toBe(false);
  });
});

describe('routeAnswerBarrier', () => {
  const record = { type: 'answer_barrier', responseId: 'cmd-1', requestId: 'a'.repeat(32), fingerprint: 'f'.repeat(64), generation: 2, source: 'local', operation: 'answer' };

  it('refuses a stale generation, an unknown, mismatched or repeated response before any barrier', async () => {
    const calls = [];
    const barrier = async (ref) => calls.push(ref);
    const map = (requestId = record.requestId) => new Map([['cmd-1', { barrier, requestId, used: false }]]);
    await expect(routeAnswerBarrier({ ...record, generation: 1 }, { generation: 2, calls: map() })).rejects.toBeInstanceOf(BackendContractError);
    await expect(routeAnswerBarrier({ ...record, responseId: 'cmd-2' }, { generation: 2, calls: map() })).rejects.toBeInstanceOf(BackendContractError);
    await expect(routeAnswerBarrier(record, { generation: 2, calls: map('b'.repeat(32)) })).rejects.toBeInstanceOf(BackendContractError);
    expect(calls).toEqual([]);
    const once = map();
    await routeAnswerBarrier(record, { generation: 2, calls: once });
    await expect(routeAnswerBarrier(record, { generation: 2, calls: once })).rejects.toBeInstanceOf(BackendContractError);
    expect(calls).toEqual([{ nativeRequestId: record.requestId, responseId: 'cmd-1', source: 'local', requestKind: 'question', fingerprint: record.fingerprint, operation: 'answer' }]);
  });
});


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

async function openLost(fakeOpts) {
  const order = [];
  const holder = {};
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const opening = openFake({ fakeOpts: { threadStart: 'drop', ...fakeOpts }, effects: recordingEffects(order), holder });
  const outcome = opening.then(
    (o) => ({ ok: o }),
    (err) => ({ code: err.code, reason: err.reason }),
  );
  while (!holder.fake || holder.fake.sent('thread/start').length === 0) await flush(1);
  await flush();
  await vi.advanceTimersByTimeAsync(20_001);
  for (let i = 0; i < 200; i += 1) await flush(1);
  const result = await outcome;
  vi.useRealTimers();
  return { result, order, fake: holder.fake, dir: holder.dir };
}

describe('codex backend concern pass (in-memory child)', () => {
  it('a lost thread/start response binds the one new owned thread from thread/loaded/list and thread/read, and is admitted only after the gate and an exact rejoin', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { result, order, fake, dir } = await openLost({ loaded: [{ id: 'pre-same', cwd: '<cwd>', createdAt: now }, { id: 'pre-other', cwd: '/elsewhere', createdAt: now }], loadedPageSize: 1 });
    expect(result.code, JSON.stringify(result)).toBeUndefined();
    expect(order).toEqual([
      { step: 'barrier', effect: 'create_native_session', ref: {} },
      { step: 'bind', nativeSessionId: fake.threadId },
    ]);
    expect(result.ok.worker.nativeSessionId).toBe(fake.threadId);
    expect(fake.sent('thread/start')).toHaveLength(1);
    expect(fake.sent('thread/list')).toEqual([]);
    const loadedCalls = fake.writes.filter((w) => w.method === 'thread/loaded/list');
    expect(loadedCalls.length).toBe(5);
    expect(fake.writes.findIndex((w) => w.method === 'thread/loaded/list')).toBeLessThan(fake.writes.findIndex((w) => w.method === 'thread/start'));
    expect(fake.sent('thread/read').map((w) => w.params)).toEqual([{ threadId: fake.threadId }]);
    const methods = fake.writes.filter((w) => w.method).map((w) => w.method);
    const resumeAt = methods.indexOf('thread/resume');
    expect(methods.lastIndexOf('config/read')).toBeGreaterThan(methods.indexOf('thread/start'));
    expect(methods.lastIndexOf('config/read')).toBeLessThan(resumeAt);
    expect(fake.sent('thread/resume').map((w) => w.params)).toEqual([{ threadId: fake.threadId }]);
    expect(fake.sent('turn/start')).toEqual([]);
    expect(dir).toBeTruthy();
  });

  it('a bound recovered thread whose rejoin fails stays reconciling', async () => {
    const { result, order, fake } = await openLost({ resumeError: { code: -32600, message: 'no rollout found for thread id x' } });
    expect(result).toEqual({ code: 'reconciling', reason: 'recovered_rejoin_failed' });
    expect(order).toEqual([
      { step: 'barrier', effect: 'create_native_session', ref: {} },
      { step: 'bind', nativeSessionId: fake.threadId },
    ]);
    expect(fake.sent('thread/start')).toHaveLength(1);
    expect(fake.sent('turn/start')).toEqual([]);
  });

  it('an ambiguous, foreign, old or unreadable lost-create candidate stays reconciling and never retries creation', async () => {
    const now = Math.floor(Date.now() / 1000);
    const variants = {
      twoNew: { afterStartLoaded: [{ id: 'other-new', cwd: '<cwd>', createdAt: now }] },
      foreign: { created: { cwd: '/srv/other-worktree' } },
      old: { created: { createdAt: now - 3600 } },
      unreadable: { unreadable: ['01a1aa0e-0000-7000-8000-000000000001'] },
    };
    for (const [name, fakeOpts] of Object.entries(variants)) {
      const { result, order, fake } = await openLost(fakeOpts);
      expect(result, name).toEqual({ code: 'reconciling', reason: expect.any(String) });
      expect(order, name).toEqual([{ step: 'barrier', effect: 'create_native_session', ref: {} }]);
      expect(fake.sent('thread/start'), name).toHaveLength(1);
      expect(fake.sent('thread/resume'), name).toEqual([]);
    }
  });

  it('a refused thread/start stays reconciling with the create barrier unbound, even with nothing listed', async () => {
    const order = [];
    const holder = {};
    const result = await openFake({ fakeOpts: { threadStart: 'error' }, effects: recordingEffects(order), holder }).then(
      () => null,
      (err) => err.code,
    );
    expect(result).toBe('reconciling');
    expect(order).toEqual([{ step: 'barrier', effect: 'create_native_session', ref: {} }]);
    expect(holder.fake.sent('thread/start')).toHaveLength(1);
  });

  it('a turn/start error is reconciling with its barrier kept, never a settled refusal', async () => {
    const { worker, fake } = await openFake({ fakeOpts: { turnStartError: { code: -32603, message: 'failed to submit turn input: Superseded' } } });
    const { ledger, command } = ledgerCommands();
    await expect(worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: command('prompt-1', 'prompt') })).rejects.toMatchObject({ code: 'reconciling' });
    expect(fake.sent('turn/start')).toHaveLength(1);
    expect(ledger.classify('prompt-1')).toEqual({ prompt: 'uncertain' });
  });

  it('only the native not-submitted steer refusals are request_unavailable; any other steer error is reconciling', async () => {
    const cases = [
      [{ code: -32600, message: 'no active turn to steer' }, 'request_unavailable'],
      [{ code: -32600, message: 'expected active turn id `a` but found `b`' }, 'request_unavailable'],
      [{ code: -32600, message: 'cannot steer a review turn' }, 'request_unavailable'],
      [{ code: -32603, message: 'failed to steer turn: channel closed' }, 'reconciling'],
      [{ code: -32600, message: 'something else' }, 'reconciling'],
    ];
    for (const [steerError, code] of cases) {
      const { worker } = await openFake({ fakeOpts: { steerError } });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'steer', barrier: async () => {} }), steerError.message).rejects.toMatchObject({ code });
    }
  });

  it('a send invoked during pending MCP admission cannot write after an interrupt settled it (real ledger)', async () => {
    const { worker, fake } = await openFake({ fakeOpts: { mcpReady: false } });
    const { ledger, command } = ledgerCommands();
    const sending = worker.send({ commandId: 'prompt-1', text: 'hi', mode: 'start', barrier: command('prompt-1', 'prompt') });
    await flush();
    const interrupted = await worker.interrupt({ commandId: 'interrupt-1', barrier: command('interrupt-1', 'interrupt') });
    expect(interrupted).toEqual({ receipt: null, terminal: null, settled: [{ commandId: 'prompt-1', outcome: 'cancelled', dispatched: false }], dispatched: false });
    fake.readyMcp();
    expect(await sending).toEqual({ receipt: { commandId: 'prompt-1', state: 'cancelled', dispatched: false } });
    await flush();
    expect(fake.sent('turn/start')).toEqual([]);
    expect(ledger.classify('prompt-1')).toBe('undispatched');
  });

  it('a send that dispatches while the interrupt waits for the first turn id is in that interrupt evidence (real ledger)', async () => {
    const { worker, fake } = await openFake({ fakeOpts: { holdTurnStart: true } });
    const { command } = ledgerCommands();
    const first = worker.send({ commandId: 'prompt-1', text: 'first', mode: 'start', barrier: command('prompt-1', 'prompt') });
    await flush();
    expect(fake.sent('turn/start')).toHaveLength(1);
    const interrupting = worker.interrupt({ commandId: 'interrupt-1', barrier: command('interrupt-1', 'interrupt') });
    await flush();
    const second = worker.send({ commandId: 'prompt-2', text: 'second', mode: 'start', barrier: command('prompt-2', 'prompt') });
    await flush();
    const writtenSecond = fake.sent('turn/start').length === 2;
    fake.releaseTurnStarts();
    const result = await interrupting;
    await Promise.all([first, second]);
    expect(fake.sent('turn/interrupt')).toHaveLength(1);
    const entry = result.settled.find((x) => x.commandId === 'prompt-2');
    expect(entry, 'prompt-2 in settled').toBeTruthy();
    expect(entry).toEqual(writtenSecond ? { commandId: 'prompt-2', outcome: 'interrupted', dispatched: true } : { commandId: 'prompt-2', outcome: 'cancelled', dispatched: false });
    if (!writtenSecond) expect(fake.sent('turn/start')).toHaveLength(1);
    expect(result.settled.find((x) => x.commandId === 'prompt-1')).toEqual({ commandId: 'prompt-1', outcome: 'interrupted', dispatched: true });
  });

  it('an actual completed terminal racing an interrupt is reported as completed, never relabelled', async () => {
    const { worker } = await openFake({ fakeOpts: { interruptStatus: 'completed' } });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const result = await worker.interrupt({ commandId: 'interrupt-1', barrier: async () => {} });
    expect(result.terminal).toBe('completed');
    expect(result.settled).toEqual([{ commandId: 'prompt-1', outcome: 'completed', dispatched: true }]);
  });

  it('an MCP always choice says whether the context config lets Codex save it', async () => {
    const userLayer = { name: { type: 'user', file: '/ctx/config.toml' }, version: 'u', config: { mcp_servers: { ff_reporting: { url: 'http://127.0.0.1:9/mcp' } } } };
    const { worker, fake } = await openFake({ fakeOpts: { extraLayers: [userLayer] } });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const ask = (id, serverName) => fake.request(id, 'mcpServer/elicitation/request', { serverName, mode: 'form', message: 'm', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] } });
    ask(60, 'ff_reporting');
    ask(61, 'ff_questions');
    await flush();
    const always = (id) => worker.pending().find((r) => r.nativeRequestId === id)?.choices.find((c) => c.id === 'acceptAlways');
    expect(always('rpc:60')).toEqual({ id: 'acceptAlways', label: "Allow and don't ask again for this tool", scope: null, behavior: 'allow' });
    expect(always('rpc:61')).toEqual({ id: 'acceptAlways', label: "Allow and don't ask again in this session", scope: 'session', behavior: 'allow' });
  });
});


describe('codex backend frozen-model boundary (in-memory child)', () => {
  const reroute = (fake, params) => fake.notify('model/rerouted', { threadId: fake.threadId, turnId: fake.activeTurn, fromModel: 'fixture-model', toModel: 'other-model', reason: 'highRiskCyberActivity', ...params });
  const usage = (fake) => fake.notify('thread/tokenUsage/updated', { threadId: fake.threadId, turnId: fake.activeTurn, tokenUsage: { total: { totalTokens: 9, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 }, last: {}, modelContextWindow: null } });
  const stopper = (stops, result = 'quiesced') => async ({ reason }) => {
    stops.push(reason);
    if (result instanceof Error) throw result;
    return result;
  };

  it('a reported departure from the selected model fences later prompts, stops the owned worker once and keeps the actual model and native terminal', async () => {
    const stops = [];
    const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const turnId = fake.activeTurn;
    reroute(fake);
    reroute(fake);
    await flush();
    expect(stops).toEqual(['model_rerouted']);
    const violation = events.find((e) => e.kind === 'state' && e.payload.state === 'profile_violation');
    expect(violation?.payload).toEqual({ state: 'profile_violation', errorCode: 'profile_unavailable', threadId: fake.threadId, turnId, selectedModel: 'fixture-model', actualModel: 'other-model', fromModel: 'fixture-model', reason: 'highRiskCyberActivity' });
    usage(fake);
    fake.endTurn(turnId, 'completed');
    await flush();
    expect(events.find((e) => e.kind === 'usage')?.payload).toMatchObject({ turnId, model: null, modelAttribution: 'mixed', modelsReported: ['fixture-model', 'other-model'], tokens: { total: 9 } });
    const terminal = events.find((e) => e.terminal);
    expect(terminal).toMatchObject({ terminal: 'failed', payload: { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable' } });
    const { ledger, command } = ledgerCommands();
    await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'start', barrier: command('prompt-2', 'prompt') })).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(ledger.classify('prompt-2')).toBe('undispatched');
    expect(fake.sent('turn/start')).toHaveLength(1);
  });

  it('a send whose barrier is pending when the departure is reported is never written (real ledger)', async () => {
    const { worker, fake } = await openFake({ stopOwned: stopper([]) });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const { ledger, command } = ledgerCommands();
    const steer = held(command('prompt-2', 'prompt'));
    const steering = worker.send({ commandId: 'prompt-2', text: 'steer', mode: 'steer', barrier: steer.barrier });
    await flush();
    expect(steer.entered).toBe(true);
    reroute(fake);
    await flush();
    steer.release();
    await expect(steering).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(fake.sent('turn/steer')).toEqual([]);
    expect(ledger.classify('prompt-2')).toEqual({ prompt: 'uncertain' });
  });

  it('a reroute to the selected model does not stop or fence the worker', async () => {
    const stops = [];
    const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    reroute(fake, { fromModel: 'fixture-model', toModel: 'fixture-model' });
    await flush();
    fake.endTurn(fake.activeTurn, 'completed');
    await flush();
    expect(stops).toEqual([]);
    expect(events.find((e) => e.terminal)?.terminal).toBe('completed');
    await worker.send({ commandId: 'prompt-2', text: 'again', mode: 'start', barrier: async () => {} });
    expect(fake.sent('turn/start')).toHaveLength(2);
  });

  it('a malformed or foreign reroute never guesses a model: it fences, stops once and reconciles', async () => {
    for (const params of [{ toModel: undefined }, { toModel: 42 }, { threadId: 'some-other-thread' }]) {
      const stops = [];
      const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      reroute(fake, params);
      await flush();
      usage(fake);
      fake.endTurn(fake.activeTurn, 'completed');
      await flush();
      const label = JSON.stringify(params);
      expect(stops, label).toEqual(['model_rerouted']);
      expect(events.find((e) => e.kind === 'state' && e.payload.state === 'profile_violation')?.payload.actualModel, label).toBeNull();
      expect(events.find((e) => e.kind === 'usage')?.payload.model, label).toBeNull();
      expect(events.find((e) => e.terminal)?.terminal, label).toBe('failed');
      await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'start', barrier: async () => {} }), label).rejects.toMatchObject({ code: 'profile_unavailable' });
    }
  });

  it('an own-thread departure with no usable turn id leaves the open turn attribution unknown', async () => {
    for (const turnId of [undefined, null, '', 7]) {
      const { worker, fake, events } = await openFake({ stopOwned: stopper([]) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      const turn = fake.activeTurn;
      usage(fake);
      const params = { threadId: fake.threadId, fromModel: 'fixture-model', toModel: 'other-model', reason: 'highRiskCyberActivity' };
      if (turnId !== undefined) params.turnId = turnId;
      fake.notify('model/rerouted', params);
      await flush();
      fake.endTurn(turn, 'completed');
      await flush();
      const label = String(turnId);
      expect(events.find((e) => e.kind === 'usage')?.payload, label).toMatchObject({ turnId: turn, model: null, modelAttribution: 'unknown', tokens: { total: 9 } });
      expect(events.find((e) => e.kind === 'state' && e.payload.state === 'profile_violation')?.payload.actualModel, label).toBe('other-model');
    }
  });

  it('an unscoped report from another model back to the selected model leaves the turn unknown; selected-to-selected keeps it', async () => {
    for (const [fromModel, expected, expectedStops] of [['other-model', { model: null, modelAttribution: 'unknown' }, ['model_rerouted']], ['fixture-model', { model: 'fixture-model', modelAttribution: 'single' }, []]]) {
      const stops = [];
      const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      const turn = fake.activeTurn;
      usage(fake);
      fake.notify('model/rerouted', { threadId: fake.threadId, fromModel, toModel: 'fixture-model', reason: 'highRiskCyberActivity' });
      await flush();
      fake.endTurn(turn, 'completed');
      await flush();
      expect(events.find((e) => e.kind === 'usage')?.payload, fromModel).toMatchObject({ turnId: turn, ...expected, tokens: { total: 9 } });
      expect(stops, fromModel).toEqual(expectedStops);
    }
  });

  it('an own-thread return from another model to the selected model is a violation: one stop, fenced sends, no success (scoped and missing-turn)', async () => {
    for (const form of ['scoped', 'missing-turn']) {
      const stops = [];
      const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      const turn = fake.activeTurn;
      usage(fake);
      const { ledger, command } = ledgerCommands();
      const steer = held(command('prompt-2', 'prompt'));
      const steering = worker.send({ commandId: 'prompt-2', text: 'steer', mode: 'steer', barrier: steer.barrier });
      await flush();
      expect(steer.entered, form).toBe(true);
      const params = { threadId: fake.threadId, fromModel: 'other-model', toModel: 'fixture-model', reason: 'highRiskCyberActivity' };
      if (form === 'scoped') params.turnId = turn;
      fake.notify('model/rerouted', params);
      fake.notify('model/rerouted', params);
      await flush();
      steer.release();
      await expect(steering, form).rejects.toMatchObject({ code: 'profile_unavailable' });
      expect(fake.sent('turn/steer'), form).toEqual([]);
      expect(ledger.classify('prompt-2'), form).toEqual({ prompt: 'uncertain' });
      expect(stops, form).toEqual(['model_rerouted']);
      const violations = events.filter((e) => e.kind === 'state' && e.payload.state === 'profile_violation');
      expect(violations, form).toHaveLength(1);
      expect(violations[0].payload, form).toEqual({ state: 'profile_violation', errorCode: 'profile_unavailable', threadId: fake.threadId, turnId: form === 'scoped' ? turn : null, selectedModel: 'fixture-model', actualModel: 'fixture-model', fromModel: 'other-model', reason: 'highRiskCyberActivity' });
      fake.endTurn(turn, 'completed');
      await flush();
      const terminal = events.find((e) => e.terminal);
      expect(terminal, form).toMatchObject({ terminal: 'failed', payload: { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable' } });
      expect(events.find((e) => e.kind === 'usage')?.payload, form).toMatchObject({ turnId: turn, model: null, tokens: { total: 9 } });
      expect(events.find((e) => e.kind === 'usage')?.payload.modelAttribution, form).not.toBe('single');
      await expect(worker.send({ commandId: 'prompt-3', text: 'more', mode: 'start', barrier: command('prompt-3', 'prompt') }), form).rejects.toMatchObject({ code: 'profile_unavailable' });
      expect(ledger.classify('prompt-3'), form).toBe('undispatched');
      expect(fake.sent('turn/start'), form).toHaveLength(1);
    }
  });

  it('a missing or invalid source model is never proof of no change, even when the destination is the selected model', async () => {
    for (const fromModel of [undefined, null, '', 42]) {
      const stops = [];
      const { worker, fake, events } = await openFake({ stopOwned: stopper(stops) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      const params = { threadId: fake.threadId, turnId: fake.activeTurn, toModel: 'fixture-model', reason: 'highRiskCyberActivity' };
      if (fromModel !== undefined) params.fromModel = fromModel;
      fake.notify('model/rerouted', params);
      await flush();
      fake.endTurn(fake.activeTurn, 'completed');
      await flush();
      const label = String(fromModel);
      expect(stops, label).toEqual(['model_rerouted']);
      expect(events.find((e) => e.kind === 'state' && e.payload.state === 'profile_violation')?.payload, label).toMatchObject({ actualModel: 'fixture-model', fromModel: null });
      expect(events.find((e) => e.terminal)?.terminal, label).toBe('failed');
    }
  });

  it('an uncertain or thrown stop after a departure leaves the session reconciling', async () => {
    for (const result of ['uncertain', new Error('scope gone')]) {
      const log = recordingLog();
      const { worker, fake, events } = await openFake({ log, stopOwned: stopper([], result) });
      await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
      reroute(fake);
      await flush();
      expect(events.filter((e) => e.kind === 'state' && e.payload.state === 'reconciling'), String(result)).toHaveLength(1);
      expect(log.lines.some((l) => l.stop === 'quiesced'), String(result)).toBe(false);
      await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'start', barrier: async () => {} })).rejects.toMatchObject({ code: 'profile_unavailable' });
    }
  });

  it('an unexpected MCP server and a departure share one owned stop', async () => {
    const stops = [];
    const { worker, fake } = await openFake({ stopOwned: stopper(stops) });
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    fake.notify('mcpServer/startupStatus/updated', { threadId: null, name: 'planted', status: 'starting', error: null, failureReason: null });
    reroute(fake);
    await flush();
    expect(stops).toEqual(['unexpected_mcp_server']);
    await expect(worker.send({ commandId: 'prompt-2', text: 'more', mode: 'start', barrier: async () => {} })).rejects.toMatchObject({ code: 'profile_unavailable' });
  });
});


function ask(holder, { callId, threadId, turnId, questions }) {
  const pair = holder.args[holder.args.findIndex((a) => a.startsWith('mcp_servers.ff_questions.url='))];
  const url = new URL(JSON.parse(pair.slice(pair.indexOf('=') + 1)));
  const meta = { callId, itemId: callId, threadId, ...(turnId === undefined ? {} : { 'x-codex-turn-metadata': { turn_id: turnId } }) };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { questions: questions ?? [{ id: 'q', header: 'Q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }, _meta: meta } });
  const chunks = [];
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${holder.env.FF_QUESTIONS_TOKEN}` } }, (res) => {
      res.on('data', (d) => chunks.push(String(d)));
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  done.catch(() => {
  });
  return { done, body: () => chunks.join('') };
}

async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

describe('codex backend question ownership (in-memory child, loopback question server)', () => {
  it('an answer held at its barrier while its turn is interrupted is never written (real ledger)', async () => {
    const { worker, fake, events, holder } = await openFake();
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const call = ask(holder, { callId: 'call_owned', threadId: fake.threadId, turnId: fake.activeTurn });
    expect(await until(() => worker.pending().some((r) => r.kind === 'question'))).toBe(true);
    const question = worker.pending().find((r) => r.kind === 'question');
    const { ledger, command } = ledgerCommands();
    const answer = held(command('respond-1', 'respond'));
    const answering = worker.respond({ commandId: 'respond-1', nativeRequestId: question.nativeRequestId, response: { fingerprint: question.fingerprint, selections: { q: { selected: ['A'] } } }, source: 'local', barrier: answer.barrier });
    expect(await until(() => answer.entered)).toBe(true);
    const interrupted = await worker.interrupt({ commandId: 'interrupt-1', barrier: async () => {} });
    expect(interrupted.terminal).toBe('interrupted');
    answer.release();
    expect(await answering).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    const body = await call.done;
    expect(body).toContain('withdrawn');
    expect(body).not.toContain('answered');
    expect(ledger.classify('respond-1')).toEqual({ respond: 'uncertain' });
    const records = events.filter((e) => e.kind === 'attention' && e.payload.nativeRequestId === question.nativeRequestId).map((e) => e.payload.record).filter(Boolean);
    expect(records).toEqual(['question_pending', 'question_withdrawn', 'answer_refused']);
  });

  it('a question whose correlation is not the current owned thread and turn is refused before it becomes actionable', async () => {
    const variants = {
      foreignThread: (fake) => ({ threadId: 'foreign-thread', turnId: fake.activeTurn }),
      foreignTurn: (fake) => ({ threadId: fake.threadId, turnId: 'foreign-turn' }),
      missingTurn: (fake) => ({ threadId: fake.threadId, turnId: undefined }),
      endedTurn: (fake, ended) => ({ threadId: fake.threadId, turnId: ended }),
    };
    for (const [name, correlate] of Object.entries(variants)) {
      const { worker, fake, events, holder } = await openFake();
      await worker.send({ commandId: 'prompt-1', text: 'one', mode: 'start', barrier: async () => {} });
      const ended = fake.activeTurn;
      if (name === 'endedTurn') {
        fake.endTurn(ended, 'completed');
        await flush();
        await worker.send({ commandId: 'prompt-2', text: 'two', mode: 'start', barrier: async () => {} });
      }
      const call = ask(holder, { callId: `call_${name}`, ...correlate(fake, ended) });
      const answered = await Promise.race([call.done, new Promise((r) => setTimeout(() => r(null), 1000))]);
      expect(answered, `${name}: refused at once`).not.toBeNull();
      expect(JSON.parse(answered).error, name).toEqual({ code: -32603, message: 'Question not admitted' });
      expect(worker.pending().filter((r) => r.kind === 'question'), name).toEqual([]);
      expect(events.filter((e) => e.kind === 'attention' && e.payload.state === 'pending' && e.payload.kind === 'question'), name).toEqual([]);
      expect(events.filter((e) => e.kind === 'state' && e.payload.state === 'reconciling'), name).toHaveLength(1);
    }
  });

  it('a question correlated to the current owned thread and turn stays answerable', async () => {
    const { worker, fake, holder } = await openFake();
    await worker.send({ commandId: 'prompt-1', text: 'go', mode: 'start', barrier: async () => {} });
    const call = ask(holder, { callId: 'call_ok', threadId: fake.threadId, turnId: fake.activeTurn });
    expect(await until(() => worker.pending().some((r) => r.kind === 'question'))).toBe(true);
    const question = worker.pending().find((r) => r.kind === 'question');
    expect(question.correlation).toEqual({ threadId: fake.threadId, turnId: fake.activeTurn, callId: 'call_ok', itemId: 'call_ok' });
    expect(await worker.respond({ commandId: 'respond-1', nativeRequestId: question.nativeRequestId, response: { fingerprint: question.fingerprint, selections: { q: { selected: ['B'] } } }, source: 'local', barrier: async () => {} })).toEqual({ state: 'dispatched' });
    expect(await call.done).toContain('answered');
  });
});
