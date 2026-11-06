import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLedger } from '../../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../../src/supervisor/supervisor.js';
import { ContainmentError } from '../../../../src/supervisor/containment.js';
import { readProcessIdentity } from '../../../../src/supervisor/process-identity.js';
import { createSpoolPrivacy } from '../../../../src/supervisor/spool-privacy.js';
import { profileRevision } from '../../../../src/connector/catalog.js';

const roots = [];
export function cleanupRoots() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export const RUN = '11111111-1111-4111-8111-111111111111';
export const S1 = '22222222-2222-4222-8222-222222222222';
export const S2 = '33333333-3333-4333-8333-333333333333';
export const claude = { id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx', model: 'm-a', policy: { permissionMode: 'manual' }, summaryProfileId: undefined, complete: true, problems: [] };
export const REV = profileRevision(claude, '2.1.317');
export const SESSION_CAPS = { 'claude-code': 4, codex: 4 };
export const flush = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

export function gitRepo(base) {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return repo;
}

export function memoryContainment({ stuck = false } = {}) {
  const leaves = new Map();
  const kills = [];
  const children = [];
  const scopePath = '/mem/ff-0123456789abcdef';
  const leafPath = ({ generation, sessionId }) => `${scopePath}/w-${generation}-${sessionId}`;
  return {
    kills,
    leaves,
    children,
    containment: {
      state: 'verified',
      scopePath,
      ops: {
        leafPath,
        createWorker({ generation, sessionId }) { const p = leafPath({ generation, sessionId }); leaves.set(p, { populated: false }); return p; },
        async spawn({ cgroupPath }) {
          leaves.get(cgroupPath).populated = true;
          const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
          children.push({ cgroupPath, child });
          return { child, identity: await readProcessIdentity(process.pid) };
        },
        leaf({ cgroupPath, generation, sessionId }) {
          if (cgroupPath !== leafPath({ generation, sessionId })) throw new ContainmentError('not_owned_leaf', 'not this leaf');
          if (!leaves.has(cgroupPath)) throw new ContainmentError('leaf_missing', 'gone');
          return cgroupPath;
        },
        async read({ cgroupPath }) { const l = leaves.get(cgroupPath); return { populated: l.populated, ...(l.pids ? { pids: l.pids } : {}) }; },
        async kill({ cgroupPath }) { kills.push(cgroupPath); if (!stuck) leaves.get(cgroupPath).populated = false; },
      },
    },
  };
}

export function queue() {
  const items = [];
  let wake = null;
  let ended = false;
  let thrown = null;
  return {
    push(item) { items.push(item); wake?.(); },
    end() { ended = true; wake?.(); },
    fail(err) { thrown = err; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (thrown) throw thrown;
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

export function fakeBackend(id, behavior = {}) {
  const opened = [];
  const workers = [];
  return {
    id,
    opened,
    workers,
    readinessState: 'ready',
    async readiness() { return { state: this.readinessState }; },
    async open(opts) {
      opened.push(opts);
      const nativeId = opts.resume?.nativeSessionId ?? `native-${opts.sessionId}`;
      const resumed = opts.resume !== null && opts.resume !== undefined;
      if (resumed && opts.resume.bound === false && behavior.resumeNotFound) await opts.effects.absent({ nativeSessionId: behavior.absentId ?? nativeId, evidence: 'resume_not_found' });
      const creating = !resumed || (opts.resume.bound === false && behavior.resumeNotFound);
      if (creating) await opts.effects.barrier('create_native_session', id === 'claude-code' ? { uuid: opts.resume?.nativeSessionId ?? opts.sessionId } : {});
      const { child, identity } = await opts.spawn({ executable: opts.profile.executable, args: ['--session', opts.sessionId], env: {}, cwd: opts.workspaceDir });
      if (behavior.open === 'lost_create' && !resumed) throw Object.assign(new Error('lost create'), { code: 'reconciling' });
      if (!resumed || opts.resume.bound === false) await opts.effects.bind(nativeId);
      const events = queue();
      const worker = {
        nativeSessionId: nativeId,
        identity: { ...identity, pgid: child.pid, cgroup: '/unit' },
        events,
        sends: [],
        responds: [],
        interrupts: [],
        stopOwned: opts.stopOwned,
        emit: (e) => events.push(e),
        pending: () => [],
        ...('idle' in behavior ? { idle: () => behavior.idle } : {}),
        async send({ commandId, text, mode, barrier }) {
          if (behavior.sendError) {
            if (!behavior.sendError.beforeBarrier) await barrier({});
            throw Object.assign(new Error(behavior.sendError.reason), { code: behavior.sendError.code, reason: behavior.sendError.reason });
          }
          if (behavior.send === 'suppressed') {
            await barrier({});
            return { receipt: { uuid: commandId, state: 'cancelled', dispatched: false } };
          }
          if (behavior.send === 'reconciling_after_write') {
            await barrier({});
            throw Object.assign(new Error('lost'), { code: 'reconciling' });
          }
          await barrier({});
          worker.sends.push({ commandId, text, mode });
          return { receipt: { uuid: commandId, state: 'replayed', dispatched: true } };
        },
        async respond({ commandId, nativeRequestId, response, source, barrier }) {
          if (behavior.respond === 'withdrawn') {
            await barrier({ nativeRequestId, source, requestKind: 'question', operation: 'answer' });
            return { state: 'failed', errorCode: 'request_unavailable' };
          }
          await barrier({ nativeRequestId, source, requestKind: 'permission', operation: response.behavior === 'deny' ? 'decline' : 'answer' });
          worker.responds.push({ commandId, nativeRequestId, response, source });
          return { state: 'dispatched' };
        },
        async interrupt({ commandId, barrier }) {
          await barrier({});
          worker.interrupts.push(commandId);
          return { receipt: { cancelled: [] }, terminal: 'interruptTerminal' in behavior ? behavior.interruptTerminal : 'interrupted', settled: behavior.settled ?? [], dispatched: true };
        },
        closedFor: [],
        async close({ reason } = {}) { worker.closedFor.push(reason); events.end(); },
      };
      workers.push(worker);
      return worker;
    },
  };
}

export function setup({ backend = fakeBackend('claude-code'), mem = memoryContainment(), ledgerDir, profiles = [claude], privacy = createSpoolPrivacy(), limits = SESSION_CAPS, controlPlaneOnline = true } = {}) {
  profiles = [...profiles];
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-dispatch-')));
  roots.push(base);
  const repo = gitRepo(base);
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  const dir = ledgerDir ?? join(stateDir, 'supervisor');
  const ledger = createLedger({ dir });
  const logs = [];
  const handlers = createSupervisorHandlers({ ledger, profiles, backends: { [backend.id]: backend }, containment: mem.containment, log: (l) => logs.push(l), stateDir, repositories: { repo }, privacy, stopTimeoutMs: 300, limits });
  if (controlPlaneOnline) {
    handlers.connectorAttached({}, { role: 'connector', connectorEpoch: 0 });
    handlers.controlPlaneStatus({ online: true }, { role: 'connector', connectorEpoch: 0 });
  }
  return { base, repo, stateDir, ledger, handlers, backend, mem, logs, dir, privacy, profiles };
}

export const launch = (over = {}) => ({ commandId: 'launch-1', digest: 'd-launch-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'launch', profileId: 'cc-main', profileRevision: REV, repositoryKey: 'repo', branchName: `ff/run-${RUN}`, baseRef: 'main', role: 'work', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' }, ...over });
export const ledgerLines = (dir) => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
