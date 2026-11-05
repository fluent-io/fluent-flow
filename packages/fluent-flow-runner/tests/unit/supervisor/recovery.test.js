import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodeFs, { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { workerLeaf } from '../../../src/supervisor/containment.js';
import { isLive, readBootId, readProcessDetails, readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { detectEscapes, recoverOnStart } from '../../../src/supervisor/recovery.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { createSpoolPrivacy } from '../../../src/supervisor/spool-privacy.js';
import { cleanupRoots, RUN, S1, S2, REV, fakeBackend, memoryContainment, setup, launch, ledgerLines } from './helpers/dispatch-fakes.js';

let root;
let scope;
let otherScope;
let supDir;
let ledger;
let bootId;
const sleepers = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ff-recovery-'));
  scope = join(root, 'cg', 'ff-1111111111111111');
  otherScope = join(root, 'cg', 'ff-2222222222222222');
  mkdirSync(scope, { recursive: true });
  mkdirSync(otherScope, { recursive: true });
  supDir = join(root, 'sup');
  mkdirSync(supDir, { mode: 0o700 });
  ledger = createLedger({ dir: supDir });
  bootId = await readBootId();
});
afterEach(() => {
  for (const child of sleepers.splice(0)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  rmSync(root, { recursive: true, force: true });
});

async function sleeper() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  sleepers.push(child);
  await new Promise((r) => child.once('spawn', r));
  for (let i = 0; i < 50; i += 1) {
    const id = await readProcessIdentity(child.pid);
    if (id) return { child, identity: id };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('sleeper identity unreadable');
}

function leaf(dir, name, populated = true) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'cgroup.procs'), '');
  writeFileSync(join(path, 'cgroup.events'), `populated ${populated ? 1 : 0}\nfrozen 0\n`);
  writeFileSync(join(path, 'cgroup.kill'), '');
  return path;
}
const killed = (path) => readFileSync(join(path, 'cgroup.kill'), 'utf8');

