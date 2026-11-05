import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeBackend } from '../../../src/native/claude-backend.js';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createCommandBarrier } from '../../../src/supervisor/backend-contract.js';
import { createFakeClaudeChild } from './fixtures/fake-claude-child.js';


const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const roots = [];
const open = [];

afterEach(async () => {
  for (const f of open.splice(0)) {
    await f.worker.close({ reason: 'test' });
    await f.collecting;
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'ff-claude-backend-'));
  roots.push(root);
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { mode: 0o700 });
  const ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir, { mode: 0o700 });
  return { root, worktree, ledger: createLedger({ dir: ledgerDir }) };
}

async function setup({ privateDir, onInterrupt } = {}) {
  const d = dirs();
  const fake = createFakeClaudeChild({ onInterrupt });
  const sessionId = randomUUID();
  const spawnCalls = [];
  const backend = createClaudeBackend({
    privateDir: privateDir?.(d) ?? join(d.root, 'private'),
    log: { info() {}, warn() {}, error() {} },
    auth: { readiness: () => ({ state: 'ready' }), admitInit: () => ({ ok: true }), env: () => ({}), args: () => [] },
    parentEnv: { HOME: d.root },
    readAuthStatus: async () => ({ loggedIn: true }),
  });
  const worker = await backend.open({
    sessionId,
    runId: randomUUID(),
    profile: { backend: 'claude-code', complete: true, model: 'fixture-model', policy: { permissionMode: 'manual' }, contextDir: d.root, executable: '/not-spawned' },
    workspaceDir: d.worktree,
    reporting: { url: 'http://127.0.0.1:1/unused', credential: 'dummy-only' },
    resume: null,
    generation: 1,
    spawn: async (args) => {
      spawnCalls.push(args);
      return { child: fake.child, identity: { pid: 1, startTicks: 1, bootId: 'fixture-only' } };
    },
    effects: { async barrier() {}, async bind() {} },
  });
  const events = [];
  const collecting = (async () => {
    for await (const e of worker.events) events.push(e);
  })();
  const call = (effect) => {
    const commandId = randomUUID();
    d.ledger.submit({ commandId, digest: commandId, runId: 'fixture-run', sessionId, backend: 'claude-code', kind: effect });
    return { commandId, barrier: createCommandBarrier({ ledger: d.ledger, commandId, effect, generation: 1 }) };
  };
  const held = (effect) => {
    const cmd = call(effect);
    const gate = deferred();
    return {
      gate,
      commandId: cmd.commandId,
      barrier: async (ref) => {
        await cmd.barrier(ref);
        await gate.promise;
      },
    };
  };
  const f = { ...d, fake, worker, events, collecting, call, held, spawnCalls };
  open.push(f);
  return f;
}

describe('claude backend dispatch and cancellation boundary', () => {
  it('a send still awaiting its barrier when the interrupt is written is cancelled before dispatch and never writes', async () => {
    const f = await setup();
    const s = f.held('prompt');
    const sending = f.worker.send({ commandId: s.commandId, text: 'delayed-send', mode: 'start', barrier: s.barrier });
    await tick();
    const interrupt = await f.worker.interrupt(f.call('interrupt'));
    expect(interrupt.settled).toEqual([{ commandId: s.commandId, outcome: 'cancelled', dispatched: false }]);
    expect(interrupt.terminal).toBeNull();
    s.gate.resolve();
    const sent = await sending;
    expect(sent.receipt).toEqual({ uuid: s.commandId, state: 'cancelled', dispatched: false });
    await tick();
    expect(f.fake.userWrites()).toHaveLength(0);
    expect(f.ledger.classify(s.commandId)).toEqual({ prompt: 'uncertain' });
  });

  it('a send written while the interrupt awaits its barrier is settled only by native evidence', async () => {
    const f = await setup({
      onInterrupt: (fake) => {
        const ids = [...fake.active];
        setImmediate(() => fake.result(ids, { isError: true, subtype: 'error_during_execution', terminalReason: 'aborted_streaming' }));
        return { still_queued: [], cancelled: [] };
      },
    });
    const i = f.held('interrupt');
    const interrupting = f.worker.interrupt({ commandId: i.commandId, barrier: i.barrier });
    await tick();
    const s = f.call('prompt');
    await f.worker.send({ ...s, text: 'during-interrupt-barrier', mode: 'start' });
    await tick();
    i.gate.resolve();
    const interrupt = await interrupting;
    expect(interrupt.settled).toEqual([{ commandId: s.commandId, outcome: 'interrupted', dispatched: true }]);
    expect(interrupt.terminal).toBe('interrupted');
  });

  it('a written prompt without native evidence leaves the interrupt reconciling when the stream closes', async () => {
    const f = await setup();
    const i = f.held('interrupt');
    const interrupting = f.worker
      .interrupt({ commandId: i.commandId, barrier: i.barrier })
      .then((r) => ({ result: r }), (err) => ({ code: err.code }));
    await tick();
    await f.worker.send({ ...f.call('prompt'), text: 'no-evidence', mode: 'start' });
    i.gate.resolve();
    await tick();
    f.fake.stop();
    expect(await interrupting).toEqual({ code: 'reconciling' });
  });

  it('a proven idle worker still returns no terminal and settles nothing', async () => {
    const f = await setup();
    const interrupt = await f.worker.interrupt(f.call('interrupt'));
    expect(interrupt).toMatchObject({ terminal: null, settled: [] });
  });
});

