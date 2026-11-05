import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, symlinkSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers, worktreeUsers } from '../../../src/supervisor/supervisor.js';
import { readdir, readlink, stat } from 'node:fs/promises';
import { createIpcServer } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';
import { ensurePrivateDir } from '../../../src/supervisor/owner-lock.js';
import { createConnectorRuntime } from '../../../src/connector/runtime.js';
import { createJournal } from '../../../src/connector/journal.js';
import { loadConnectorConfig, loadLocalProfiles, loadRepositories } from '../../../src/connector/config.js';
import { profileRevision } from '../../../src/connector/catalog.js';
import { testContainment } from '../../native/harness/test-containment.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const BRANCH = `ff/run-${RUN}`;
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
const codes = (blockers) => (blockers ?? []).map((b) => b.code);

function queue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(item) { items.push(item); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

function processBackend() {
  const workers = [];
  const backend = {
    id: 'claude-code',
    workers,
    gate: null,
    cwd: null,
    async readiness() { return { state: 'ready' }; },
    async open(opts) {
      await backend.gate;
      await opts.effects.barrier('create_native_session', {});
      const { child, identity } = await opts.spawn({ executable: '/bin/sleep', args: ['1000'], env: { PATH: process.env.PATH ?? '' }, cwd: backend.cwd ?? opts.workspaceDir });
      const exited = new Promise((r) => child.once('exit', r));
      await opts.effects.bind(`native-${opts.sessionId}`);
      const events = queue();
      const state = { idle: true, pending: [] };
      const worker = {
        nativeSessionId: `native-${opts.sessionId}`,
        identity: { ...identity, pgid: child.pid, cgroup: 'test-containment' },
        events,
        state,
        child,
        pending: () => state.pending,
        idle: () => state.idle,
        async send({ barrier }) {
          await barrier({});
          return { receipt: { state: 'replayed', dispatched: true } };
        },
        async respond() { return { state: 'failed', errorCode: 'request_unavailable' }; },
        async interrupt({ barrier }) { await barrier({}); return { receipt: null, terminal: null, settled: [], dispatched: false }; },
        async close() {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await exited;
          events.end();
        },
      };
      workers.push(worker);
      return worker;
    },
  };
  return backend;
}

function scopedProcScan(pids, extra = {}) {
  return ({ directory }) => worktreeUsers({ directory, fsp: { readdir: async (path) => (path === '/proc' ? [...pids(), ...Object.keys(extra)] : extra[path.split('/')[2]]?.readdir?.(path) ?? readdir(path)), readlink: (path) => extra[path.split('/')[2]]?.readlink?.(path) ?? readlink(path), stat: (path) => extra[path.split('/')[2]]?.stat?.(path) ?? stat(path) } });
}

async function setup({ containment = testContainment(), stopTimeoutMs, extraProc = {}, remotes = 'origin', configure = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ff-native-wrapup-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const remote = join(root, 'remote.git');
  const mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '-q', '--bare', repo, remote]);
  execFileSync('git', ['clone', '-q', '--bare', repo, mirror]);
  if (remotes !== 'none') {
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'fetch', '-q', 'origin');
  }
  if (remotes === 'two' || remotes === 'pushDefault') git(repo, 'remote', 'add', 'mirror', mirror);
  if (remotes === 'pushDefault') git(repo, 'config', 'remote.pushDefault', 'mirror');
  configure?.({ repo, remote, mirror });
  mkdirSync(join(root, 'ctx'), { mode: 0o700 });
  chmodSync(join(root, 'ctx'), 0o700);
  writeFileSync(join(root, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, 'token'), 'ffh_native_wrapup\n', { mode: 0o600 });
  const file = join(root, 'connector.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', tokenFile: join(root, 'token'), instanceId: 'native-wrapup', repositories: { repo },
    profiles: [{ id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: join(root, 'tool'), contextDir: join(root, 'ctx'), model: 'claude-model-a', policy: { permissionMode: 'manual' } }] }));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  const backend = processBackend();
  const logs = [];
  const strays = [];
  containment.ops.worktreeUsers = scopedProcScan(() => [...backend.workers.map((w) => String(w.child.pid)), ...strays.map((p) => String(p.pid))], extraProc);
  cleanups.push(() => { for (const p of strays) { try { process.kill(p.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; } } });
  const killWorkers = () => {
    for (const w of backend.workers) {
      try { process.kill(-w.child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
  };
  cleanups.push(killWorkers);

  async function lifetime() {
    const ledger = createLedger({ dir: ensurePrivateDir(join(stateDir, 'supervisor')) });
    const handlers = createSupervisorHandlers({ ledger, profiles: loadLocalProfiles({ file }).profiles, backends: { 'claude-code': backend }, containment, log: (l) => logs.push(l), stateDir, repositories: loadRepositories({ file }), ...(stopTimeoutMs ? { stopTimeoutMs } : {}) });
    const server = createIpcServer({ instanceId: 'native-wrapup', stateDir, handlers, log: (l) => logs.push(l) });
    await server.listen();
    const client = await connectSupervisor({ instanceId: 'native-wrapup', stateDir, role: 'connector' });
    expect(await client.request('controlPlaneStatus', { online: true })).toEqual({ recorded: true });
    const runtime = await createConnectorRuntime({ config: loadConnectorConfig({ file }), journalDir: stateDir, supervisor: client, client: fakeClient(), log: (l) => logs.push(l) });
    const close = async () => {
      await runtime.close();
      await client.close();
      await server.close();
    };
    cleanups.push(close);
    return { ledger, handlers, server, client, runtime, close };
  }

  const life = await lifetime();
  const config = loadConnectorConfig({ file });
  const revision = profileRevision(config.profiles[0], '2.1.317');
  const launch = { id: randomUUID(), runId: RUN, sessionId: S1, kind: 'launch', payload: { execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: revision }, repositoryKey: 'repo', workspace: { branchName: BRANCH, baseRef: 'main' }, prompt: 'Do the task', reportingCredential: 'ffr_native_wrapup_credential' } };
  const bound = await life.runtime.executor.execute(launch);
  expect(bound.state, JSON.stringify(bound)).toBe('accepted');
  expect((await life.runtime.executor.complete(launch)).state).toBe('applied');
  const workspaceRef = bound.result.workspaceRef;
  const worktree = join(stateDir, 'worktrees', workspaceRef);
  return { root, repo, remote, mirror, stateDir, worktree, workspaceRef, backend, logs, strays, life, lifetime, killWorkers, revision };
}

function fakeClient() {
  return {
    register: async () => ({ connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 50 }),
    heartbeat: async () => ({ leaseEpoch: 1 }),
    poll: async () => ({ commands: [] }),
    observe: async (body) => ({ acceptedEventIds: body.events.map((e) => e.eventId) }),
    ack: async (_id, body) => ({ state: body.state }),
  };
}

async function preflight(runtime) {
  const result = await runtime.executor.execute({ id: randomUUID(), runId: RUN, sessionId: null, kind: 'wrapup_preflight', payload: {} });
  expect(result.state, JSON.stringify(result)).toBe('applied');
  return result;
}
const wrapup = (runtime, mode, preflightId = randomUUID()) => runtime.executor.execute({ id: randomUUID(), runId: RUN, sessionId: null, kind: 'wrapup', payload: { preflightId, mode } });
const pushBranch = (worktree) => git(worktree, 'push', '-q', '-u', 'origin', BRANCH);

describe('native wrap-up (Task 8)', () => {
  it('Task 11 C2: a worktree removed before its archive receipt is closed only as an unknown outcome, explicitly and stably', async () => {
    const t = await setup();
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    const head = git(t.worktree, 'rev-parse', 'HEAD').trim();
    t.life.ledger.recordArchiveAttempt({ runId: RUN, workspaceRef: t.workspaceRef, branch: BRANCH });
    git(t.repo, 'worktree', 'remove', t.worktree);
    await t.life.close();
    const later = await t.lifetime();
    const pre = await preflight(later.runtime);
    expect(codes(pre.result.blockers)).toEqual(expect.arrayContaining(['worktree_missing', 'archive_receipt_missing']));
    const resolved = await wrapup(later.runtime, 'archive_owned_workspace');
    expect(resolved).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(resolved.result.blockers)).toEqual(['archive_outcome_unknown']);
    const lines = () => readFileSync(join(t.stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines().filter((r) => r.type === 'archive_resolution')).toEqual([expect.objectContaining({ runId: RUN, workspaceRef: t.workspaceRef, outcome: 'unknown', evidence: { directoryMissing: true, worktreeRegistered: false, branchHead: head } })]);
    expect(lines().some((r) => r.type === 'worktree_archived')).toBe(false);
    expect(existsSync(t.worktree)).toBe(false);
    expect(git(t.repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(head);
    expect(codes((await wrapup(later.runtime, 'archive_owned_workspace')).result.blockers)).toEqual(['archive_outcome_unknown']);
    await later.close();
    const third = await t.lifetime();
    expect(codes((await wrapup(third.runtime, 'archive_owned_workspace')).result.blockers)).toEqual(['archive_outcome_unknown']);
    expect(codes((await preflight(third.runtime)).result.blockers)).toEqual(['archive_outcome_unknown']);
    expect(lines().filter((r) => r.type === 'archive_resolution')).toHaveLength(1);
    expect(await third.handlers.workspace({ runId: RUN })).toEqual({ workspaceDir: null });
    expect(existsSync(t.worktree)).toBe(false);
  });

  it('Task 11 C2: a missing worktree without a recorded attempt, or with unresolved work, is never closed', async () => {
    const t = await setup();
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    git(t.repo, 'worktree', 'remove', t.worktree);
    const noAttempt = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(noAttempt.result.blockers)).toContain('worktree_missing');
    expect(codes(noAttempt.result.blockers)).not.toContain('archive_outcome_unknown');
    const u = await setup();
    pushBranch(u.worktree);
    u.life.ledger.recordArchiveAttempt({ runId: RUN, workspaceRef: u.workspaceRef, branch: BRANCH });
    git(u.repo, 'worktree', 'remove', '--force', u.worktree);
    const busy = await wrapup(u.life.runtime, 'archive_owned_workspace');
    expect(codes(busy.result.blockers)).toContain('owned_activity');
    expect(codes(busy.result.blockers)).not.toContain('archive_outcome_unknown');
    const all = [t, u].flatMap((x) => readFileSync(join(x.stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    expect(all.some((r) => r.type === 'archive_resolution' || r.type === 'worktree_archived')).toBe(false);
  });

  it('unavailable containment blocks archive with descendants_unverifiable', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    containment.state = 'unavailable';
    const pre = await preflight(t.life.runtime);
    expect(pre.state).toBe('applied');
    expect(codes(pre.result.blockers)).toContain('descendants_unverifiable');
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(archived.result.blockers)).toContain('descendants_unverifiable');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a populated worker cgroup blocks archive with owned_activity', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    await t.life.close();
    const later = await t.lifetime();
    const pre = await preflight(later.runtime);
    expect(pre.state).toBe('applied');
    expect(codes(pre.result.blockers)).toContain('owned_activity');
    expect(codes(pre.result.blockers)).not.toContain('descendants_unverifiable');
    const archived = await wrapup(later.runtime, 'archive_owned_workspace');
    expect(archived).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(archived.result.blockers)).toContain('owned_activity');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a live idle worker whose cgroup holds only its own pid still blocks archive with owned_activity', async () => {
    const t = await setup();
    pushBranch(t.worktree);
    const [worker] = t.backend.workers;
    expect(worker.idle()).toBe(true);
    expect(worker.pending()).toEqual([]);
    const pre = await preflight(t.life.runtime);
    expect(pre.result.blockers).toContainEqual(expect.objectContaining({ code: 'owned_activity' }));
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(archived.result.blockers)).toContain('owned_activity');
    expect(archived.result.note).toBe('Worktree cleanup is blocked. Review the outstanding work.');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a live worker of this lifetime blocks archive even when its leaf reads empty', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    containment.ops.read = async () => ({ populated: false });
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toContain('owned_activity');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a closure whose owned stop cannot prove the leaf empty never counts as closed', async () => {
    const containment = testContainment();
    const t = await setup({ containment, stopTimeoutMs: 200 });
    pushBranch(t.worktree);
    containment.ops.read = async () => ({ populated: true });
    const closed = await wrapup(t.life.runtime, 'archive_sessions');
    expect(closed).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(closed.result.blockers)).toEqual(['descendants_unverifiable']);
    expect(closed.result.archivedSessions).toBe(0);
    expect(t.life.ledger.workers().find((w) => w.runId === RUN).exit).toMatchObject({ kind: 'owned_stop', reason: 'wrapup', stop: 'uncertain' });
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toContain('owned_activity');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('an escaped identity blocks archive', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    containment.ops.holds = async () => false;
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toContain('descendants_escaped');
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toContain('descendants_escaped');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a process whose cwd is inside the worktree blocks archive with worktree_in_use', async () => {
    const t = await setup();
    pushBranch(t.worktree);
    const closed = await wrapup(t.life.runtime, 'archive_sessions');
    expect(closed.state, JSON.stringify(closed)).toBe('applied');
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toEqual([]);
    const user = spawn('/bin/sleep', ['1000'], { cwd: join(t.worktree), stdio: 'ignore' });
    t.strays.push(user);
    await new Promise((r) => user.once('spawn', r));
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toEqual(['worktree_in_use']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['worktree_in_use']);
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a same-uid process whose /proc state cannot be read blocks archive as unverifiable', async () => {
    const denied = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const t = await setup({ extraProc: { 999999: { stat: async () => ({ uid: process.getuid() }), readlink: denied, readdir: denied } } });
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toEqual(['descendants_unverifiable']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['descendants_unverifiable']);
    expect(existsSync(t.worktree)).toBe(true);
    expect(t.logs).toContainEqual(expect.objectContaining({ msg: 'native wrap-up blocked', blockers: [{ code: 'descendants_unverifiable' }] }));
  });

  it('an admission already past the dispatch check when archive starts cannot leave its new worker behind a passing archive', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    let openGate;
    t.backend.gate = new Promise((r) => (openGate = r));
    t.backend.cwd = t.root;
    const S2 = '33333333-3333-4333-8333-333333333333';
    const second = { commandId: randomUUID(), digest: 'd-second', runId: RUN, sessionId: S2, backend: 'claude-code', kind: 'create_session', profileId: 'cc-main', profileRevision: t.revision, repositoryKey: 'repo', role: 'work', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'ffr_native_wrapup_credential_2' } };
    const created = t.life.handlers.submit(second);
    await new Promise((r) => setTimeout(r, 50));
    const read = containment.ops.read;
    let resume;
    let paused;
    const atPause = new Promise((r) => (paused = r));
    containment.ops.read = async (args) => {
      containment.ops.read = read;
      paused();
      await new Promise((r) => (resume = r));
      return read(args);
    };
    const archive = wrapup(t.life.runtime, 'archive_owned_workspace');
    await atPause;
    openGate();
    expect((await created).state).toBe('accepted');
    const delivered = await t.life.handlers.deliver({ commandId: second.commandId, digest: second.digest, text: 'A second session' });
    resume();
    const result = await archive;
    expect(result).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(existsSync(t.worktree)).toBe(true);
    const worker = t.backend.workers.find((w) => w.nativeSessionId === `native-${S2}`);
    if (delivered.state === 'applied') {
      expect(worker.child.exitCode).toBeNull();
      expect(codes(result.result.blockers)).toContain('owned_activity');
    } else {
      expect(delivered).toMatchObject({ state: 'failed', errorCode: 'request_unavailable' });
    }
  });

  it('archive requires the authorized upstream frozen at launch: a local backup, another remote, another ref or a changed push identity is refused at preflight and at archive (Task 8 fix 1)', async () => {
    const t = await setup();
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    const refused = async () => {
      const pre = await preflight(t.life.runtime);
      const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
      expect(existsSync(t.worktree)).toBe(true);
      return { pre: codes(pre.result.blockers), archive: codes(archived.result.blockers), state: archived.state };
    };
    git(t.repo, 'branch', 'backup', BRANCH);
    git(t.worktree, 'branch', '-q', '-u', 'backup', BRANCH);
    expect(await refused()).toEqual({ pre: ['upstream_mismatch'], archive: ['upstream_mismatch'], state: 'failed' });
    git(t.repo, 'remote', 'add', 'mirror', t.mirror);
    git(t.worktree, 'push', '-q', '-u', 'mirror', BRANCH);
    expect(await refused()).toEqual({ pre: ['upstream_mismatch'], archive: ['upstream_mismatch'], state: 'failed' });
    git(t.worktree, 'push', '-q', '-u', 'origin', `${BRANCH}:refs/heads/elsewhere`);
    expect(await refused()).toEqual({ pre: ['upstream_mismatch'], archive: ['upstream_mismatch'], state: 'failed' });
    git(t.worktree, 'push', '-q', '-u', 'origin', BRANCH);
    git(t.repo, 'remote', 'set-url', 'origin', t.mirror);
    expect(await refused()).toEqual({ pre: ['upstream_mismatch'], archive: ['upstream_mismatch'], state: 'failed' });
    git(t.repo, 'remote', 'set-url', 'origin', t.remote);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived.state, JSON.stringify(archived)).toBe('applied');
    expect(archived.result.preflight.git.upstream).toBe(`origin/${BRANCH}`);
  });

  it.each([
    ['no remote at launch', 'none'],
    ['two remotes and nothing selecting one', 'two'],
  ])('with %s the run still starts, but archive stays blocked as upstream_unverified even after a push (Task 8 fix 1)', async (_name, remotes) => {
    const t = await setup({ remotes });
    expect(t.backend.workers).toHaveLength(1);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    if (remotes === 'none') git(t.repo, 'remote', 'add', 'origin', t.remote);
    pushBranch(t.worktree);
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toEqual(['upstream_unverified']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['upstream_unverified']);
    expect(existsSync(t.worktree)).toBe(true);
  });

  it.each([
    ['two push refspecs mapping the branch to distinct destinations', ({ repo }) => {
      git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
      git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/elsewhere`);
    }],
    ['two distinct push URLs', ({ repo, remote, mirror }) => {
      git(repo, 'config', '--add', 'remote.origin.pushurl', remote);
      git(repo, 'config', '--add', 'remote.origin.pushurl', mirror);
    }],
    ['two push URLs that differ only by a trailing space (Task 8 fix 3)', ({ repo, remote }) => {
      execFileSync('git', ['init', '-q', '--bare', `${remote} `]);
      git(repo, 'config', '--add', 'remote.origin.pushurl', remote);
      git(repo, 'config', '--add', 'remote.origin.pushurl', `${remote} `);
    }],
  ])('with %s at launch the run still starts, but preflight and archive refuse as upstream_unverified (Task 8 fix 2)', async (_name, configure) => {
    const t = await setup({ configure });
    expect(t.backend.workers).toHaveLength(1);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    git(t.worktree, 'push', '-q', '-u', 'origin', BRANCH);
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toEqual(['upstream_unverified']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['upstream_unverified']);
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a second push URL added after a single-URL freeze refuses preflight and archive as upstream_mismatch (Task 8 fix 2)', async () => {
    const t = await setup();
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    pushBranch(t.worktree);
    git(t.repo, 'config', '--add', 'remote.origin.pushurl', t.remote);
    git(t.repo, 'config', '--add', 'remote.origin.pushurl', t.mirror);
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toEqual(['upstream_mismatch']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['upstream_mismatch']);
    expect(existsSync(t.worktree)).toBe(true);
    git(t.repo, 'config', '--unset-all', 'remote.origin.pushurl');
    expect((await wrapup(t.life.runtime, 'archive_owned_workspace')).state).toBe('applied');
  });

  it('a push URL differing only by a trailing space, added after a single-URL freeze, refuses preflight and archive as upstream_mismatch (Task 8 fix 3)', async () => {
    const t = await setup();
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    pushBranch(t.worktree);
    execFileSync('git', ['init', '-q', '--bare', `${t.remote} `]);
    git(t.repo, 'config', '--add', 'remote.origin.pushurl', t.remote);
    git(t.repo, 'config', '--add', 'remote.origin.pushurl', `${t.remote} `);
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toEqual(['upstream_mismatch']);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toEqual(['upstream_mismatch']);
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('remote.pushDefault in the source repository selects the authorized remote among several (Task 8 fix 1)', async () => {
    const t = await setup({ remotes: 'pushDefault' });
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    pushBranch(t.worktree);
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toEqual(['upstream_mismatch']);
    git(t.worktree, 'push', '-q', '-u', 'mirror', BRANCH);
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived.state, JSON.stringify(archived)).toBe('applied');
    expect(archived.result.preflight.git.upstream).toBe(`mirror/${BRANCH}`);
  });

  function betweenSamples(containment, change) {
    const scan = containment.ops.worktreeUsers;
    let armed = true;
    containment.ops.worktreeUsers = async (opts) => {
      if (armed) {
        armed = false;
        change();
      }
      return scan(opts);
    };
  }

  it('the archive receipt is the final validated sample: a HEAD advanced and pushed between the checks is what is recorded (Task 8 fix 1)', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    const first = git(t.worktree, 'rev-parse', 'HEAD').trim();
    betweenSamples(containment, () => {
      writeFileSync(join(t.worktree, 'late.txt'), 'late work\n');
      git(t.worktree, 'add', 'late.txt');
      git(t.worktree, 'commit', '-q', '-m', 'late work');
      git(t.worktree, 'push', '-q');
    });
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived.state, JSON.stringify(archived)).toBe('applied');
    const final = git(t.repo, 'rev-parse', `refs/heads/${BRANCH}`).trim();
    expect(final).not.toBe(first);
    expect(archived.result.preflight.git.headCommit).toBe(final);
    expect(t.life.ledger.worktreeArchive(RUN)).toMatchObject({ headCommit: final, upstream: `origin/${BRANCH}` });
    expect(createJournal({ dir: t.stateDir }).workspaceArchive(RUN, t.workspaceRef).git.headCommit).toBe(final);
    expect((await t.life.runtime.sampleGit(t.life.runtime.journal.bindingForRun(RUN))).payload.headCommit).toBe(final);
  });

  it('a tracking ref changed between the checks refuses the archive at the final check (Task 8 fix 1)', async () => {
    const containment = testContainment();
    const t = await setup({ containment });
    pushBranch(t.worktree);
    expect((await wrapup(t.life.runtime, 'archive_sessions')).state).toBe('applied');
    betweenSamples(containment, () => {
      git(t.repo, 'branch', 'backup', BRANCH);
      git(t.worktree, 'branch', '-q', '-u', 'backup', BRANCH);
    });
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(archived).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(archived.result.blockers)).toEqual(['upstream_mismatch']);
    expect(existsSync(t.worktree)).toBe(true);
    expect(t.life.ledger.worktreeArchive(RUN)).toBeNull();
  });

  it('a pending request blocks archive', async () => {
    const t = await setup();
    pushBranch(t.worktree);
    const [worker] = t.backend.workers;
    worker.state.pending = [{ nativeRequestId: 'req-1', kind: 'permission', fingerprint: 'f'.repeat(64), secret: false, choices: [], questions: [] }];
    const pre = await preflight(t.life.runtime);
    expect(codes(pre.result.blockers)).toContain('pending_requests');
    const closed = await wrapup(t.life.runtime, 'archive_sessions');
    expect(closed).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(closed.result.blockers)).toContain('pending_requests');
    expect(worker.child.exitCode).toBeNull();
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(codes(archived.result.blockers)).toContain('pending_requests');
    expect(existsSync(t.worktree)).toBe(true);
  });

  it('a clean, pushed, owned worktree archives without force and its receipt stays readable after the directory is gone', async () => {
    const t = await setup();
    const head = git(t.worktree, 'rev-parse', 'HEAD').trim();
    expect(codes((await preflight(t.life.runtime)).result.blockers)).toContain('no_upstream');
    pushBranch(t.worktree);
    const closed = await wrapup(t.life.runtime, 'archive_sessions');
    expect(closed.state, JSON.stringify(closed)).toBe('applied');
    expect(closed.result).toMatchObject({ ok: true, archivedSessions: 1, archivedWorkspace: false });
    expect(t.backend.workers[0].child.exitCode !== null || t.backend.workers[0].child.signalCode !== null).toBe(true);
    const stops = t.life.ledger.workers().filter((w) => w.runId === RUN).map((w) => w.exit);
    expect(stops).toEqual([expect.objectContaining({ kind: 'owned_stop', stop: 'quiesced' })]);
    writeFileSync(join(t.worktree, 'notes.txt'), 'keep me\n');
    const dirty = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(dirty).toMatchObject({ state: 'failed', errorCode: 'wrapup_blocked' });
    expect(codes(dirty.result.blockers)).toEqual(['untracked_files']);
    expect(readFileSync(join(t.worktree, 'notes.txt'), 'utf8')).toBe('keep me\n');
    rmSync(join(t.worktree, 'notes.txt'));

    const pre = await preflight(t.life.runtime);
    expect(pre.result).toMatchObject({ owned: true, workspaceId: t.workspaceRef, blockers: [], git: { ok: true, headCommit: head, upstream: `origin/${BRANCH}`, uncommitted: 0, untracked: 0, unpushed: 0 } });
    const archived = await wrapup(t.life.runtime, 'archive_owned_workspace', pre.result.checkedAt);
    expect(archived.state, JSON.stringify(archived)).toBe('applied');
    expect(archived.result).toMatchObject({ ok: true, phase: 'archive', archivedWorkspace: true, note: 'Owned worktree archived; the branch and history are kept.' });
    expect(existsSync(t.worktree)).toBe(false);
    expect(git(t.repo, 'worktree', 'list', '--porcelain')).not.toContain(t.workspaceRef);
    expect(git(t.repo, 'rev-parse', `refs/heads/${BRANCH}`).trim()).toBe(head);

    const receipt = createJournal({ dir: t.stateDir }).workspaceArchive(RUN, t.workspaceRef);
    expect(receipt).toMatchObject({ workspaceId: t.workspaceRef, git: { headCommit: head, upstream: `origin/${BRANCH}` } });
    const binding = t.life.runtime.journal.bindingForRun(RUN);
    const sample = await t.life.runtime.sampleGit(binding);
    expect(sample.payload).toMatchObject({ headCommit: head, dirty: false, workspaceState: 'archived', historical: true, source: 'owned_workspace_archive' });
    const again = await wrapup(t.life.runtime, 'archive_owned_workspace');
    expect(again.state).toBe('applied');
    expect(again.result.archivedWorkspace).toBe(true);
  });

  it('an artifact read rejects a symlink escape from a native worktree', async () => {
    const t = await setup();
    mkdirSync(join(t.root, 'outside'));
    writeFileSync(join(t.root, 'outside', 'notes.md'), 'outside the worktree\n');
    symlinkSync(join(t.root, 'outside', 'notes.md'), join(t.worktree, 'link.md'));
    writeFileSync(join(t.worktree, 'report.md'), 'inside the worktree\n');
    const read = (reference) => t.life.runtime.executor.execute({ id: randomUUID(), runId: RUN, sessionId: null, kind: 'artifact_read', payload: { reference } });
    const escaped = await read('link.md');
    expect(escaped.state, JSON.stringify(escaped)).toBe('applied');
    expect(escaped.result).toEqual({ status: 'unavailable', reason: 'symlink_escape' });
    const inside = await read('report.md');
    expect(inside.result).toMatchObject({ status: 'available', mediaType: 'text/plain' });
    expect(Buffer.from(inside.result.contentBase64, 'base64').toString('utf8')).toBe('inside the worktree\n');
  });
});
