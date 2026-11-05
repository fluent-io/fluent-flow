import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { createIpcServer } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';
import { createConnectorLoop } from '../../../src/connector/loop.js';
import { createExecutor } from '../../../src/connector/executor.js';
import { createJournal } from '../../../src/connector/journal.js';
import { createSlots, holdsSlot } from '../../../src/supervisor/slots.js';
import { ContainmentError } from '../../../src/supervisor/containment.js';
import { readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { profileRevision } from '../../../src/connector/catalog.js';

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '44444444-4444-4444-8444-444444444444';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const claude = { id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx', model: 'm-a', policy: { permissionMode: 'manual' }, summaryProfileId: undefined, complete: true, problems: [] };
const REV = profileRevision(claude, '2.1.317');
const IDLE = { activeTurn: false, pendingRequests: 0, workerPid: 10, cgroupPids: [10], escaped: false, unverifiable: false };

function gitRepo(base) {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return repo;
}

function memoryContainment() {
  const leaves = new Map();
  const kills = [];
  const scopePath = '/mem/ff-0123456789abcdef';
  const leafPath = ({ generation, sessionId }) => `${scopePath}/w-${generation}-${sessionId}`;
  const mem = {
    kills,
    leaves,
    escaped: false,
    readError: null,
    containment: {
      state: 'verified',
      scopePath,
      ops: {
        leafPath,
        createWorker({ generation, sessionId }) { const p = leafPath({ generation, sessionId }); leaves.set(p, { pids: [] }); return p; },
        async spawn({ cgroupPath }) {
          const identity = await readProcessIdentity(process.pid);
          leaves.get(cgroupPath).pids.push(identity.pid);
          const child = Object.assign(new EventEmitter(), { pid: identity.pid, exitCode: null, signalCode: null });
          return { child, identity };
        },
        leaf({ cgroupPath, generation, sessionId }) {
          if (cgroupPath !== leafPath({ generation, sessionId })) throw new ContainmentError('not_owned_leaf', 'not this leaf');
          if (!leaves.has(cgroupPath)) throw new ContainmentError('leaf_missing', 'gone');
          return cgroupPath;
        },
        async read({ cgroupPath }) {
          if (mem.readError) throw mem.readError;
          const { pids } = leaves.get(cgroupPath);
          return { populated: pids.length > 0, pids: pids.map((pid) => ({ pid })) };
        },
        async holds() { return !mem.escaped; },
        async kill({ cgroupPath }) { kills.push(cgroupPath); leaves.get(cgroupPath).pids = []; },
      },
    },
  };
  return mem;
}

function fakeBackend(id) {
  const opened = [];
  const workers = [];
  return {
    id,
    opened,
    workers,
    async readiness() { return { state: 'ready' }; },
    async open(opts) {
      opened.push(opts);
      await opts.effects.barrier('create_native_session', {});
      const { child, identity } = await opts.spawn({ executable: opts.profile.executable, args: [], env: {}, cwd: opts.workspaceDir });
      await opts.effects.bind(`native-${opts.sessionId}`);
      const worker = {
        nativeSessionId: `native-${opts.sessionId}`,
        identity: { ...identity, pgid: child.pid, cgroup: '/unit' },
        events: (async function* () {})(),
        active: false,
        requests: [],
        closed: false,
        idle: () => !worker.active,
        pending: () => worker.requests,
        async send({ barrier }) {
          await barrier({});
          worker.active = true;
          return { receipt: { state: 'replayed', dispatched: true } };
        },
        async respond() { return { state: 'dispatched' }; },
        async interrupt({ barrier }) { await barrier({}); worker.active = false; return { terminal: 'interrupted', settled: [], dispatched: true }; },
        async close() { worker.closed = true; },
      };
      workers.push(worker);
      return worker;
    },
  };
}

function setup({ dir, mem = memoryContainment(), limits = { 'claude-code': 1, codex: 1 }, controlPlaneOnline = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-slots-')));
  roots.push(base);
  const repo = gitRepo(base);
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  const ledgerDir = dir ?? join(stateDir, 'supervisor');
  const ledger = createLedger({ dir: ledgerDir });
  const backend = fakeBackend('claude-code');
  const logs = [];
  const handlers = createSupervisorHandlers({ ledger, profiles: [claude], backends: { 'claude-code': backend }, containment: mem.containment, log: (l) => logs.push(l), stateDir, repositories: { repo }, limits, stopTimeoutMs: 300 });
  if (controlPlaneOnline) {
    handlers.connectorAttached({}, { role: 'connector', connectorEpoch: 0 });
    handlers.controlPlaneStatus({ online: true }, { role: 'connector', connectorEpoch: 0 });
  }
  return { base, ledger, ledgerDir, handlers, backend, mem, logs, stateDir };
}

const reporting = { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' };
const launch = (over = {}) => ({ commandId: 'launch-1', digest: 'd-launch-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'launch', profileId: 'cc-main', profileRevision: REV, repositoryKey: 'repo', branchName: `ff/run-${RUN}`, baseRef: 'main', role: 'work', reporting, ...over });

async function freeSlots(t) {
  const { availableSlots } = await t.handlers.reserveSlots({});
  await t.handlers.releaseSlots({ unused: availableSlots });
  return availableSlots;
}

async function admit(t, cmd = launch()) {
  const { availableSlots } = await t.handlers.reserveSlots({});
  const bound = await t.handlers.submit({ ...cmd, slotGranted: true });
  await t.handlers.releaseSlots({ unused: availableSlots });
  expect(bound).toMatchObject({ state: 'accepted' });
  expect(await t.handlers.deliver({ commandId: cmd.commandId, digest: cmd.digest, text: 'Do the task.' })).toEqual({ state: 'applied' });
  return t.backend.workers.at(-1);
}

const ledgerTypes = (t) => readFileSync(join(t.ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type.startsWith('slot'));

describe('execution slots (Task 10)', () => {
  it('holdsSlot is true for an active turn', async () => {
    expect(holdsSlot({ ...IDLE, activeTurn: true })).toBe(true);
    expect(holdsSlot(IDLE)).toBe(false);
    const t = setup();
    expect(await freeSlots(t)).toEqual({ 'claude-code': 1, codex: 1 });
    const worker = await admit(t);
    expect(worker.active).toBe(true);
    expect(await freeSlots(t)).toEqual({ 'claude-code': 0, codex: 1 });
  });

  it('holdsSlot is true for a pending human request', async () => {
    expect(holdsSlot({ ...IDLE, pendingRequests: 1 })).toBe(true);
    const t = setup();
    const worker = await admit(t);
    worker.active = false;
    worker.requests = [{ nativeRequestId: 'q-1', kind: 'question' }];
    expect((await freeSlots(t))['claude-code']).toBe(0);
    worker.requests = [];
    expect((await freeSlots(t))['claude-code']).toBe(1);
  });

  it('a worker cgroup still holding a descendant keeps the slot after the turn ends', async () => {
    expect(holdsSlot({ ...IDLE, cgroupPids: [10, 11] })).toBe(true);
    const t = setup();
    const worker = await admit(t);
    const leaf = [...t.mem.leaves.values()][0];
    leaf.pids.push(999_999);
    worker.active = false;
    expect((await freeSlots(t))['claude-code']).toBe(0);
    leaf.pids.pop();
    expect((await freeSlots(t))['claude-code']).toBe(1);
  });

  it('an idle worker whose cgroup holds only its own pid frees its slot', async () => {
    const t = setup();
    const worker = await admit(t);
    worker.active = false;
    expect(await freeSlots(t)).toEqual({ 'claude-code': 1, codex: 1 });
    expect(worker.closed).toBe(false);
    expect(t.mem.kills).toEqual([]);
    expect(ledgerTypes(t).map((r) => [r.type, r.sessionId])).toEqual([['slot_reserve', S1], ['slot_release', S1]]);
    await admit(t, launch({ commandId: 'launch-2', digest: 'd-launch-2', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}` }));
    expect(t.backend.workers).toHaveLength(2);
    expect(worker.closed).toBe(false);
  });

  it('escaped or unverifiable activity keeps the slot', async () => {
    expect(holdsSlot({ ...IDLE, escaped: true })).toBe(true);
    expect(holdsSlot({ ...IDLE, unverifiable: true })).toBe(true);
    const t = setup();
    const worker = await admit(t);
    worker.active = false;
    t.mem.escaped = true;
    expect((await freeSlots(t))['claude-code']).toBe(0);
    t.mem.escaped = false;
    t.mem.readError = Object.assign(new Error('read failed'), { code: 'EIO' });
    expect((await freeSlots(t))['claude-code']).toBe(0);
    t.mem.readError = null;
    expect((await freeSlots(t))['claude-code']).toBe(1);
  });

  it('primary and summary share slots', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ff-slots-ledger-')));
    roots.push(dir);
    const slots = createSlots({ ledger: createLedger({ dir }), limits: { 'claude-code': 1, codex: 1 } });
    expect(slots.reserve('claude-code', S1)).toBe(true);
    expect(slots.reserve('claude-code', S2)).toBe(false);
    expect(slots.available()).toEqual({ 'claude-code': 0, codex: 1 });
    const t = setup();
    await admit(t);
    const { seq } = t.ledger.appendEvent({ sessionId: S1, runId: RUN, generation: 1, kind: 'timeline', nativeEventId: 'out-1', payload: { backend: 'claude-code', event: { type: 'assistant_text', text: 'Done.' } } });
    const summary = { commandId: 'summary-1', digest: 'd-summary-1', runId: RUN, sessionId: S2, backend: 'claude-code', kind: 'summarize', profileId: 'cc-main', profileRevision: REV, repositoryKey: 'repo', role: 'summary', reporting,
      summarySource: { sessionId: S1, sourceCursor: { epoch: 'ff-native-v1:claude-code', seq } } };
    const { availableSlots } = await t.handlers.reserveSlots({});
    expect(availableSlots['claude-code']).toBe(0);
    expect(await t.handlers.submit(summary)).toEqual({ state: 'deferred' });
    await t.handlers.releaseSlots({ unused: availableSlots });
    expect(t.backend.opened).toHaveLength(1);
    expect(t.ledger.classify('summary-1')).toBe('undispatched');
  });

  it('a lowered cap stops admission, not work', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ff-slots-ledger-')));
    roots.push(dir);
    const before = createSlots({ ledger: createLedger({ dir }), limits: { 'claude-code': 2, codex: 1 } });
    expect(before.reserve('claude-code', S1)).toBe(true);
    expect(before.reserve('claude-code', S2)).toBe(true);
    const after = createSlots({ ledger: createLedger({ dir }), limits: { 'claude-code': 1, codex: 1 } });
    expect(after.available()).toEqual({ 'claude-code': 0, codex: 1 });
    expect(after.snapshot()['claude-code']).toEqual({ limit: 1, sessions: [S1, S2] });
    expect(after.reserve('claude-code', 'another-session')).toBe(false);
    after.release(S1);
    expect(after.available()['claude-code']).toBe(0);
    after.release(S2);
    expect(after.available()['claude-code']).toBe(1);
  });

  it('slot state survives restart and unknown activity holds the slot', async () => {
    const mem = memoryContainment();
    const first = setup({ mem });
    await admit(first);
    const ledger = createLedger({ dir: first.ledgerDir });
    expect(createSlots({ ledger, limits: { 'claude-code': 1, codex: 1 } }).snapshot()['claude-code']).toEqual({ limit: 1, sessions: [S1] });
    const restarted = { ...first, ledger, handlers: createSupervisorHandlers({ ledger, profiles: [claude], backends: { 'claude-code': fakeBackend('claude-code') }, containment: mem.containment, log: () => {}, stateDir: first.stateDir, repositories: {}, limits: { 'claude-code': 1, codex: 1 } }) };
    expect((await freeSlots(restarted))['claude-code']).toBe(0);
    mem.readError = Object.assign(new Error('read failed'), { code: 'EIO' });
    expect((await freeSlots(restarted))['claude-code']).toBe(0);
    mem.readError = null;
    [...mem.leaves.values()][0].pids = [];
    expect((await freeSlots(restarted))['claude-code']).toBe(1);
  });

  it('grants outstanding at a connector disconnect stay reserved and are reported as held to the next reservation', async () => {
    const t = setup();
    const first = await t.handlers.reserveSlots({ notAfter: '2026-11-05T12:00:30.000Z' });
    expect(first).toEqual({ availableSlots: { 'claude-code': 1, codex: 1 }, grantId: expect.any(String), heldBatches: [] });
    await t.handlers.connectorDetached({}, { role: 'connector', connectorEpoch: 0 });
    const second = await t.handlers.reserveSlots({});
    expect(second).toMatchObject({ availableSlots: { 'claude-code': 0, codex: 0 }, heldBatches: [{ grantId: first.grantId, counts: { 'claude-code': 1, codex: 1 }, notAfter: '2026-11-05T12:00:30.000Z' }] });
    await t.handlers.releaseSlots({ grantId: first.grantId, unused: { 'claude-code': 1, codex: 1 } });
    expect((await t.handlers.reserveSlots({})).availableSlots).toEqual({ 'claude-code': 1, codex: 1 });
  });

  it('a slotHeld redelivery uses its held grant at zero capacity; an accepted lost-ACK redelivery takes no slot and opens nothing', async () => {
    const t = setup();
    const lost = await t.handlers.reserveSlots({});
    expect(lost.availableSlots['claude-code']).toBe(1);
    const next = await t.handlers.reserveSlots({});
    expect(next).toMatchObject({ availableSlots: { 'claude-code': 0, codex: 0 }, heldBatches: [{ grantId: lost.grantId, counts: { 'claude-code': 1, codex: 1 } }] });
    const bound = await t.handlers.submit({ ...launch(), slotHeld: true });
    expect(bound).toMatchObject({ state: 'accepted' });
    expect(ledgerTypes(t).map((r) => r.type)).toEqual(['slot_reserve']);
    expect((await t.handlers.reserveSlots({})).heldBatches).toEqual([{ grantId: lost.grantId, counts: { 'claude-code': 0, codex: 1 }, notAfter: null, version: 2 }]);
    expect(await t.handlers.submit(launch())).toEqual(bound);
    expect(await t.handlers.submit({ ...launch(), slotHeld: true })).toEqual(bound);
    expect(ledgerTypes(t).map((r) => r.type)).toEqual(['slot_reserve']);
    expect(t.backend.opened).toHaveLength(1);
  });

  it('a granted submit in flight across a reconnect uses its own grant once, and the new connection returns nothing it needs', async () => {
    const t = setup({ controlPlaneOnline: false });
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    const open = t.backend.open.bind(t.backend);
    t.backend.open = async (opts) => { await gate; return open(opts); };
    const server = createIpcServer({ instanceId: 'slots-ipc', stateDir: t.stateDir, handlers: t.handlers });
    await server.listen();
    try {
      const a = await connectSupervisor({ instanceId: 'slots-ipc', stateDir: t.stateDir, role: 'connector' });
      expect(await a.request('controlPlaneStatus', { online: true })).toEqual({ recorded: true });
      const grant = await a.request('reserveSlots', { notAfter: '2026-11-05T12:00:30.000Z' });
      expect(grant.availableSlots['claude-code']).toBe(1);
      const inFlight = a.request('submit', { ...launch(), slotGranted: true, grantId: grant.grantId }).catch((err) => err);
      await new Promise((r) => setTimeout(r, 50));
      await a.close();
      await new Promise((r) => setTimeout(r, 50));
      const b = await connectSupervisor({ instanceId: 'slots-ipc', stateDir: t.stateDir, role: 'connector' });
      expect(await b.request('controlPlaneStatus', { online: true })).toEqual({ recorded: true });
      const view = await b.request('reserveSlots', { notAfter: '2026-11-05T12:01:00.000Z' });
      expect(view.availableSlots['claude-code']).toBe(0);
      expect(view.heldBatches.every((h) => h.counts['claude-code'] === 0)).toBe(true);
      await b.request('releaseSlots', { grantId: grant.grantId, unused: { 'claude-code': 1, codex: 0 } });
      release();
      expect(await inFlight).toBeInstanceOf(Error);
      await new Promise((r) => setTimeout(r, 50));
      expect(t.backend.opened).toHaveLength(1);
      expect(ledgerTypes(t).map((r) => [r.type, r.sessionId])).toEqual([['slot_reserve', S1]]);
      expect((await b.request('reserveSlots', {})).availableSlots['claude-code']).toBe(0);
      expect(await b.request('submit', { ...launch(), slotHeld: true })).toMatchObject({ state: 'accepted' });
      expect(t.backend.opened).toHaveLength(1);
      await b.close();
    } finally {
      await server.close();
    }
  });

  it('a release returns grants of its own batch only, never another poll\'s', async () => {
    const t = setup({ limits: { 'claude-code': 2, codex: 1 } });
    const lost = await t.handlers.reserveSlots({ notAfter: '2026-11-05T12:00:30.000Z' });
    expect(lost.availableSlots['claude-code']).toBe(2);
    await t.handlers.releaseSlots({ grantId: lost.grantId, unused: { 'claude-code': 1, codex: 0 } });
    const next = await t.handlers.reserveSlots({ notAfter: '2026-11-05T12:01:00.000Z' });
    expect(next.availableSlots['claude-code']).toBe(1);
    await t.handlers.releaseSlots({ grantId: next.grantId, unused: { 'claude-code': 1, codex: 1 } });
    expect((await t.handlers.reserveSlots({})).heldBatches).toEqual([{ grantId: lost.grantId, counts: { 'claude-code': 1, codex: 1 }, notAfter: '2026-11-05T12:00:30.000Z', version: 2 }]);
  });

  it('a same-id Cancel replay, also after reopening the ledger, reproduces dispatched: false without another write', async () => {
    const t = setup();
    const cancel = { commandId: 'cancel-x', digest: 'd-cancel-x', runId: RUN, sessionId: S2, backend: 'claude-code', kind: 'cancel' };
    expect(await t.handlers.submit(cancel)).toEqual({ state: 'applied', dispatched: false });
    const lines = () => readFileSync(join(t.ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
    const written = lines();
    expect(await t.handlers.submit(cancel)).toEqual({ state: 'applied', dispatched: false });
    const reopened = createSupervisorHandlers({ ledger: createLedger({ dir: t.ledgerDir }), profiles: [claude], backends: { 'claude-code': fakeBackend('claude-code') }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: {}, limits: { 'claude-code': 1, codex: 1 } });
    expect(await reopened.submit(cancel)).toEqual({ state: 'applied', dispatched: false });
    expect(lines()).toBe(written);
    const live = setup();
    const worker = await admit(live);
    worker.active = true;
    const interrupt = { commandId: 'cancel-live', digest: 'd-cancel-live', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' };
    expect(await live.handlers.submit(interrupt)).toEqual({ state: 'applied' });
    expect(await live.handlers.submit(interrupt)).toEqual({ state: 'applied' });
  });

  it('a stale batch snapshot cannot release a grant another outstanding claim still owns', async () => {
    const t = setup({ limits: { 'claude-code': 2, codex: 1 } });
    const old = await t.handlers.reserveSlots({ notAfter: '2026-11-05T12:00:30.000Z' });
    expect(old.availableSlots['claude-code']).toBe(2);
    let admitA = () => {};
    const readinessGate = new Promise((r) => (admitA = r));
    const readiness = t.backend.readiness.bind(t.backend);
    t.backend.readiness = async (p) => { await readinessGate; t.backend.readiness = readiness; return readiness(p); };
    const submitA = t.handlers.submit({ ...launch(), slotGranted: true, grantId: old.grantId });
    const polls = [];
    const capacity = {
      reserve: (params) => t.handlers.reserveSlots(params ?? {}),
      release: ({ grantId, unused, version }) => t.handlers.releaseSlots({ ...(grantId ? { grantId } : {}), unused, ...(version !== undefined ? { version } : {}) }),
    };
    const client = {
      register: async () => ({ connectorSessionId: 'cs-1', leaseEpoch: 1, serverTime: '2026-11-05T12:00:00.000Z' }),
      heartbeat: async (body) => ({ leaseEpoch: body.leaseEpoch }),
      ack: async (_id, body) => ({ state: body.state }),
      observe: async (body) => ({ acceptedEventIds: body.events.map((e) => e.eventId) }),
      poll: async (body) => {
        polls.push(body);
        if (polls.length === 1) {
          admitA();
          expect(await submitA).toMatchObject({ state: 'accepted' });
          return { commands: [], heldClaims: { 'claude-code': 1, codex: 0 }, serverTime: '2026-11-05T12:01:00.000Z' };
        }
        await new Promise((r) => setTimeout(r, 30));
        return { commands: [], heldClaims: { 'claude-code': 1, codex: 0 }, serverTime: '2026-11-05T12:01:30.000Z' };
      },
    };
    const journal = { append: async () => {}, markObservationsAccepted: async () => {}, pendingObservationIds: () => [], observationById: () => null };
    const loop = createConnectorLoop({ client, executor: { execute: async () => ({ state: 'applied', result: {}, observations: [] }) }, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', capacity,
      intervals: { heartbeatIntervalMs: 15_000, minIdlePollCycleMs: 20, pollWaitMs: 0 } });
    const running = loop.start();
    await new Promise((r) => setTimeout(r, 250));
    loop.stop();
    await running;
    expect(polls.length).toBeGreaterThan(2);
    expect(polls.slice(1).every((p) => (p.availableSlots?.['claude-code'] ?? 0) === 0)).toBe(true);
    const view = await t.handlers.reserveSlots({});
    expect(view.availableSlots['claude-code']).toBe(0);
    expect(view.heldBatches.find((b) => b.grantId === old.grantId)?.counts['claude-code']).toBe(1);
    expect(ledgerTypes(t).map((r) => [r.type, r.sessionId])).toEqual([['slot_reserve', S1]]);
  });

  it('a Cancel routed to a fresh supervisor before its launch arrives means no worktree, native create or prompt afterwards', async () => {
    const t = setup();
    const native = { request: (method, params) => t.handlers[method](params) };
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ff-slots-journal-')));
    roots.push(dir);
    const config = { serverUrl: 'http://127.0.0.1:4000', repositories: { repo: join(t.base, 'repo') }, profiles: [claude], capacity: { 'claude-code': 1, codex: 1 }, integrations: { paseo: { enabled: false, savedProfileIds: [], home: null, cliPath: null } }, paseo: { home: null, cliPath: null } };
    const executor = createExecutor({ config, adapter: null, native, journal: createJournal({ dir }), catalogProfiles: [], paseoProfiles: [], log: () => {} });
    const cancel = await executor.execute({ id: '55555555-5555-4555-8555-555555555555', runId: RUN, sessionId: S1, kind: 'cancel', payload: { kind: 'cancel' }, nativeBackend: 'claude-code' });
    expect(cancel).toMatchObject({ state: 'applied', result: { dispatched: false } });
    const launchCommand = { id: '66666666-6666-4666-8666-666666666666', runId: RUN, sessionId: S1, kind: 'launch', slotGranted: true,
      payload: { repositoryKey: 'repo', profileId: 'cc-main', model: 'm-a', prompt: 'Do it.', workspace: { mode: 'worktree', branchName: `ff/run-${RUN}`, baseRef: 'main' }, reportingCredential: 'reporting-credential', execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: REV } } };
    expect(await executor.execute(launchCommand)).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    const reopened = createSupervisorHandlers({ ledger: createLedger({ dir: t.ledgerDir }), profiles: [claude], backends: { 'claude-code': t.backend }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: { repo: join(t.base, 'repo') }, limits: { 'claude-code': 1, codex: 1 } });
    const again = createExecutor({ config, adapter: null, native: { request: (method, params) => reopened[method](params) }, journal: createJournal({ dir }), catalogProfiles: [], paseoProfiles: [], log: () => {} });
    expect(await again.execute(launchCommand)).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.backend.opened).toEqual([]);
    expect(readFileSync(join(t.ledgerDir, 'ledger.jsonl'), 'utf8')).not.toMatch(/"effect":"(create_worktree|create_native_session|prompt)"/);
  });
});