describe('claude backend response withdrawal', () => {
  async function pendingRequest(f) {
    f.fake.emit({ type: 'control_request', request_id: 'fixture-request', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } } });
    await tick();
    return f.worker.pending()[0];
  }

  it('a request withdrawn while the response barrier is awaited settles without a write, also after the stream closes', async () => {
    const f = await setup();
    const request = await pendingRequest(f);
    const r = f.held('respond');
    let settled = null;
    const responding = f.worker
      .respond({ commandId: r.commandId, nativeRequestId: request.nativeRequestId, source: 'web', response: { selectedActionId: 'allow_once', behavior: 'allow', fingerprint: request.fingerprint }, barrier: r.barrier })
      .then((x) => (settled = x), (err) => (settled = { thrown: err.code }));
    f.fake.emit({ type: 'control_cancel_request', request_id: request.nativeRequestId });
    await tick();
    r.gate.resolve();
    await tick();
    await tick();
    f.fake.stop();
    await f.collecting;
    await Promise.race([responding, tick().then(tick)]);
    expect(settled).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(f.fake.controlResponses()).toHaveLength(0);
  });

  it('a stream that closes while the response barrier is awaited settles without a write', async () => {
    const f = await setup();
    const request = await pendingRequest(f);
    const r = f.held('respond');
    const responding = f.worker.respond({ commandId: r.commandId, nativeRequestId: request.nativeRequestId, source: 'web', response: { selectedActionId: 'deny', behavior: 'deny', fingerprint: request.fingerprint }, barrier: r.barrier });
    await tick();
    f.fake.stop();
    await f.collecting;
    r.gate.resolve();
    expect(await responding).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(f.fake.controlResponses()).toHaveLength(0);
  });
});

describe('claude backend private directory', () => {
  it('a privateDir at or under the worktree is refused before any credential write or spawn, including ..private', async () => {
    for (const name of ['', 'private', '..private', '.ff/..x']) {
      const d = dirs();
      const privateDir = name ? join(d.worktree, name) : d.worktree;
      let spawned = 0;
      const backend = createClaudeBackend({
        privateDir,
        log: { info() {}, warn() {}, error() {} },
        auth: { readiness: () => ({ state: 'ready' }), admitInit: () => ({ ok: true }), env: () => ({}), args: () => [] },
        parentEnv: { HOME: d.root },
      });
      const sessionId = randomUUID();
      const outcome = await backend
        .open({
          sessionId,
          runId: randomUUID(),
          profile: { backend: 'claude-code', complete: true, model: 'm', policy: { permissionMode: 'manual' }, contextDir: d.root, executable: '/not-spawned' },
          workspaceDir: d.worktree,
          reporting: { url: 'http://127.0.0.1:1/unused', credential: 'dummy-only' },
          resume: null,
          generation: 1,
          spawn: async () => {
            spawned += 1;
            throw new Error('fixture: no spawn');
          },
          effects: { async barrier() {}, async bind() {} },
        })
        .then(() => 'opened', (err) => `${err.code}/${err.reason}`);
      expect(outcome, name || '<worktree>').toBe('startup_failed/private_dir_inside_worktree');
      expect(spawned, name).toBe(0);
      expect(existsSync(join(privateDir, sessionId, 'mcp.json')), name).toBe(false);
    }
  });

  it('a genuine sibling outside the worktree is accepted', async () => {
    const f = await setup({ privateDir: (d) => join(d.root, '..private-sibling') });
    expect(f.spawnCalls).toHaveLength(1);
  });
});