function fakeKernel({ members = new Map() } = {}) {
  const terminated = [];
  return {
    terminated,
    containment: {
      state: 'verified',
      scopePath: scope,
      ops: {
        leaf: ({ cgroupPath, generation, sessionId }) => workerLeaf({ scopePath: scope, cgroupPath, generation, sessionId }),
        async read({ cgroupPath }) {
          if (!existsSync(cgroupPath)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
          const member = members.get(cgroupPath);
          if (member) return { populated: await isLive(member), pids: [] };
          return { populated: /^populated 1$/m.test(readFileSync(join(cgroupPath, 'cgroup.events'), 'utf8')), pids: [] };
        },
        async kill({ cgroupPath, generation, sessionId }) {
          const path = workerLeaf({ scopePath: scope, cgroupPath, generation, sessionId });
          writeFileSync(join(path, 'cgroup.kill'), '1');
          const member = members.get(path);
          if (member) process.kill(-member.pid, 'SIGKILL');
          else writeFileSync(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        },
      },
    },
  };
}

const accept = (commandId, sessionId, runId = 'run-1', backend = 'codex') => ({ commandId, digest: `d-${commandId}`, runId, sessionId, backend, kind: 'launch' });
function recordWorker(sessionId, generation, cgroupPath, identity, runId = 'run-1') {
  ledger.recordWorkerIntent({ sessionId, runId, backend: 'codex', generation, cgroupPath });
  if (identity) ledger.recordWorker({ sessionId, generation, identity });
}
function promptInFlight(commandId, sessionId, generation) {
  ledger.submit(accept(commandId, sessionId));
  ledger.barrier(commandId, { effect: 'create_native_session', generation, ref: {} });
  ledger.bind({ sessionId, runId: 'run-1', backend: 'codex', nativeSessionId: `native-${sessionId}`, generation, workspaceDir: '/w' });
  ledger.outcome(commandId, { state: 'accepted' });
  ledger.barrier(commandId, { effect: 'prompt', generation, ref: {} });
}
const lines = () => readFileSync(join(supDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('recoverOnStart', () => {
  it('a recorded populated cgroup is quiesced before anything is restored', async () => {
    const { child, identity } = await sleeper();
    const path = leaf(scope, 'w-1-s1');
    recordWorker('s1', 1, path, { ...identity, pgid: child.pid });
    promptInFlight('c1', 's1', 1);
    const kernel = fakeKernel({ members: new Map([[path, identity]]) });
    const report = await recoverOnStart({ ledger, containment: kernel.containment, bootId });
    expect(await isLive(identity)).toBe(false);
    expect(report.workers).toEqual([expect.objectContaining({ sessionId: 's1', generation: 1, result: 'quiesced' })]);
    expect(report.commands).toEqual([{ commandId: 'c1', state: 'reconciling' }]);
    const recorded = lines();
    const stopAt = recorded.findIndex((r) => r.type === 'worker_exit' && r.exit.kind === 'recovery_stop' && r.exit.stop === 'quiesced');
    const outcomeAt = recorded.findIndex((r) => r.type === 'outcome' && r.commandId === 'c1' && r.state === 'reconciling');
    expect(stopAt).toBeGreaterThan(-1);
    expect(outcomeAt).toBeGreaterThan(stopAt);
    expect(ledger.eventsAfter(0).map((e) => e.payload.event)).toEqual([expect.objectContaining({ state: 'reconciling', errorCode: 'reconciling' })]);
  });

  it('an unverifiable recorded cgroup leaves the run reconciling with no signal', async () => {
    const { identity } = await sleeper();
    const foreign = leaf(otherScope, 'w-1-s1');
    recordWorker('s1', 1, foreign, identity);
    promptInFlight('c1', 's1', 1);
    const kernel = fakeKernel();
    const report = await recoverOnStart({ ledger, containment: kernel.containment, bootId });
    expect(report.workers).toEqual([expect.objectContaining({ sessionId: 's1', result: 'reconciling' })]);
    expect(report.commands).toEqual([{ commandId: 'c1', state: 'reconciling' }]);
    expect(killed(foreign)).toBe('');
    expect(await isLive(identity)).toBe(true);
    expect(ledger.commandRecord('c1').outcome).toMatchObject({ state: 'reconciling' });
  });

  it('an owned leaf whose populated state cannot be read is reconciling and never killed', async () => {
    const { identity } = await sleeper();
    const path = leaf(scope, 'w-1-s1', true);
    recordWorker('s1', 1, path, identity);
    const kernel = fakeKernel();
    kernel.containment.ops.read = async () => ({ populated: null, pids: [] });
    const report = await recoverOnStart({ ledger, containment: kernel.containment, bootId });
    expect(report.workers).toEqual([expect.objectContaining({ sessionId: 's1', result: 'reconciling', reason: 'populated_unknown' })]);
    expect(killed(path)).toBe('');
    expect(await isLive(identity)).toBe(true);
  });

  it('a reused PID with other startTicks is never signalled', async () => {
    const { identity } = await sleeper();
    const path = leaf(scope, 'w-1-s1', false);
    recordWorker('s1', 1, path, { ...identity, startTicks: identity.startTicks + 1 });
    const missingLeaf = join(scope, 'w-2-s2');
    recordWorker('s2', 2, missingLeaf, { ...identity, startTicks: identity.startTicks + 2 });
    const kernel = fakeKernel();
    const report = await recoverOnStart({ ledger, containment: kernel.containment, bootId });
    expect(await isLive(identity)).toBe(true);
    expect(killed(path)).toBe('');
    expect(report.workers.map((w) => w.result)).toEqual(['empty', 'empty']);
  });

  it('a boot-id change marks uncertain barriers reconciling without signals', async () => {
    const { identity } = await sleeper();
    const path = leaf(scope, 'w-1-s1', true);
    recordWorker('s1', 1, path, { ...identity, bootId: 'previous-boot' });
    promptInFlight('c1', 's1', 1);
    const kernel = fakeKernel();
    const report = await recoverOnStart({ ledger, containment: kernel.containment, bootId });
    expect(report.workers).toEqual([expect.objectContaining({ sessionId: 's1', result: 'reconciling', reason: 'boot_changed' })]);
    expect(report.commands).toEqual([{ commandId: 'c1', state: 'reconciling' }]);
    expect(killed(path)).toBe('');
    expect(await isLive(identity)).toBe(true);
  });

  it('ENOSPC stops admission and preserves the ledger', async () => {
    let armed = false;
    const fs = { ...nodeFs, fsyncSync: (fd) => {
      if (armed) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return nodeFs.fsyncSync(fd);
    } };
    mkdirSync(join(root, 'sup2'), { mode: 0o700 });
    const failing = createLedger({ dir: join(root, 'sup2'), fs });
    failing.submit(accept('c1', 's1'));
    failing.barrier('c1', { effect: 'create_native_session', generation: 1, ref: {} });
    const before = readFileSync(join(root, 'sup2', 'ledger.jsonl'), 'utf8');
    armed = true;
    const report = await recoverOnStart({ ledger: failing, containment: fakeKernel().containment, bootId });
    expect(report.admission).toBe('stopped');
    expect(report.errorCode).toBe('startup_failed');
    expect(failing.admissionStopped).toBe(true);
    expect(readFileSync(join(root, 'sup2', 'ledger.jsonl'), 'utf8').startsWith(before)).toBe(true);
    armed = false;
    expect(createLedger({ dir: join(root, 'sup2') }).classify('c1')).toEqual({ create_native_session: 'uncertain' });
  });

  it('FF positive no-write evidence resolves exactly its own barrier', async () => {
    promptInFlight('c1', 's1', 1);
    ledger.receipt('c1', { effect: 'prompt', evidence: {} });
    ledger.submit({ commandId: 'p2', digest: 'd', runId: 'run-1', sessionId: 's1', backend: 'codex', kind: 'prompt' });
    ledger.barrier('p2', { effect: 'prompt', generation: 1, ref: {} });
    ledger.recordNoWrite('p2', { effect: 'prompt', generation: 1, sessionId: 's1', backend: 'codex', evidence: 'ff_suppressed' });
    ledger.submit({ commandId: 'p3', digest: 'd', runId: 'run-1', sessionId: 's1', backend: 'codex', kind: 'prompt' });
    ledger.barrier('p3', { effect: 'prompt', generation: 1, ref: {} });
    const report = await recoverOnStart({ ledger, containment: fakeKernel().containment, bootId });
    expect(ledger.classify('p2')).toEqual({ prompt: 'resolved' });
    expect(ledger.classify('p3')).toEqual({ prompt: 'uncertain' });
    expect(report.commands).toEqual([{ commandId: 'p2', state: 'resolved' }, { commandId: 'p3', state: 'reconciling' }]);
    expect(ledger.commandRecord('p2').receipts).toEqual([]);
  });

  it('a worker that ended on its own mid-turn leaves the session reconciling; a finished turn does not', async () => {
    for (const finished of [false, true]) {
      const dir = join(root, `turn-${finished}`);
      mkdirSync(dir, { mode: 0o700 });
      ledger = createLedger({ dir });
      const { identity } = await sleeper();
      recordWorker('s1', 1, join(scope, 'w-1-s1'), { ...identity, startTicks: identity.startTicks + 9 });
      promptInFlight('c1', 's1', 1);
      ledger.receipt('c1', { effect: 'prompt', evidence: {} });
      ledger.outcome('c1', { state: 'applied' });
      if (finished) ledger.appendEvent({ sessionId: 's1', runId: 'run-1', generation: 1, kind: 'state', nativeEventId: 'done', payload: { backend: 'codex', event: { state: 'completed' }, terminal: 'completed' } });
      const report = await recoverOnStart({ ledger, containment: fakeKernel().containment, bootId });
      expect(report.workers.map((w) => w.result)).toEqual(['empty']);
      const reconciling = ledger.eventsAfter(0).filter((e) => e.payload.event?.state === 'reconciling');
      expect(reconciling.map((e) => e.payload.event.reason)).toEqual(finished ? [] : ['turn_lost']);
    }
  });

  it('never respawns or replays: no barrier, bind or receipt is added', async () => {
    const path = leaf(scope, 'w-1-s1', false);
    recordWorker('s1', 1, path, null);
    promptInFlight('c1', 's1', 1);
    await recoverOnStart({ ledger, containment: fakeKernel().containment, bootId });
    const types = lines().map((r) => r.type);
    expect(types.filter((t) => ['barrier', 'bind', 'receipt', 'worker_intent'].includes(t))).toEqual(['worker_intent', 'barrier', 'bind', 'barrier']);
  });
});

describe('detectEscapes', () => {
  it('an observed identity alive outside the scope is descendants_escaped', async () => {
    const { identity } = await sleeper();
    const details = await readProcessDetails(identity.pid);
    const outside = { scopePath: join('/sys/fs/cgroup', 'nowhere', 'ff-1111111111111111') };
    const inside = { scopePath: join('/sys/fs/cgroup', details.cgroup) };
    expect(detectEscapes({ observed: [identity], containment: outside })).toEqual([{ identity, code: 'descendants_escaped' }]);
    expect(detectEscapes({ observed: [identity], containment: inside })).toEqual([]);
    expect(detectEscapes({ observed: [{ ...identity, startTicks: identity.startTicks + 1 }], containment: outside })).toEqual([]);
    expect(detectEscapes({ observed: [{ ...identity, bootId: 'previous-boot' }], containment: outside })).toEqual([]);
  });

  it('a gone process is not an escape', () => {
    expect(detectEscapes({ observed: [{ pid: 2 ** 22 + 7, startTicks: 1, bootId: 'x' }], containment: { scopePath: '/sys/fs/cgroup/ff-1111111111111111' } })).toEqual([]);
  });
});


const until = async (check, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};
const spooled = (t) => t.ledger.eventsAfter(0).map((e) => ({ id: e.nativeEventId, generation: e.generation, ...e.payload.event }));
const cancel = (commandId, over = {}) => ({ commandId, digest: `d-${commandId}`, runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel', ...over });
const RUN2 = '44444444-4444-4444-8444-444444444444';

function lostCreateEarlierLifetime(mem) {
  const first = setup({ backend: fakeBackend('claude-code', { open: 'lost_create' }), mem });
  return first;
}
function nextLifetime(t, { backend = fakeBackend('claude-code'), mem = t.mem } = {}) {
  const ledger2 = createLedger({ dir: t.dir });
  const logs = [];
  const handlers = createSupervisorHandlers({ ledger: ledger2, profiles: t.profiles, backends: { [backend.id]: backend }, containment: mem.containment, log: (l) => logs.push(l), stateDir: t.stateDir, repositories: { repo: t.repo }, privacy: createSpoolPrivacy(), stopTimeoutMs: 300, limits: { 'claude-code': 1, codex: 1 } });
  handlers.connectorAttached({}, { role: 'connector', connectorEpoch: 0 });
  handlers.controlPlaneStatus({ online: true }, { role: 'connector', connectorEpoch: 0 });
  return { ...t, ledger: ledger2, handlers, backend, logs };
}

describe('supervisor lifecycle (Task 11)', () => {
  afterEach(cleanupRoots);

  it('worker death expires that generation\'s requests and reconciles once its leaf is quiesced', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' });
    const { child, cgroupPath } = t.mem.children[0];
    child.emit('exit', null, 'SIGKILL');
    expect(await until(() => spooled(t).some((e) => e.reason === 'worker_lost'))).toBe(true);
    expect(t.mem.kills).toEqual([cgroupPath]);
    expect(spooled(t).filter((e) => e.reason === 'worker_lost')).toEqual([expect.objectContaining({ state: 'reconciling', errorCode: 'reconciling', generation: 1 })]);
    const answer = await t.handlers.submit({ commandId: 'perm-1', digest: 'dp', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'permission', nativeRequestId: 'req-1', generation: 1, response: { behavior: 'allow' } });
    expect(answer).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.ledger.commandRecord('perm-1').barriers).toEqual([]);
    expect((await t.handlers.pendingQuestions()).requests).toEqual([]);
    expect(t.backend.opened).toHaveLength(1);
  });

  it('explicit continuation after a closed lost worker resumes the exact session without replay', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' });
    t.mem.children[0].child.emit('exit', null, 'SIGKILL');
    expect(await until(() => spooled(t).some((e) => e.reason === 'worker_lost'))).toBe(true);
    const prompt = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'Continue.', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } };
    expect(await t.handlers.submit(prompt)).toEqual({ state: 'applied' });
    expect(t.backend.opened).toHaveLength(2);
    expect(t.backend.opened[1]).toMatchObject({ sessionId: S1, generation: 2, resume: { nativeSessionId: `native-${S1}`, bound: true } });
    expect(t.backend.workers[1].sends).toEqual([{ commandId: 'prompt-2', text: 'Continue.', mode: 'start' }]);
    expect(t.backend.workers[0].sends).toEqual([{ commandId: 'launch-1', text: 'Do it.', mode: 'start' }]);
  });

  it('C5: an explicit continuation closes the lost generation\'s open commands after quiescence and writes only its own prompt', async () => {
    const t = setup({ backend: fakeBackend('claude-code', { send: 'reconciling_after_write' }) });
    await t.handlers.submit(launch());
    expect(await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    const { child, cgroupPath } = t.mem.children[0];
    child.emit('exit', null, 'SIGKILL');
    expect(await until(() => spooled(t).some((e) => e.reason === 'worker_lost'))).toBe(true);
    t.backend.workers[0].sends.length = 0;
    const next = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'Continue.', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } };
    const cont = createSupervisorHandlers({ ledger: t.ledger, profiles: t.profiles, backends: { 'claude-code': fakeBackend('claude-code') }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: { repo: t.repo }, stopTimeoutMs: 300, limits: { 'claude-code': 4, codex: 4 } });
    expect(cont.connectorAttached({}, { connectorEpoch: 0 })).toEqual({ attached: true });
    expect(cont.controlPlaneStatus({ online: true }, { connectorEpoch: 0 })).toEqual({ recorded: true });
    expect(await cont.submit(next)).toEqual({ state: 'applied' });
    const c1 = t.ledger.commandRecord('launch-1');
    expect(c1.closure).toMatchObject({ by: 'prompt-2', stop: 'quiesced', evidence: { promptBarrier: true, promptReceipt: false } });
    expect(c1.resolutions).toEqual([expect.objectContaining({ effect: 'prompt', kind: 'operator_closed', by: 'prompt-2' })]);
    expect(c1.receipts.map((r) => r.effect)).toEqual(['create_worktree']);
    expect(t.mem.kills).toEqual([cgroupPath]);
    const lines = ledgerLines(t.dir);
    expect(lines.findIndex((r) => r.type === 'closure')).toBeLessThan(lines.findIndex((r) => r.type === 'worker_intent' && r.generation === 2));
    expect(lines.filter((r) => r.type === 'barrier' && r.commandId === 'prompt-2').map((r) => r.effect)).toEqual(['prompt']);
    expect(lines.filter((r) => r.type === 'bind')).toHaveLength(1);
  });

  it('C5: the reopened generation is spooled as a binding before its prompt, and a second loss of that generation is ordered after it', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' });
    t.mem.children[0].child.emit('exit', null, 'SIGKILL');
    expect(await until(() => spooled(t).some((e) => e.reason === 'worker_lost' && e.generation === 1))).toBe(true);
    const lostWorker = t.backend.workers[0];
    expect(lostWorker.closedFor).toEqual(['worker_lost']);
    const next = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'Continue.', behavior: 'steer', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } };
    expect(await t.handlers.submit(next)).toEqual({ state: 'applied' });
    expect(t.backend.workers[1].sends).toEqual([{ commandId: 'prompt-2', text: 'Continue.', mode: 'start' }]);
    const lines = ledgerLines(t.dir);
    const bindingAt = lines.findIndex((r) => r.type === 'event' && r.kind === 'binding');
    const promptAt = lines.findIndex((r) => r.type === 'barrier' && r.commandId === 'prompt-2' && r.effect === 'prompt');
    expect(bindingAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(bindingAt);
    expect(lines[bindingAt]).toMatchObject({ sessionId: S1, generation: 2, nativeEventId: 'ff:binding:2', payload: { backend: 'claude-code', event: { nativeSessionId: `native-${S1}`, generation: 2 } } });
    t.mem.children[1].child.emit('exit', null, 'SIGKILL');
    expect(await until(() => spooled(t).some((e) => e.reason === 'worker_lost' && e.generation === 2))).toBe(true);
    const events = t.ledger.eventsAfter(0);
    const bindingSeq = events.find((e) => e.kind === 'binding').seq;
    const lostSeq = events.find((e) => e.nativeEventId === 'ff:worker_lost:2').seq;
    expect(lostSeq).toBeGreaterThan(bindingSeq);
  });

  it('a steer to a positively idle live worker starts a new turn; a steer into an active turn stays a native steer', async () => {
    for (const [idle, mode] of [[true, 'start'], [false, 'steer']]) {
      const t = setup({ backend: fakeBackend('claude-code', { idle }) });
      await t.handlers.submit(launch());
      await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' });
      const follow = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'More.', behavior: 'steer' };
      expect(await t.handlers.submit(follow)).toEqual({ state: 'applied' });
      expect(t.backend.workers[0].sends.at(-1)).toEqual({ commandId: 'prompt-2', text: 'More.', mode });
      expect(t.backend.opened).toHaveLength(1);
    }
  });

  it('C1: a same-UUID recreation records exact native absence for the original create before its own create barrier', async () => {
    const first = lostCreateEarlierLifetime(memoryContainment());
    expect(await first.handlers.submit(launch())).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    const backend = fakeBackend('claude-code', { resumeNotFound: true });
    const t = nextLifetime(first, { backend });
    const next = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'Start over.', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } };
    expect(await t.handlers.submit(next)).toEqual({ state: 'applied' });
    expect(backend.opened[0]).toMatchObject({ generation: 2, resume: { nativeSessionId: S1, bound: false } });
    const lines = ledgerLines(t.dir);
    const absentAt = lines.findIndex((r) => r.type === 'resolution' && r.commandId === 'launch-1' && r.kind === 'native_absent');
    const createAt = lines.findIndex((r) => r.type === 'barrier' && r.commandId === 'prompt-2' && r.effect === 'create_native_session');
    expect(absentAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(absentAt);
    expect(lines[absentAt]).toMatchObject({ effect: 'create_native_session', generation: 1, by: 'prompt-2', evidence: { nativeSessionId: S1, source: 'claude_resume_not_found', generation: 2 } });
    expect(t.ledger.classify('launch-1')).toEqual({ create_worktree: 'receipted', create_native_session: 'resolved' });
    expect(t.ledger.commandRecord('launch-1').barriers.map((b) => b.effect)).toEqual(['create_worktree', 'create_native_session']);
    expect(lines.filter((r) => r.type === 'bind')).toEqual([expect.objectContaining({ nativeSessionId: S1, generation: 2 })]);
    expect(backend.workers[0].sends).toEqual([{ commandId: 'prompt-2', text: 'Start over.', mode: 'start' }]);
  });

  it('C1: absence for another identity, or an old worker not proven quiescent, never recreates', async () => {
    const first = lostCreateEarlierLifetime(memoryContainment());
    await first.handlers.submit(launch());
    const foreign = fakeBackend('claude-code', { resumeNotFound: true, absentId: '99999999-9999-4999-8999-999999999999' });
    const t = nextLifetime(first, { backend: foreign });
    const next = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'x', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'c' } };
    expect(await t.handlers.submit(next)).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(ledgerLines(t.dir).some((r) => r.type === 'barrier' && r.commandId === 'prompt-2' && r.effect === 'create_native_session')).toBe(false);
    expect(t.ledger.classify('launch-1').create_native_session).toBe('uncertain');
    const stuck = lostCreateEarlierLifetime(memoryContainment({ stuck: true }));
    await stuck.handlers.submit(launch());
    const backend = fakeBackend('claude-code', { resumeNotFound: true });
    const u = nextLifetime(stuck, { backend });
    expect(await u.handlers.submit({ ...next, commandId: 'prompt-3', digest: 'd3' })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(backend.opened).toEqual([]);
    expect(u.ledger.commandRecord('launch-1').closure).toBeNull();
  });

  it('C6: a supervisor restart keeps durable reservations and an old poll grant never admits past the cap', async () => {
    const t = setup({ limits: { 'claude-code': 1, codex: 1 } });
    const offered = await t.handlers.reserveSlots({ notAfter: new Date(Date.now() + 60_000).toISOString() });
    expect(offered.availableSlots['claude-code']).toBe(1);
    const restarted = nextLifetime(t);
    const first = launch({ slotGranted: true, grantId: offered.grantId });
    expect(await restarted.handlers.submit(first)).toMatchObject({ state: 'accepted' });
    const second = launch({ commandId: 'launch-2', digest: 'd-2', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}`, slotGranted: true, grantId: offered.grantId });
    expect(await restarted.handlers.submit(second)).toEqual({ state: 'deferred' });
    expect(restarted.ledger.commandRecord('launch-2').barriers).toEqual([]);
    const again = nextLifetime(restarted);
    expect(again.ledger.slotHolders()).toEqual(new Map([[S1, 'claude-code']]));
    expect((await again.handlers.reserveSlots({})).availableSlots['claude-code']).toBe(0);
    expect(again.ledger.commandRecord('launch-2').outcome).toBeNull();
  });

  it('operator Cancel closes a bound but unadmitted session only after its old worker is quiesced', async () => {
    const first = lostCreateEarlierLifetime(memoryContainment());
    expect(await first.handlers.submit(launch())).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    first.ledger.bind({ sessionId: S1, runId: RUN, backend: 'claude-code', nativeSessionId: `native-${S1}`, generation: 1, workspaceDir: first.backend.opened[0].workspaceDir });
    const leafOf = first.mem.children[0].cgroupPath;
    expect(first.mem.leaves.get(leafOf).populated).toBe(true);
    const t = nextLifetime(first);
    const stuckLaunch = launch({ commandId: 'launch-other', digest: 'd-other', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}` });
    expect(await t.handlers.submit(stuckLaunch)).toEqual({ state: 'failed', errorCode: 'startup_failed' });
    const closed = await t.handlers.submit(cancel('cancel-1'));
    expect(closed).toEqual({ state: 'applied', closure: 'operator' });
    expect(t.mem.kills).toEqual([leafOf]);
    const c1 = t.ledger.commandRecord('launch-1');
    expect(c1.barriers.map((b) => b.effect)).toEqual(['create_worktree', 'create_native_session']);
    expect(c1.receipts.map((r) => r.effect)).toEqual(['create_worktree']);
    expect(c1.closure).toMatchObject({ by: 'cancel-1', sessionId: S1, backend: 'claude-code', stop: 'quiesced', evidence: { nativeSessionId: `native-${S1}`, promptBarrier: false } });
    expect(c1.outcome).toMatchObject({ state: 'reconciling' });
    expect(spooled(t).filter((e) => e.state === 'cancelled')).toEqual([expect.objectContaining({ id: 'ff:closure:cancel-1', closure: 'operator', cancelCommandId: 'cancel-1' })]);
    expect(t.backend.opened).toEqual([]);
    expect(t.ledger.slotHolders().has(S1)).toBe(false);
    expect(existsSync(first.backend.opened[0].workspaceDir)).toBe(true);
    expect(await t.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await t.handlers.submit(cancel('cancel-1'))).toEqual({ state: 'applied', closure: 'operator' });
    const fresh = launch({ commandId: 'launch-new', digest: 'd-new', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}` });
    expect(await t.handlers.submit(fresh)).toMatchObject({ state: 'accepted' });
    const t3 = nextLifetime(t);
    expect(await t3.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await t3.handlers.submit(cancel('cancel-1'))).toEqual({ state: 'applied', closure: 'operator' });
    expect(t3.backend.opened).toEqual([]);
  });

  it('an unprovable stop keeps the closure reconciling with no cancelled state and no admission release', async () => {
    const stuck = memoryContainment({ stuck: true });
    const first = lostCreateEarlierLifetime(stuck);
    await first.handlers.submit(launch());
    const t = nextLifetime(first);
    expect(await t.handlers.submit(cancel('cancel-1'))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(t.ledger.commandRecord('launch-1').closure).toBeNull();
    expect(spooled(t).some((e) => e.state === 'cancelled')).toBe(false);
    const other = launch({ commandId: 'launch-other', digest: 'd-other', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}` });
    expect(await t.handlers.submit(other)).toEqual({ state: 'failed', errorCode: 'startup_failed' });
  });

  it('a stopped ledger refuses a new command with startup_failed and records nothing', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    const before = readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8');
    let armed = false;
    const fs = { ...nodeFs, fsyncSync: (fd) => {
      if (armed) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return nodeFs.fsyncSync(fd);
    } };
    const stopped = createLedger({ dir: t.dir, fs });
    armed = true;
    const report = await recoverOnStart({ ledger: stopped, containment: t.mem.containment, bootId });
    expect(report.admission).toBe('stopped');
    armed = false;
    const later = createSupervisorHandlers({ ledger: stopped, profiles: t.profiles, backends: { 'claude-code': t.backend }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: { repo: t.repo } });
    const other = launch({ commandId: 'launch-2', digest: 'd-2', runId: RUN2, sessionId: S2, branchName: `ff/run-${RUN2}` });
    expect(await later.submit(other)).toEqual({ state: 'failed', errorCode: 'startup_failed' });
    expect(readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8').startsWith(before)).toBe(true);
    expect(readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8')).not.toContain('launch-2');
    expect((await later.status()).admissionStopped).toBe(true);
  });

  it('stop interrupts active turns with receipts, stops each worker and keeps worktrees', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do it.' });
    const dir = t.backend.opened[0].workspaceDir;
    expect(await t.handlers.stop({ scope: 'all', timeoutMs: 1_000 })).toEqual({ state: 'stopped' });
    expect(t.backend.workers[0].interrupts).toHaveLength(1);
    const interruptId = t.backend.workers[0].interrupts[0];
    expect(t.ledger.classify(interruptId)).toEqual({ interrupt: 'receipted' });
    expect(spooled(t).filter((e) => e.state === 'cancelled')).toEqual([expect.objectContaining({ cancelCommandId: interruptId })]);
    expect(t.mem.kills).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(t.dir, 'ledger.jsonl'))).toBe(true);
    const stuck = setup({ mem: memoryContainment({ stuck: true }) });
    await stuck.handlers.submit(launch());
    expect(await stuck.handlers.stop({ scope: 'all', timeoutMs: 200 })).toEqual({ state: 'uncertain' });
  });

  it('a descendant seen in the worker leaf and alive outside it makes the run reconciling and blocks wrap-up', async () => {
    const t = setup();
    const result = await t.handlers.submit(launch());
    const { identity } = await sleeper();
    const { cgroupPath } = t.mem.children[0];
    t.mem.leaves.get(cgroupPath).pids = [{ ...identity, pgid: identity.pid, cgroup: cgroupPath }];
    await t.handlers.status();
    t.mem.leaves.get(cgroupPath).pids = [];
    const check = await t.handlers.wrapupPreflight({ runId: RUN, repositoryKey: 'repo', workspaceRef: result.binding.workspaceRef });
    expect(check.blockers).toEqual(expect.arrayContaining([{ code: 'descendants_escaped' }]));
    expect(spooled(t).filter((e) => e.reason === 'descendants_escaped')).toEqual([expect.objectContaining({ state: 'reconciling', errorCode: 'reconciling' })]);
    expect((await t.handlers.status()).workers[0]).toMatchObject({ escaped: 1 });
  });
});

describe('test containment stand-in (C6 guard)', () => {
  it('lists exactly the members of the worker process group, as a full /proc scan would', async () => {
    const { testContainment } = await import('../../native/harness/test-containment.js');
    const tc = testContainment();
    const leafPath = tc.ops.createWorker({ generation: 1, sessionId: 'scan' });
    const { child } = await tc.ops.spawn({ cgroupPath: leafPath, executable: '/bin/sh', args: ['-c', 'sleep 30 & sleep 30 & wait'], env: { PATH: process.env.PATH }, cwd: tmpdir() });
    try {
      let read;
      for (let i = 0; i < 100; i += 1) {
        read = await tc.ops.read({ cgroupPath: leafPath });
        if (read.pids.length >= 3) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const full = [];
      for (const name of nodeFs.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(name)) continue;
        const details = await readProcessDetails(Number(name));
        if (details && details.pgid === child.pid) full.push(details.pid);
      }
      expect(read.populated).toBe(true);
      expect(read.pids.map((p) => p.pid).sort()).toEqual(full.sort());
      expect(read.pids.length).toBe(3);
    } finally {
      await tc.ops.kill({ cgroupPath: leafPath });
    }
  });
});

describe('same-generation respawn evidence (Task 11 C1)', () => {
  it('a worker generation records a second process identity only after its first process exited', () => {
    recordWorker('s1', 2, join(scope, 'w-2-s1'), { pid: 10, startTicks: 1, bootId });
    expect(() => ledger.recordWorker({ sessionId: 's1', generation: 2, identity: { pid: 11, startTicks: 2, bootId } })).toThrow(/already recorded/);
    ledger.recordWorkerExit({ sessionId: 's1', generation: 2, kind: 'child_exit', code: 1, signal: null });
    ledger.recordWorker({ sessionId: 's1', generation: 2, identity: { pid: 11, startTicks: 2, bootId } });
    const [w] = ledger.workers();
    expect(w).toMatchObject({ identity: { pid: 11, startTicks: 2 }, exit: null, needsRecovery: false });
    expect(createLedger({ dir: supDir }).workers()[0]).toMatchObject({ identity: { pid: 11 }, exit: null });
  });
});

describe('typed resolution evidence (Task 11 C1)', () => {
  it('a resolution with an extra, missing or wrongly typed evidence field is refused and nothing is written', () => {
    ledger.submit(accept('c1', 's1', 'run-1', 'claude-code'));
    ledger.barrier('c1', { effect: 'create_native_session', generation: 1, ref: { uuid: 's1' } });
    ledger.submit(accept('c2', 's1', 'run-1', 'claude-code'));
    const before = readFileSync(join(supDir, 'ledger.jsonl'), 'utf8');
    for (const evidence of [
      { nativeSessionId: 's1', source: 'claude_resume_not_found', generation: 2, answer: 'secret' },
      { nativeSessionId: 's1', source: 'claude_resume_not_found' },
      { nativeSessionId: 's1', source: 'guessed', generation: 2 },
      { nativeSessionId: 'other', source: 'claude_resume_not_found', generation: 2 },
      { nativeSessionId: 's1', source: 'claude_resume_not_found', generation: 1 },
    ]) {
      expect(() => ledger.recordResolution('c1', { effect: 'create_native_session', kind: 'native_absent', by: 'c2', evidence })).toThrow(/typed evidence|exact native session/);
    }
    expect(readFileSync(join(supDir, 'ledger.jsonl'), 'utf8')).toBe(before);
    ledger.recordResolution('c1', { effect: 'create_native_session', kind: 'native_absent', by: 'c2', evidence: { nativeSessionId: 's1', source: 'claude_resume_not_found', generation: 2 } });
    expect(ledger.classify('c1')).toEqual({ create_native_session: 'resolved' });
  });
});
