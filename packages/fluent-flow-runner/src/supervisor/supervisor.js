import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadLocalProfiles, loadRepositories } from '../connector/config.js';
import { harnessVersionFor, profileRevision } from '../connector/catalog.js';
import { archiveRunWorktree, ensureRunWorktree, missingWorktreeEvidence, ownedWorktreeProblem, runWorkspaceRef, worktreeGitCheck, WorktreeConflict } from '../connector/worktrees.js';
import { assertBackend, assertWorker, BackendContractError, createCommandBarrier, openEffects } from './backend-contract.js';
import { ContainmentError, containmentOps } from './containment.js';
import { createIpcServer } from './ipc.js';
import { createLedger } from './ledger.js';
import { ensurePrivateDir, verifyOwnerLock } from './owner-lock.js';
import { isLive, readBootId } from './process-identity.js';
import { createSlots, holdsSlot, SLOT_BACKENDS } from './slots.js';
import { createSpoolPrivacy } from './spool-privacy.js';
import { nativeCursorEpoch, summarySourceText, SummarySourceIncomplete } from './summary.js';
import { detectEscapes, recoverOnStart } from './recovery.js';
import { stopContained } from './stop.js';


class RequestError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class OwnerLockNotHeld extends Error {
  constructor() {
    super('The supervisor does not hold its owner lock');
    this.name = 'OwnerLockNotHeld';
    this.code = 'owner_lock_not_held';
  }
}

/**
 * @returns {Promise<Array<{ id: string, backend: string, readiness: { state: string } }>>}
 */
export async function publishReadiness({ profiles, containment, backends }) {
  const out = [];
  for (const profile of profiles) {
    let state;
    if (containment?.state !== 'verified') state = 'platform_unsupported';
    else if (!profile.complete) state = 'incomplete';
    else if (!backends[profile.backend]) state = 'platform_unsupported';
    else state = (await backends[profile.backend].readiness(profile)).state;
    out.push({ id: profile.id, backend: profile.backend, readiness: { state } });
  }
  return out;
}

/**
 * @param {{ directory: string, procRoot?: string, selfPid?: number, uid?: number, fsp?: { readdir: Function, readlink: Function, stat: Function, readFile?: Function } }} opts
 * @returns {Promise<{ users: number[], unverifiable: number }>}
 */
export async function worktreeUsers({ directory, procRoot = '/proc', selfPid = process.pid, uid = process.getuid(), fsp = { readdir, readlink, stat, readFile } }) {
  const inside = (target) => target === directory || target.startsWith(`${directory}/`);
  const vanished = (err) => err?.code === 'ENOENT' || err?.code === 'ESRCH';
  const denied = (err) => err?.code === 'EACCES' || err?.code === 'EPERM';
  async function gone(base) {
    try {
      await fsp.stat(base);
    } catch (err) {
      if (vanished(err)) return true;
      if (denied(err)) return false;
      throw err;
    }
    if (!fsp.readFile) return false;
    try {
      const raw = await fsp.readFile(`${base}/stat`, 'utf8');
      return raw.slice(raw.lastIndexOf(')') + 2, raw.lastIndexOf(')') + 3) === 'Z';
    } catch (err) {
      if (vanished(err)) return true;
      if (denied(err)) return false;
      throw err;
    }
  }
  /** @returns {Promise<'inside' | 'outside' | 'unknown' | 'gone'>} */
  async function inspect(base) {
    const unreadable = async () => ((await gone(base)) ? 'gone' : 'unknown');
    let fds;
    try {
      fds = await fsp.readdir(`${base}/fd`);
    } catch (err) {
      if (vanished(err) || denied(err)) return unreadable();
      throw err;
    }
    for (const link of ['cwd', ...fds.map((fd) => `fd/${fd}`)]) {
      let target;
      try {
        target = await fsp.readlink(`${base}/${link}`);
      } catch (err) {
        if (vanished(err) && link !== 'cwd' && !(await gone(base))) continue;
        if (vanished(err) || denied(err)) return unreadable();
        throw err;
      }
      if (inside(target)) return 'inside';
    }
    return 'outside';
  }
  const users = [];
  let unverifiable = 0;
  for (const name of await fsp.readdir(procRoot)) {
    if (!/^\d+$/.test(name) || Number(name) === selfPid) continue;
    const base = `${procRoot}/${name}`;
    let owner;
    try {
      owner = (await fsp.stat(base)).uid;
    } catch (err) {
      if (vanished(err)) continue;
      if (!denied(err)) throw err;
      unverifiable += 1;
      continue;
    }
    if (owner !== uid) continue;
    const verdict = await inspect(base);
    if (verdict === 'inside') users.push(Number(name));
    else if (verdict === 'unknown') unverifiable += 1;
  }
  return { users, unverifiable };
}

const parse = (schema, params) => {
  const result = schema.safeParse(params);
  if (!result.success) throw new RequestError('invalid_request');
  return result.data;
};
const id = z.string().min(1).max(200);
const seq = z.number().int().min(0);
const SubmitParams = z.object({
  commandId: id, digest: z.string().min(1).max(200), runId: id, sessionId: id, backend: z.string().min(1).max(64), kind: z.string().min(1).max(64),
  profileId: id.optional(),
  profileRevision: z.string().min(1).max(200).optional(),
  repositoryKey: z.string().min(1).max(64).optional(),
  branchName: z.string().min(1).max(250).optional(),
  baseRef: z.string().min(1).max(250).optional(),
  role: z.enum(['work', 'summary']).optional(),
  slotGranted: z.boolean().optional(),
  slotHeld: z.boolean().optional(),
  grantId: z.string().uuid().optional(),
  reporting: z.object({ url: z.string().min(1).max(2000), credential: z.string().min(1).max(4096) }).optional(),
  text: z.string().min(1).max(200_000).optional(),
  behavior: z.enum(['steer', 'interrupt']).optional(),
  nativeRequestId: id.optional(),
  generation: z.number().int().min(1).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  summarySource: z.object({ sessionId: id, sourceCursor: z.object({ epoch: z.string().min(1).max(200), seq: z.number().int().min(1) }) }).optional(),
});
const Selections = z.record(z.string().min(1).max(200), z.object({ selected: z.array(z.string().max(2000)).max(50), other: z.string().max(20000).optional() }).strict());
const LocalAnswerParams = z.object({ localCommandId: z.string().uuid(), requestId: z.string().regex(/^[0-9a-f]{32}$/), selections: Selections });
const ControlPlaneStatusParams = z.object({ online: z.boolean() }).strict();
const DeliverParams = z.object({ commandId: id, digest: z.string().min(1).max(200), text: z.string().min(1).max(200_000) });
const EventsParams = z.object({ afterSeq: seq, limit: z.number().int().min(1).max(500).optional() });
const EventChunkParams = z.object({ seq: z.number().int().min(1), offset: seq });
const AckParams = z.object({ uptoSeq: seq });
const StopParams = z.object({ scope: z.literal('all'), timeoutMs: z.number().int().min(0).max(600_000) });
const WorkspaceParams = z.object({ runId: id });
const WrapupParams = z.object({ runId: id, repositoryKey: z.string().min(1).max(64), workspaceRef: z.string().regex(/^ffw_[0-9a-f]{16}$/) });
const CloseParams = z.object({ runId: id });
const ReserveSlotsParams = z.object({ notAfter: z.string().datetime().optional() }).strict();
const SlotCount = z.number().int().min(0).max(64);
const ReleaseSlotsParams = z.object({ grantId: z.string().uuid().optional(), version: z.number().int().min(1).optional(), unused: z.object({ 'claude-code': SlotCount.optional(), codex: SlotCount.optional() }).strict() });
const MAX_POLL_SLOTS = 64;

const LAUNCH_KINDS = new Set(['launch', 'create_session', 'summarize']);
const DEFERRED = Object.freeze({ state: 'deferred' });
const CONTROL_KINDS = new Set(['cancel', 'permission']);
const PUBLIC_FAILURES = new Set(['startup_failed', 'sign_in_required', 'profile_unavailable', 'request_unavailable', 'execution_settings_changed', 'account_limited', 'summary_unavailable', 'answer_on_host', 'invalid_response']);
export const EVENT_BATCH_BYTES = 768 * 1024;
export const LARGE_EVENT_BYTES = 512 * 1024;
export const CHUNK_BYTES = 384 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const CONTROL_PLANE_FRESH_MS = 60_000;

/**
 * @param {{ ledger: any, profiles: any[], backends: Record<string, any>, containment: any, log: (entry: object) => void, stateDir?: string, repositories?: Record<string, string>, privacy?: ReturnType<typeof createSpoolPrivacy>, stopTimeoutMs?: number, limits?: Record<string, number>, onStopped?: (state: string) => void }} opts - `limits`: the owner's per-backend caps
 */
export function createSupervisorHandlers({ ledger, profiles, backends, containment, log, stateDir, repositories = {}, privacy = createSpoolPrivacy(), stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS, limits = { 'claude-code': 1, codex: 1 }, onStopped }) {
  let stopping = false;
  let latestConnectorEpoch = -1;
  let attachedConnectorEpoch = null;
  let controlPlaneOnlineAt = 0;
  const controlPlaneFresh = () => attachedConnectorEpoch !== null && controlPlaneOnlineAt > 0 && Date.now() - controlPlaneOnlineAt <= CONTROL_PLANE_FRESH_MS;
  const ops = containmentOps(containment);
  const live = new Map();
  const closed = new Map();
  const wrapping = new Set();
  const inflight = new Map();
  const refusedLocal = new Map();
  const observed = new Map();
  const earlierWorkers = ledger.workers();
  const earlierCommands = ledger.commandIds();
  const slots = createSlots({ ledger, limits });
  const batches = new Map();
  const granted = (backend) => [...batches.values()].reduce((n, b) => n + b.counts[backend], 0);
  function takeGrant(backend, grantId) {
    const named = grantId ? batches.get(grantId) : undefined;
    const batch = named && named.counts[backend] > 0 ? named : [...batches.values()].find((b) => b.counts[backend] > 0);
    if (!batch) return false;
    batch.counts[backend] -= 1;
    batch.version += 1;
    return true;
  }
  function dropEmptyBatches() {
    for (const [id, b] of batches) if (SLOT_BACKENDS.every((k) => b.counts[k] === 0)) batches.delete(id);
  }

  function admissionRefusal(backend) {
    if (stopping) return 'supervisor_stopping';
    if (containment?.state !== 'verified') return 'containment_unavailable';
    if (!backends[backend]) return 'backend_not_composed';
    return null;
  }

  /**
   * @returns {Promise<{ populated: boolean | null, killable: boolean, leaf: string | null }>}
   */
  async function inspect(w, bootId) {
    const unknown = { populated: null, killable: false, leaf: null };
    if (containment?.state !== 'verified') return unknown;
    const missing = async () => (w.identity && (await isLive(w.identity)) ? unknown : { populated: false, killable: false, leaf: null });
    let leaf;
    try {
      leaf = ops.leaf({ cgroupPath: w.cgroupPath, generation: w.generation, sessionId: w.sessionId });
    } catch (err) {
      if (!(err instanceof ContainmentError)) throw err;
      if (err.code === 'leaf_missing') return missing();
      log({ msg: 'supervisor worker cgroup not provable', sessionId: w.sessionId, generation: w.generation, code: err.code });
      return unknown;
    }
    let read;
    try {
      read = await ops.read({ cgroupPath: leaf });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return missing();
    }
    observe(w, read?.pids);
    const killable = !w.identity || w.identity.bootId === bootId;
    return { populated: read?.populated, killable, leaf };
  }

  function observe(w, pids) {
    const key = `${w.sessionId}\u0000${w.generation}`;
    const seen = observed.get(key) ?? new Map();
    for (const p of Array.isArray(pids) ? pids : []) {
      if (Number.isSafeInteger(p?.pid) && Number.isSafeInteger(p?.startTicks) && typeof p?.bootId === 'string') seen.set(`${p.pid}:${p.startTicks}`, { pid: p.pid, startTicks: p.startTicks, bootId: p.bootId });
    }
    observed.set(key, seen);
  }

  function escapesOf(w) {
    const seen = observed.get(`${w.sessionId}\u0000${w.generation}`);
    if (!seen?.size || containment?.state !== 'verified') return [];
    const escapes = detectEscapes({ observed: [...seen.values()], containment });
    if (escapes.length) {
      log({ msg: 'native worker descendants escaped', sessionId: w.sessionId, generation: w.generation, count: escapes.length });
      spool({ sessionId: w.sessionId, runId: w.runId, generation: w.generation, backend: w.backend }, { kind: 'state', nativeEventId: `ff:escape:${w.generation}`, payload: { state: 'reconciling', errorCode: 'reconciling', reason: 'descendants_escaped' } });
    }
    return escapes;
  }

  async function observeLeaf(w, leaf) {
    const read = await ops.read({ cgroupPath: leaf });
    observe(w, read?.pids);
    return read;
  }

  async function workerStates() {
    const bootId = await readBootId();
    const states = [];
    for (const w of ledger.workers()) {
      const { populated, killable } = await inspect(w, bootId);
      const escaped = escapesOf(w).length;
      const needsRecovery = w.needsRecovery || populated === null || (populated === true && !killable);
      const entry = live.get(w.sessionId)?.generation === w.generation ? live.get(w.sessionId) : null;
      const state = escaped ? 'escaped' : entry ? (entry.worker.idle?.() === true ? 'idle' : 'active') : needsRecovery ? 'unconfirmed' : populated ? 'running' : 'stopped';
      states.push({
        sessionId: w.sessionId, runId: w.runId, backend: w.backend, generation: w.generation, populated,
        needsRecovery, state, startedAt: w.startedAt ?? null,
        ...(escaped ? { escaped } : {}),
      });
    }
    return states;
  }

  async function unresolvedEarlierWork() {
    if (earlierWorkers.length) {
      const bootId = await readBootId();
      for (const w of earlierWorkers) {
        if ((await inspect(w, bootId)).populated !== false) return 'earlier_worker_not_proven_empty';
      }
    }
    for (const commandId of earlierCommands) {
      const rec = ledger.commandRecord(commandId);
      if (rec.closure) continue;
      const cls = ledger.classify(commandId);
      const uncertain = cls !== 'undispatched' && Object.values(cls).includes('uncertain');
      if (rec.outcome?.state === 'reconciling' || (uncertain && !['failed', 'applied'].includes(rec.outcome?.state))) return 'earlier_effect_uncertain';
    }
    return null;
  }

  function finish(commandId, state, errorCode, extra = {}) {
    ledger.outcome(commandId, { state, ...(errorCode ? { errorCode } : {}), ...(extra.dispatched === false ? { dispatched: false } : {}), ...(extra.closure ? { closure: extra.closure } : {}) });
    return { state, ...(errorCode ? { errorCode } : {}), ...extra };
  }

  function finishAfterError(commandId, err) {
    if (err instanceof BackendContractError) log({ msg: 'native backend contract violation', commandId, error: err.message });
    else log({ msg: 'native effect failed', commandId, code: err?.code, reason: err?.reason });
    const cls = ledger.classify(commandId);
    const uncertain = cls !== 'undispatched' && Object.entries(cls).some(([effect, state]) => state === 'uncertain' && !ledger.noWrite(commandId, effect));
    if (uncertain || err?.code === 'reconciling') return finish(commandId, 'reconciling', 'reconciling');
    return finish(commandId, 'failed', PUBLIC_FAILURES.has(err?.code) ? err.code : 'startup_failed');
  }

  function track(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  function exactProfile(cmd) {
    const matches = profiles.filter((p) => p?.id === cmd.profileId);
    if (matches.length !== 1) return null;
    const p = matches[0];
    if (p.backend !== cmd.backend || p.complete !== true) return null;
    return profileRevision(p, harnessVersionFor(p.backend)) === cmd.profileRevision ? p : null;
  }

  function hasBarrier(commandId, effect) {
    return ledger.commandRecord(commandId)?.barriers.some((b) => b.effect === effect) ?? false;
  }

  function nextGeneration(sessionId) {
    let max = 0;
    for (const w of ledger.workers()) if (w.sessionId === sessionId) max = Math.max(max, w.generation);
    for (const b of ledger.bindings()) if (b.sessionId === sessionId) max = Math.max(max, b.generation);
    return max + 1;
  }

  function bindingOf(sessionId, runId) {
    const bind = ledger.bindings().filter((b) => b.sessionId === sessionId).at(-1);
    const worktree = ledger.runBarrier(runId, 'create_worktree');
    if (!bind || !worktree) return undefined;
    return { workspaceRef: worktree.ref.workspaceRef, nativeSessionId: bind.nativeSessionId, generation: bind.generation };
  }

  /**
   * @param {{ sessionId: string, runId: string, generation: number, backend: string, stop?: string | null }} entry
   * @param {import('./spool-privacy.js').NativeSpoolEvent} event
   */
  function spool(entry, event) {
    const safe = privacy.scrub(entry.sessionId, event);
    const violation = typeof safe.payload === 'object' && safe.payload !== null && 'state' in safe.payload && safe.payload.state === 'profile_violation';
    if (safe.kind === 'state' && violation && entry.stop !== 'quiesced') entry.stop = entry.stop ?? 'pending';
    const fence = safe.terminal && entry.stop && entry.stop !== 'quiesced' ? { ownedStop: entry.stop } : {};
    return ledger.appendEvent({
      sessionId: entry.sessionId, runId: entry.runId, generation: entry.generation, kind: safe.kind, nativeEventId: safe.nativeEventId,
      payload: { backend: entry.backend, event: safe.payload ?? null, ...(safe.terminal ? { terminal: safe.terminal } : {}), ...(safe.receiptFor ? { receiptFor: safe.receiptFor } : {}), ...fence },
    });
  }

  async function pump(entry) {
    try {
      for await (const event of entry.worker.events) spool(entry, event);
    } catch (err) {
      log({ msg: 'native event spool stopped', sessionId: entry.sessionId, generation: entry.generation, error: err?.message });
    }
  }

  function boundSpawn(entry) {
    let used = false;
    return async ({ executable, args, env, cwd }) => {
      const { sessionId, runId, backend, generation } = entry;
      const cgroupPath = ops.leafPath({ generation, sessionId });
      if (used) {
        const previous = ledger.workers().find((w) => w.sessionId === sessionId && w.generation === generation);
        const leaf = previous?.exit?.kind === 'child_exit' ? ops.leaf({ cgroupPath, generation, sessionId }) : null;
        if (!leaf || (await ops.read({ cgroupPath: leaf }))?.populated !== false) throw new BackendContractError('The supervisor spawn is reused only after its previous process exited and its leaf reads empty');
      } else {
        ledger.recordWorkerIntent({ sessionId, runId, backend, generation, cgroupPath });
        ops.createWorker({ generation, sessionId });
      }
      used = true;
      const { child, identity } = await ops.spawn({ cgroupPath, executable, args, env, cwd });
      ledger.recordWorker({ sessionId, generation, identity: { pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId } });
      child.once('exit', (code, signal) => {
        try {
          ledger.recordWorkerExit({ sessionId, generation, kind: 'child_exit', code, signal });
        } catch (err) {
          log({ msg: 'worker exit evidence not recorded', sessionId, generation, error: err?.message });
        }
        if (live.get(sessionId) === entry && !entry.stop && !entry.closing) workerLost(entry, { code, signal });
      });
      return { child, identity: { pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId, pgid: child.pid, cgroup: cgroupPath } };
    };
  }

  function boundStop(entry) {
    let op = null;
    /** @param {{ reason?: string }} [arg] */
    return ({ reason } = {}) => {
      if (op) return op;
      entry.stop = 'pending';
      op = (async () => {
        const { sessionId, generation } = entry;
        const w = ledger.workers().find((x) => x.sessionId === sessionId && x.generation === generation);
        if (!w || containment?.state !== 'verified') return 'uncertain';
        const bootId = await readBootId();
        if (w.identity && w.identity.bootId !== bootId) return 'uncertain';
        const gone = async () => (w.identity && (await isLive(w.identity)) ? 'uncertain' : 'quiesced');
        let leaf;
        try {
          leaf = ops.leaf({ cgroupPath: w.cgroupPath, generation, sessionId });
        } catch (err) {
          if (!(err instanceof ContainmentError)) throw err;
          return err.code === 'leaf_missing' ? gone() : 'uncertain';
        }
        if (reason === 'shutdown') {
          return stopContained({
            worker: { sessionId, generation, cgroupPath: leaf, identity: w.identity, pgid: w.identity?.pid ?? null },
            containment: { read: ops.read, kill: ({ generation: g, sessionId: s }) => ops.kill({ cgroupPath: w.cgroupPath, generation: g, sessionId: s }), ...(ops.terminate ? { terminate: ops.terminate } : {}) },
            graceMs: entry.shutdownGraceMs ?? stopTimeoutMs, killWaitMs: entry.shutdownKillWaitMs ?? stopTimeoutMs,
          });
        }
        await ops.kill({ cgroupPath: w.cgroupPath, generation, sessionId });
        const deadline = Date.now() + stopTimeoutMs;
        for (;;) {
          let populated;
          try {
            ({ populated } = await ops.read({ cgroupPath: leaf }));
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            return gone();
          }
          if (populated === false) return 'quiesced';
          if (Date.now() >= deadline) return 'uncertain';
          await new Promise((r) => setTimeout(r, 50));
        }
      })().catch((err) => {
        log({ msg: 'owned stop failed', sessionId: entry.sessionId, generation: entry.generation, reason, error: err?.message });
        return 'uncertain';
      }).then((result) => {
        log({ msg: 'owned stop finished', sessionId: entry.sessionId, generation: entry.generation, reason, stop: result });
        entry.stop = result;
        try {
          ledger.recordWorkerExit({ sessionId: entry.sessionId, generation: entry.generation, kind: 'owned_stop', reason: reason ?? null, stop: result });
          if (reason === 'worker_lost') {
            spool(entry, { kind: 'state', nativeEventId: `ff:worker_lost:${entry.generation}`, payload: { state: 'reconciling', errorCode: 'reconciling', reason: 'worker_lost', stop: result } });
          } else if (result === 'quiesced' && reason !== 'wrapup' && reason !== 'shutdown') {
            spool(entry, { kind: 'state', nativeEventId: `ff:owned_stop:${entry.generation}`, payload: { state: 'failed', errorCode: reason === 'model_rerouted' ? 'profile_unavailable' : 'startup_failed', reason: reason ?? null, stop: result } });
          }
        } catch (err) {
          log({ msg: 'owned stop evidence not recorded', sessionId: entry.sessionId, generation: entry.generation, error: err?.message });
        }
        return result;
      });
      return op;
    };
  }

  function workerLost(entry, exit) {
    live.delete(entry.sessionId);
    log({ msg: 'native worker lost', sessionId: entry.sessionId, generation: entry.generation, code: exit.code, signal: exit.signal });
    for (const commandId of ledger.commandIds()) {
      const rec = ledger.commandRecord(commandId);
      if (rec.accept.sessionId !== entry.sessionId || rec.accept.runId !== entry.runId || rec.closure) continue;
      if (inflight.has(commandId) || inflight.has(`deliver:${commandId}`)) continue;
      if (rec.outcome?.state === 'accepted' && LAUNCH_KINDS.has(rec.accept.kind) && !hasBarrier(commandId, 'prompt')) finish(commandId, 'reconciling', 'reconciling');
    }
    entry.closing = true;
    entry.stopOwned({ reason: 'worker_lost' });
    Promise.resolve().then(() => entry.worker.close({ reason: 'worker_lost' })).catch((err) => {
      log({ msg: 'lost native worker close failed', sessionId: entry.sessionId, generation: entry.generation, error: err?.message });
    });
  }

  async function worktreeFor(cmd) {
    if (cmd.kind === 'launch') {
      const repoPath = repositories[cmd.repositoryKey];
      if (!repoPath) throw new WorktreeConflict('repository_not_allowed');
      const result = await ensureRunWorktree({
        repoPath, root: join(stateDir, 'worktrees'), runId: cmd.runId, sessionId: cmd.sessionId, branchName: cmd.branchName, baseRef: cmd.baseRef,
        effects: {
          prior: () => ledger.runBarrier(cmd.runId, 'create_worktree')?.ref ?? null,
          barrier: async (ref) => ledger.barrier(cmd.commandId, { effect: 'create_worktree', generation: 0, ref }),
        },
      });
      if (hasBarrier(cmd.commandId, 'create_worktree') && !ledger.commandRecord(cmd.commandId).receipts.some((r) => r.effect === 'create_worktree')) {
        ledger.receipt(cmd.commandId, { effect: 'create_worktree', evidence: { workspaceRef: result.workspaceRef } });
      }
      return result;
    }
    const worktree = ledger.runBarrier(cmd.runId, 'create_worktree');
    const bound = ledger.bindings().find((b) => b.runId === cmd.runId);
    if (!worktree || !bound) throw new WorktreeConflict('run_worktree_unknown');
    const st = lstatSync(bound.workspaceDir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new WorktreeConflict('run_worktree_missing');
    return { workspaceRef: worktree.ref.workspaceRef, directory: bound.workspaceDir };
  }

  async function summarySourceFor(commandId, runId, backend, source) {
    try {
      if (!source || source.sourceCursor.epoch !== nativeCursorEpoch(backend)) throw new SummarySourceIncomplete(source ? 'cursor_domain_mismatch' : 'source_missing');
      return { text: await summarySourceText({ ledger, runId, sessionId: source.sessionId, sourceCursor: source.sourceCursor }) };
    } catch (err) {
      if (!(err instanceof SummarySourceIncomplete)) throw err;
      log({ msg: 'native summary source refused', commandId, reason: err.reason });
      return { refused: finish(commandId, 'failed', 'summary_unavailable') };
    }
  }

  async function summarySourceRefusal(cmd) {
    const result = await summarySourceFor(cmd.commandId, cmd.runId, cmd.backend, cmd.summarySource);
    return result.refused ?? null;
  }

  async function summaryPrompt(commandId, entry, instructions) {
    const result = await summarySourceFor(commandId, entry.runId, entry.backend, entry.summarySource);
    if (result.refused) return result;
    const { sessionId, sourceCursor } = entry.summarySource;
    return { text: `${instructions}\n${JSON.stringify({ history: { sourceSessionId: sessionId, sourceCursor: { epoch: sourceCursor.epoch, seq: String(sourceCursor.seq) }, assistantText: result.text } })}` };
  }

  async function bindStage(cmd) {
    const { commandId, runId, sessionId, backend } = cmd;
    if (fencedByCancel(cmd)) {
      log({ msg: 'native launch refused', commandId, backend, reason: 'cancelled_before_admission' });
      return finish(commandId, 'failed', 'request_unavailable');
    }
    const earlier = await unresolvedEarlierWork();
    if (earlier) {
      log({ msg: 'native admission refused', commandId, backend, reason: 'recovery_required', detail: earlier });
      return finish(commandId, 'failed', 'startup_failed');
    }
    const refusal = admissionRefusal(backend);
    if (refusal) {
      log({ msg: 'native admission refused', commandId, backend, reason: refusal });
      return finish(commandId, 'failed', 'profile_unavailable');
    }
    const profile = exactProfile(cmd);
    if (!profile) {
      log({ msg: 'native admission refused', commandId, backend, reason: 'profile_revision_mismatch' });
      return finish(commandId, 'failed', 'execution_settings_changed');
    }
    const readiness = await backends[backend].readiness(profile);
    if (readiness?.state !== 'ready') {
      log({ msg: 'native admission refused', commandId, backend, reason: 'not_ready', readiness: readiness?.state });
      return finish(commandId, 'failed', readiness?.state === 'sign_in_required' ? 'sign_in_required' : 'profile_unavailable');
    }
    if (!cmd.reporting) {
      log({ msg: 'native admission refused', commandId, backend, reason: 'reporting_missing' });
      return finish(commandId, 'failed', 'startup_failed');
    }
    if (cmd.kind === 'summarize') {
      const refused = await summarySourceRefusal(cmd);
      if (refused) return refused;
    }
    if (!controlPlaneFresh()) return DEFERRED;
    if (!(await admitSlot(cmd))) return DEFERRED;
    let workspace;
    try {
      workspace = await worktreeFor(cmd);
    } catch (err) {
      if (!(err instanceof WorktreeConflict)) return finishAfterError(commandId, err);
      log({ msg: 'native admission refused', commandId, backend, reason: 'worktree_conflict', detail: err.reason, uncertain: err.uncertain });
      return err.uncertain ? finish(commandId, 'reconciling', 'reconciling') : finish(commandId, 'failed', 'startup_failed');
    }
    const entry = { sessionId, runId, backend, generation: nextGeneration(sessionId), workspaceRef: workspace.workspaceRef, workspaceDir: workspace.directory, worker: null, stop: null, stopOwned: null,
      summarySource: cmd.kind === 'summarize' ? cmd.summarySource : null };
    entry.stopOwned = boundStop(entry);
    let worker;
    try {
      worker = assertWorker(await backends[backend].open({
        sessionId, runId, profile, workspaceDir: workspace.directory, reporting: cmd.reporting, resume: null, generation: entry.generation,
        spawn: boundSpawn(entry),
        effects: openEffects({ ledger, commandId, sessionId, runId, backend, generation: entry.generation, workspaceDir: workspace.directory }),
        stopOwned: entry.stopOwned,
      }));
    } catch (err) {
      return finishAfterError(commandId, err);
    }
    entry.worker = worker;
    live.set(sessionId, entry);
    pump(entry);
    return finish(commandId, 'accepted', undefined, { binding: { workspaceRef: entry.workspaceRef, nativeSessionId: worker.nativeSessionId, generation: entry.generation } });
  }

  async function sendPrompt(commandId, entry, text, mode) {
    const barrier = createCommandBarrier({ ledger, commandId, effect: 'prompt', generation: entry.generation });
    let result;
    try {
      result = await entry.worker.send({ commandId, text, mode, barrier });
    } catch (err) {
      return finishAfterError(commandId, err);
    }
    if (result?.receipt?.dispatched === false) {
      if (hasBarrier(commandId, 'prompt')) ledger.recordNoWrite(commandId, { effect: 'prompt', generation: entry.generation, sessionId: entry.sessionId, backend: entry.backend, evidence: 'ff_suppressed' });
      return finish(commandId, 'failed', 'request_unavailable');
    }
    ledger.receipt(commandId, { effect: 'prompt', evidence: { state: typeof result?.receipt?.state === 'string' ? result.receipt.state : null } });
    return finish(commandId, 'applied');
  }

  function ownedWorker(cmd, { reopenable = false } = {}) {
    if (closed.get(cmd.sessionId)?.runId === cmd.runId) {
      log({ msg: 'native control refused', commandId: cmd.commandId, sessionId: cmd.sessionId, reason: 'session_closed_by_wrapup' });
      return { outcome: finish(cmd.commandId, 'failed', 'request_unavailable') };
    }
    const entry = live.get(cmd.sessionId);
    if (entry && entry.runId === cmd.runId && entry.backend === cmd.backend) return { entry };
    if (entry && entry.backend !== cmd.backend) return { outcome: finish(cmd.commandId, 'failed', 'execution_settings_changed') };
    if (reopenable && !entry) return { reopen: true };
    log({ msg: 'native control has no owned worker in this lifetime', commandId: cmd.commandId, sessionId: cmd.sessionId });
    return { outcome: finish(cmd.commandId, 'reconciling', 'reconciling') };
  }

  async function quiesceRecorded(w, bootId, reason) {
    const state = await inspect(w, bootId);
    if (state.populated === false) return 'quiesced';
    if (state.populated !== true || !state.killable) return 'uncertain';
    const result = await stopContained({
      worker: { sessionId: w.sessionId, generation: w.generation, cgroupPath: state.leaf, identity: w.identity, pgid: w.identity?.pid ?? null },
      containment: { read: ops.read, kill: ({ generation, sessionId }) => ops.kill({ cgroupPath: w.cgroupPath, generation, sessionId }), ...(ops.terminate ? { terminate: ops.terminate } : {}) },
      graceMs: stopTimeoutMs, killWaitMs: stopTimeoutMs,
    });
    ledger.recordWorkerExit({ sessionId: w.sessionId, generation: w.generation, kind: reason, stop: result });
    return result;
  }

  function sessionCommands(cmd) {
    return ledger.commandIds().filter((id) => id !== cmd.commandId).map((id) => [id, ledger.commandRecord(id)])
      .filter(([, r]) => r.accept.sessionId === cmd.sessionId && r.accept.runId === cmd.runId);
  }

  function openForClosure(id, r) {
    if (r.closure || r.accept.kind === 'cancel' && r.outcome?.state === 'applied') return false;
    const state = r.outcome?.state;
    const cls = ledger.classify(id);
    const uncertain = cls !== 'undispatched' && Object.entries(cls).some(([effect, st]) => st === 'uncertain' && !ledger.noWrite(id, effect));
    return !state || state === 'reconciling' || (uncertain && !['failed', 'applied'].includes(state)) || (state === 'accepted' && LAUNCH_KINDS.has(r.accept.kind));
  }

  function closeOpenCommand(id, r, { by, generation, sessionId, backend, nativeSessionId }) {
    const cls = ledger.classify(id);
    if (cls !== 'undispatched') {
      for (const [effect, st] of Object.entries(cls)) {
        if (st === 'uncertain') ledger.recordResolution(id, { effect, kind: 'operator_closed', by, evidence: { stop: 'quiesced' } });
      }
    }
    ledger.recordClosure(id, { by, generation, sessionId, backend, stop: 'quiesced', evidence: {
      nativeSessionId: nativeSessionId ?? null, promptBarrier: r.barriers.some((b) => b.effect === 'prompt'), promptReceipt: r.receipts.some((x) => x.effect === 'prompt'),
    } });
    log({ msg: 'native command closed by operator', commandId: id, closedBy: by });
  }

  function priorCreateOf(cmd, others) {
    if (cmd.backend !== 'claude-code') return null;
    const candidates = others.filter(([id, r]) => LAUNCH_KINDS.has(r.accept.kind) && !r.closure && r.barriers.some((b) => b.effect === 'create_native_session' && ledger.classify(id)[b.effect] === 'uncertain'));
    if (candidates.length !== 1) return null;
    const [commandId, r] = candidates[0];
    const barrier = r.barriers.find((b) => b.effect === 'create_native_session');
    if (typeof barrier.ref?.uuid !== 'string' || barrier.ref.uuid !== cmd.sessionId) return null;
    return { commandId, record: r, generation: barrier.generation, nativeSessionId: barrier.ref.uuid };
  }

  async function reopenSession(cmd) {
    const reconciling = (reason) => {
      log({ msg: 'native session not reopened', commandId: cmd.commandId, sessionId: cmd.sessionId, reason });
      return { outcome: finish(cmd.commandId, 'reconciling', 'reconciling') };
    };
    const { sessionId, runId, backend } = cmd;
    const others = sessionCommands(cmd);
    if (others.some(([id]) => inflight.has(id) || inflight.has(`deliver:${id}`))) return reconciling('command_in_flight');
    const bind = ledger.bindings().filter((b) => b.sessionId === sessionId && b.runId === runId).at(-1) ?? null;
    const prior = bind ? null : priorCreateOf(cmd, others);
    if (!bind && !prior) return reconciling('no_binding');
    const recorded = ledger.workers().filter((w) => w.sessionId === sessionId && w.runId === runId);
    if ((bind && bind.backend !== backend) || recorded.some((w) => w.backend !== backend) || others.some(([, r]) => r.accept.backend !== backend)) return { outcome: finish(cmd.commandId, 'failed', 'execution_settings_changed') };
    const refusal = admissionRefusal(backend);
    if (refusal) return reconciling(refusal);
    const unowned = others.some(([id, r]) => r.barriers.some((b) => b.effect === 'create_native_session' && ledger.classify(id)[b.effect] === 'uncertain' && !recorded.some((w) => w.generation === b.generation)));
    if (unowned) return reconciling('create_without_recorded_worker');
    const profile = exactProfile(cmd);
    if (!profile) return { outcome: finish(cmd.commandId, 'failed', 'execution_settings_changed') };
    const readiness = await backends[backend].readiness(profile);
    if (readiness?.state !== 'ready') return { outcome: finish(cmd.commandId, 'failed', readiness?.state === 'sign_in_required' ? 'sign_in_required' : 'profile_unavailable') };
    if (!cmd.reporting) return { outcome: finish(cmd.commandId, 'failed', 'startup_failed') };
    const worktree = ledger.runBarrier(runId, 'create_worktree');
    const workspaceDir = bind?.workspaceDir ?? (worktree?.ref?.workspaceRef && stateDir ? join(stateDir, 'worktrees', worktree.ref.workspaceRef) : null);
    const st = workspaceDir ? lstatSync(workspaceDir, { throwIfNoEntry: false }) : null;
    if (!st || !st.isDirectory() || st.isSymbolicLink() || ledger.worktreeArchive(runId)) return { outcome: finish(cmd.commandId, 'failed', 'request_unavailable') };
    const bootId = await readBootId();
    for (const w of recorded) {
      if ((await quiesceRecorded(w, bootId, 'continuation_stop')) !== 'quiesced') return reconciling('worker_not_quiesced');
    }
    if (!controlPlaneFresh()) return { outcome: DEFERRED };
    if (!(await admitSlot(cmd))) return { outcome: DEFERRED };
    const generation = nextGeneration(sessionId);
    const closedAt = Math.max(0, ...recorded.map((w) => w.generation), ...(bind ? [bind.generation] : []));
    for (const [id, r] of others.filter(([id, r]) => id !== prior?.commandId && openForClosure(id, r))) {
      closeOpenCommand(id, r, { by: cmd.commandId, generation: closedAt, sessionId, backend, nativeSessionId: bind?.nativeSessionId });
    }
    const entry = { sessionId, runId, backend, generation, workspaceRef: worktree?.ref?.workspaceRef ?? null, workspaceDir, worker: null, stop: null, stopOwned: null, summarySource: null };
    entry.stopOwned = boundStop(entry);
    const resolvePrior = (kind, nativeSessionId) => {
      ledger.recordResolution(prior.commandId, { effect: 'create_native_session', kind, by: cmd.commandId, evidence: { nativeSessionId, source: kind === 'native_absent' ? 'claude_resume_not_found' : 'native_resume_bound', generation } });
      closeOpenCommand(prior.commandId, prior.record, { by: cmd.commandId, generation: prior.generation, sessionId, backend, nativeSessionId });
    };
    log({ msg: 'native session reopened for an explicit prompt', commandId: cmd.commandId, sessionId, generation, exactCreate: Boolean(prior) });
    try {
      entry.worker = assertWorker(await backends[backend].open({
        sessionId, runId, profile, workspaceDir, reporting: cmd.reporting,
        resume: bind ? { nativeSessionId: bind.nativeSessionId, bound: true } : { nativeSessionId: prior.nativeSessionId, bound: false }, generation,
        spawn: boundSpawn(entry),
        effects: openEffects({ ledger, commandId: cmd.commandId, sessionId, runId, backend, generation, workspaceDir,
          prior: prior ? { nativeSessionId: prior.nativeSessionId, onAbsent: async (nativeSessionId) => resolvePrior('native_absent', nativeSessionId) } : null }),
        stopOwned: entry.stopOwned,
      }));
    } catch (err) {
      if (prior && !ledger.commandRecord(prior.commandId).closure) {
        log({ msg: 'native exact create not resolved', commandId: cmd.commandId, error: err?.message, code: err?.code });
        return reconciling('exact_create_unresolved');
      }
      return { outcome: finishAfterError(cmd.commandId, err) };
    }
    if (prior && !ledger.commandRecord(prior.commandId).closure) {
      const rebound = ledger.bindings().find((b) => b.sessionId === sessionId && b.generation === generation && b.nativeSessionId === prior.nativeSessionId);
      if (!rebound) {
        await entry.worker.close({ reason: 'unproven_resume' });
        return reconciling('resume_without_exact_bind');
      }
      resolvePrior('native_present', prior.nativeSessionId);
    }
    ledger.appendEvent({ sessionId, runId, generation, kind: 'binding', nativeEventId: `ff:binding:${generation}`, payload: { backend, event: { nativeSessionId: entry.worker.nativeSessionId, generation } } });
    live.set(sessionId, entry);
    pump(entry);
    return { entry };
  }

  async function promptStage(cmd) {
    let owned = ownedWorker(cmd, { reopenable: true });
    const reopened = Boolean(owned.reopen);
    if (owned.reopen) owned = await reopenSession(cmd);
    if (owned.outcome) return owned.outcome;
    if (!exactProfile(cmd)) {
      log({ msg: 'native prompt refused', commandId: cmd.commandId, reason: 'profile_revision_mismatch' });
      return finish(cmd.commandId, 'failed', 'execution_settings_changed');
    }
    if (!cmd.text) return finish(cmd.commandId, 'failed', 'request_unavailable');
    if (!controlPlaneFresh()) return DEFERRED;
    if (!(await admitSlot(cmd))) return DEFERRED;
    if (cmd.behavior === 'interrupt' && !reopened) {
      const interrupted = await interruptWorker(cmd.commandId, owned.entry, { finishOnSuccess: false });
      if (interrupted) return interrupted;
    }
    const idle = typeof owned.entry.worker.idle === 'function' && owned.entry.worker.idle() === true;
    return sendPrompt(cmd.commandId, owned.entry, cmd.text, cmd.behavior === 'steer' && !reopened && !idle ? 'steer' : 'start');
  }

  function ffRequestId(entry, nativeRequestId) {
    return createHash('sha256').update(`${entry.sessionId}|${entry.backend}|${entry.generation}|${nativeRequestId}`).digest('hex').slice(0, 32);
  }

  const answerChains = new Map();
  function serializeAnswer(entry, nativeRequestId, fn) {
    const key = `${entry.sessionId}\u0000${entry.generation}\u0000${nativeRequestId}`;
    const next = (answerChains.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {
    });
    answerChains.set(key, tail);
    tail.then(() => {
      if (answerChains.get(key) === tail) answerChains.delete(key);
    });
    return next;
  }

  async function dispatchAnswer(commandId, entry, { nativeRequestId, response, source }) {
    const barrier = createCommandBarrier({ ledger, commandId, effect: 'respond', generation: entry.generation });
    let result;
    try {
      result = await entry.worker.respond({ commandId, nativeRequestId, response, source, barrier });
    } catch (err) {
      return finishAfterError(commandId, err);
    }
    if (result?.state === 'dispatched') {
      ledger.receipt(commandId, { effect: 'respond', evidence: { state: 'dispatched' } });
      if (source === 'local') spool(entry, { kind: 'attention', nativeEventId: `ff:local:${commandId}`, payload: { nativeRequestId, state: 'resolved', resolvedBy: 'host' } });
      return finish(commandId, 'applied');
    }
    if (result?.state === 'failed') {
      if (result.errorCode === 'request_unavailable' && hasBarrier(commandId, 'respond')) {
        ledger.recordNoWrite(commandId, { effect: 'respond', generation: entry.generation, sessionId: entry.sessionId, backend: entry.backend, evidence: 'ff_suppressed' });
      }
      return finish(commandId, 'failed', PUBLIC_FAILURES.has(result.errorCode) ? result.errorCode : 'request_unavailable');
    }
    return finish(commandId, 'reconciling', 'reconciling');
  }

  async function respondStage(cmd) {
    const current = live.get(cmd.sessionId);
    if (!current && cmd.generation !== undefined && ledger.workers().some((w) => w.sessionId === cmd.sessionId && w.runId === cmd.runId && w.generation === cmd.generation)) {
      log({ msg: 'native answer refused', commandId: cmd.commandId, reason: 'request_expired', generation: cmd.generation });
      return finish(cmd.commandId, 'failed', 'request_unavailable');
    }
    const owned = ownedWorker(cmd);
    if (owned.outcome) return owned.outcome;
    const { entry } = owned;
    if (!cmd.nativeRequestId || !cmd.response) return finish(cmd.commandId, 'failed', 'request_unavailable');
    if (cmd.generation !== undefined && cmd.generation !== entry.generation) {
      log({ msg: 'native answer refused', commandId: cmd.commandId, reason: 'generation_mismatch' });
      return finish(cmd.commandId, 'failed', 'request_unavailable');
    }
    const response = cmd.fingerprint === undefined ? cmd.response : { ...cmd.response, fingerprint: cmd.fingerprint };
    return serializeAnswer(entry, cmd.nativeRequestId, () => {
      const resolved = resolveOptionIds(entry, cmd.nativeRequestId, cmd.fingerprint, response.selections);
      if (resolved.errorCode) {
        log({ msg: 'native answer refused', commandId: cmd.commandId, reason: 'option_ids_unresolved', code: resolved.errorCode });
        return finish(cmd.commandId, 'failed', resolved.errorCode);
      }
      const dispatched = resolved.selections === undefined ? response : { ...response, selections: resolved.selections };
      return dispatchAnswer(cmd.commandId, entry, { nativeRequestId: cmd.nativeRequestId, response: dispatched, source: 'web' });
    });
  }

  const OPTION_ID = /^o(0|[1-9][0-9]{0,2})$/;
  function resolveOptionIds(entry, nativeRequestId, fingerprint, selections) {
    if (selections === null || typeof selections !== 'object' || Array.isArray(selections)) return { selections: undefined };
    const entries = Object.entries(selections);
    const byId = entries.filter(([, sel]) => sel && typeof sel === 'object' && Object.hasOwn(sel, 'optionIds'));
    if (byId.length === 0) return { selections: undefined };
    if (byId.length !== entries.length || byId.some(([, sel]) => Object.hasOwn(sel, 'selected'))) return { errorCode: 'invalid_response' };
    const request = entry.worker.pending().find((r) => r.nativeRequestId === nativeRequestId);
    if (!request || (fingerprint !== undefined && request.fingerprint !== fingerprint)) return { errorCode: 'request_unavailable' };
    const out = {};
    for (const [questionId, sel] of entries) {
      const question = (request.questions ?? []).find((q) => q.id === questionId);
      const ids = sel.optionIds;
      if (!question || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && OPTION_ID.test(id)) || new Set(ids).size !== ids.length) return { errorCode: 'invalid_response' };
      const options = Array.isArray(question.options) ? question.options : [];
      const indexes = ids.map((id) => Number(id.slice(1)));
      if (indexes.some((i) => i >= options.length)) return { errorCode: 'invalid_response' };
      out[questionId] = { selected: indexes.map((i) => options[i].label), ...(Object.hasOwn(sel, 'other') ? { other: sel.other } : {}) };
    }
    return { selections: out };
  }

  function pendingByRequestId(requestId) {
    for (const entry of live.values()) {
      for (const request of entry.worker.pending()) if (ffRequestId(entry, request.nativeRequestId) === requestId) return { entry, request };
    }
    return null;
  }

  function registerAnswerValues(sessionId, request, selections) {
    for (const question of request.questions ?? []) {
      const sel = selections[question.id];
      if (!sel) continue;
      if (typeof sel.other === 'string' && sel.other !== '') privacy.registerLocalValue(sessionId, sel.other);
      for (const label of sel.selected) privacy.registerLocalValue(sessionId, label);
    }
  }

  function localReplay(localCommandId, rec) {
    if (rec.accept.kind !== 'local_answer') throw new RequestError('invalid_request');
    const pending = inflight.get(localCommandId);
    if (pending) return pending;
    if (rec.outcome) return { state: rec.outcome.state, ...(rec.outcome.errorCode ? { errorCode: rec.outcome.errorCode } : {}) };
    if (rec.barriers.length) return { state: 'reconciling', errorCode: 'reconciling' };
    log({ msg: 'host-local answer lost before its barrier', localCommandId });
    return finish(localCommandId, 'failed', 'request_unavailable');
  }

  async function interruptWorker(commandId, entry, { finishOnSuccess, confirmCancel = false }) {
    const barrier = createCommandBarrier({ ledger, commandId, effect: 'interrupt', generation: entry.generation });
    let result;
    try {
      result = await entry.worker.interrupt({ commandId, barrier });
    } catch (err) {
      return finishAfterError(commandId, err);
    }
    for (const s of result?.settled ?? []) {
      const rec = typeof s?.commandId === 'string' ? ledger.commandRecord(s.commandId) : null;
      if (s?.dispatched === false && rec?.barriers.some((b) => b.effect === 'prompt') && !rec.receipts.some((r) => r.effect === 'prompt')) {
        ledger.recordNoWrite(s.commandId, { effect: 'prompt', generation: entry.generation, sessionId: entry.sessionId, backend: entry.backend, evidence: 'ff_suppressed' });
      }
    }
    if (result?.dispatched === false) {
      if (hasBarrier(commandId, 'interrupt')) ledger.recordNoWrite(commandId, { effect: 'interrupt', generation: entry.generation, sessionId: entry.sessionId, backend: entry.backend, evidence: 'ff_suppressed' });
    } else {
      ledger.receipt(commandId, { effect: 'interrupt', evidence: { terminal: result?.terminal ?? null } });
    }
    const settled = (result?.settled ?? []).map((x) => ({ commandId: x.commandId, outcome: x.outcome, dispatched: x.dispatched }));
    const nothingRan = !result?.terminal && settled.every((x) => x.dispatched === false || x.outcome === 'cancelled');
    if (confirmCancel && (result?.terminal === 'interrupted' || nothingRan)) {
      spool(entry, { kind: 'state', nativeEventId: `ff:cancel:${commandId}`, payload: { state: 'cancelled', cancelCommandId: commandId, generation: entry.generation, nativeTerminal: result?.terminal ?? null, dispatched: result?.dispatched !== false, settled } });
    }
    return finishOnSuccess ? finish(commandId, 'applied') : null;
  }

  function nativeUntouched(commandId) {
    const r = ledger.commandRecord(commandId);
    return r.barriers.every((b) => b.effect === 'create_worktree' && r.receipts.some((x) => x.effect === 'create_worktree'));
  }

  function fencedByCancel(cmd) {
    const ids = ledger.commandIds();
    const own = ids.indexOf(cmd.commandId);
    return ids.slice(0, own < 0 ? ids.length : own).some((id) => {
      const { accept } = ledger.commandRecord(id);
      return accept.kind === 'cancel' && accept.sessionId === cmd.sessionId && accept.runId === cmd.runId && ledger.commandRecord(id).outcome?.state === 'applied';
    });
  }

  function launchOf(sessionId, runId) {
    let found = null;
    for (const commandId of ledger.commandIds()) {
      const { accept } = ledger.commandRecord(commandId);
      if (LAUNCH_KINDS.has(accept.kind) && accept.sessionId === sessionId && accept.runId === runId) found = commandId;
    }
    return found;
  }

  async function cancelStage(cmd) {
    const launch = launchOf(cmd.sessionId, cmd.runId);
    const rec = launch ? ledger.commandRecord(launch) : null;
    const busy = launch !== null && (inflight.has(launch) || inflight.has(`deliver:${launch}`));
    if (!rec && !live.has(cmd.sessionId) && !ledger.workers().some((w) => w.sessionId === cmd.sessionId)) {
      log({ msg: 'native cancel fences an unseen launch', commandId: cmd.commandId, sessionId: cmd.sessionId });
      return finish(cmd.commandId, 'applied', undefined, { dispatched: false });
    }
    if (rec && !busy && rec.outcome?.state !== 'failed' && rec.outcome?.state !== 'applied' && !live.has(cmd.sessionId) && nativeUntouched(launch)) {
      log({ msg: 'native launch cancelled before dispatch', commandId: cmd.commandId, launch });
      finish(launch, 'failed', 'request_unavailable');
      return finish(cmd.commandId, 'applied', undefined, { dispatched: false });
    }
    if (!live.has(cmd.sessionId) && closed.get(cmd.sessionId)?.runId !== cmd.runId) return closeSession(cmd);
    const owned = ownedWorker(cmd);
    if (owned.outcome) return owned.outcome;
    if (rec && !busy && rec.outcome?.state === 'accepted' && !hasBarrier(launch, 'prompt')) {
      log({ msg: 'native first prompt withdrawn by cancel', commandId: cmd.commandId, launch });
      finish(launch, 'failed', 'request_unavailable');
    }
    return interruptWorker(cmd.commandId, owned.entry, { finishOnSuccess: true, confirmCancel: true });
  }

  async function closeSession(cmd) {
    const { commandId, sessionId, runId, backend } = cmd;
    const reconciling = (reason) => {
      log({ msg: 'native operator closure not proven', commandId, sessionId, reason });
      return finish(commandId, 'reconciling', 'reconciling');
    };
    const others = sessionCommands(cmd);
    if (others.some(([id]) => inflight.has(id) || inflight.has(`deliver:${id}`))) return reconciling('command_in_flight');
    const recorded = ledger.workers().filter((w) => w.sessionId === sessionId && w.runId === runId);
    if (recorded.some((w) => w.backend !== backend) || others.some(([, r]) => r.accept.backend !== backend)) return finish(commandId, 'failed', 'execution_settings_changed');
    if (recorded.length && containment?.state !== 'verified') return reconciling('containment_unavailable');
    const unowned = others.some(([id, r]) => r.barriers.some((b) => b.effect === 'create_native_session' && ledger.classify(id)[b.effect] === 'uncertain' && !recorded.some((w) => w.generation === b.generation)));
    if (unowned) return reconciling('create_without_recorded_worker');
    const bootId = await readBootId();
    for (const w of recorded) {
      if ((await quiesceRecorded(w, bootId, 'closure_stop')) !== 'quiesced') return reconciling('worker_not_quiesced');
    }
    const bind = ledger.bindings().filter((b) => b.sessionId === sessionId && b.runId === runId).at(-1) ?? null;
    const generation = Math.max(0, ...recorded.map((w) => w.generation), ...(bind ? [bind.generation] : []));
    for (const [id, r] of others.filter(([id, r]) => openForClosure(id, r))) {
      closeOpenCommand(id, r, { by: commandId, generation, sessionId, backend, nativeSessionId: bind?.nativeSessionId });
    }
    spool({ sessionId, runId, generation, backend }, { kind: 'state', nativeEventId: `ff:closure:${commandId}`, payload: { state: 'cancelled', cancelCommandId: commandId, closure: 'operator', generation } });
    await settleSlots();
    return finish(commandId, 'applied', undefined, { closure: 'operator' });
  }

  async function admitSlot(cmd) {
    const backend = cmd.backend;
    if (!SLOT_BACKENDS.includes(backend)) return true;
    if (!LAUNCH_KINDS.has(cmd.kind) && cmd.kind !== 'prompt') return true;
    if (slots.holderOf(cmd.sessionId) !== null) return true;
    const viaGrant = (cmd.slotGranted === true || cmd.slotHeld === true) && granted(backend) > 0;
    const free = () => slots.available()[backend] - granted(backend) + (viaGrant ? 1 : 0);
    if (free() <= 0) await settleSlots();
    if (free() <= 0 || !slots.reserve(backend, cmd.sessionId)) {
      log({ msg: 'native admission deferred', commandId: cmd.commandId, backend, reason: 'capacity' });
      return false;
    }
    if (viaGrant) {
      takeGrant(backend, cmd.slotGranted === true ? cmd.grantId : undefined);
      dropEmptyBatches();
    }
    return true;
  }

  async function sessionHoldsSlot(sessionId, bootId) {
    for (const commandId of ledger.commandIds()) {
      const rec = ledger.commandRecord(commandId);
      if (rec.accept.sessionId !== sessionId || rec.closure || rec.accept.kind === 'cancel') continue;
      if (inflight.has(commandId) || inflight.has(`deliver:${commandId}`)) return true;
      const state = rec.outcome?.state;
      const cls = ledger.classify(commandId);
      const uncertain = cls !== 'undispatched' && Object.entries(cls).some(([effect, st]) => st === 'uncertain' && !ledger.noWrite(commandId, effect));
      if (state === 'reconciling' || uncertain) return true;
      if (state === 'accepted' && LAUNCH_KINDS.has(rec.accept.kind)) return true;
    }
    const entry = live.get(sessionId);
    const w = ledger.workers().filter((x) => x.sessionId === sessionId).sort((a, b) => b.generation - a.generation)[0];
    if (!w) return false;
    if (!entry && closed.get(sessionId)?.generation === w.generation) return false;
    let unverifiable = containment?.state !== 'verified' || w.needsRecovery === true || (entry ? Boolean(entry.stop && entry.stop !== 'quiesced') : false);
    let cgroupProcesses = null;
    let cgroupPids = null;
    let escaped = false;
    try {
      const state = await inspect(w, bootId);
      if (!entry || entry.generation !== w.generation) return state.populated !== false;
      if (state.populated === false) cgroupPids = [];
      else if (state.populated === true) {
        const read = await observeLeaf(w, state.leaf);
        cgroupProcesses = Array.isArray(read?.pids) ? read.pids : null;
        cgroupPids = cgroupProcesses?.map((p) => p?.pid) ?? null;
        if (escapesOf(w).length) escaped = true;
      }
      if (w.identity && (await isLive(w.identity))) {
        const held = typeof ops.holds === 'function' && state.leaf ? await ops.holds({ cgroupPath: state.leaf, identity: w.identity }) : undefined;
        if (held === false) escaped = true;
        else if (held === undefined) unverifiable = true;
      }
    } catch (err) {
      log({ msg: 'execution slot activity unreadable', sessionId, error: err?.message, code: err?.code });
      return true;
    }
    const activeTurn = typeof entry.worker.idle !== 'function' || entry.worker.idle() !== true;
    const pendingRequests = entry.worker.pending().length;
    const retainedPids = [];
    try {
      if (!activeTurn && pendingRequests === 0 && Array.isArray(cgroupProcesses) && typeof entry.worker.retainsProcess === 'function') {
        for (const candidate of cgroupProcesses) {
          if (candidate?.pid !== w.identity?.pid && await entry.worker.retainsProcess(candidate)) retainedPids.push(candidate.pid);
        }
      }
    } catch (err) {
      log({ msg: 'execution slot activity unreadable', sessionId, error: err?.message, code: err?.code });
      return true;
    }
    return holdsSlot({
      activeTurn,
      pendingRequests,
      workerPid: w.identity?.pid ?? null,
      cgroupPids,
      retainedPids,
      escaped,
      unverifiable,
    });
  }

  async function settleSlots() {
    const bootId = await readBootId();
    for (const backend of SLOT_BACKENDS) {
      for (const sessionId of slots.snapshot()[backend].sessions) {
        if (await sessionHoldsSlot(sessionId, bootId)) continue;
        slots.release(sessionId);
        log({ msg: 'execution slot released', sessionId, backend });
      }
    }
  }

  async function dispatchNew(cmd) {
    try {
      if ((wrapping.has(cmd.runId) || ledger.worktreeArchive(cmd.runId) || ledger.archiveResolution(cmd.runId)) && !CONTROL_KINDS.has(cmd.kind)) {
        log({ msg: 'native command refused', commandId: cmd.commandId, runId: cmd.runId, reason: 'run_wrapped_up' });
        return finish(cmd.commandId, 'failed', LAUNCH_KINDS.has(cmd.kind) ? 'startup_failed' : 'request_unavailable');
      }
      if (LAUNCH_KINDS.has(cmd.kind)) return await bindStage(cmd);
      if (cmd.kind === 'prompt') return await promptStage(cmd);
      if (cmd.kind === 'permission') return await respondStage(cmd);
      if (cmd.kind === 'cancel') return await cancelStage(cmd);
      log({ msg: 'native command kind not supported', commandId: cmd.commandId, kind: cmd.kind });
      return finish(cmd.commandId, 'failed', 'profile_unavailable');
    } catch (err) {
      if (err?.code === 'admission_stopped') throw err;
      return finishAfterError(cmd.commandId, err);
    }
  }

  function replay(cmd) {
    const pending = inflight.get(cmd.commandId);
    if (pending) return pending;
    const rec = ledger.commandRecord(cmd.commandId);
    if (rec.closure) return { state: 'failed', errorCode: 'request_unavailable' };
    if (rec.outcome) {
      /** @type {{ state: string, errorCode?: string, binding?: object, closure?: string }} */
      const out = { state: rec.outcome.state, ...(rec.outcome.errorCode ? { errorCode: rec.outcome.errorCode } : {}), ...(rec.outcome.dispatched === false ? { dispatched: false } : {}), ...(rec.outcome.closure ? { closure: rec.outcome.closure } : {}) };
      if (['accepted', 'applied'].includes(out.state) && LAUNCH_KINDS.has(rec.accept.kind)) {
        const binding = bindingOf(rec.accept.sessionId, rec.accept.runId);
        if (binding) out.binding = binding;
      }
      return out;
    }
    if (ledger.classify(cmd.commandId) === 'undispatched') return track(cmd.commandId, () => dispatchNew(cmd));
    return { state: 'reconciling', errorCode: 'reconciling' };
  }

  function unresolvedCommands(runId) {
    let count = 0;
    for (const commandId of ledger.commandIds()) {
      const rec = ledger.commandRecord(commandId);
      if (rec.accept.runId !== runId || rec.closure) continue;
      const state = rec.outcome?.state;
      const cls = ledger.classify(commandId);
      const uncertain = cls !== 'undispatched' && Object.entries(cls).some(([effect, s]) => s === 'uncertain' && !ledger.noWrite(commandId, effect));
      const undelivered = state === 'accepted' && LAUNCH_KINDS.has(rec.accept.kind);
      if (inflight.has(commandId) || inflight.has(`deliver:${commandId}`) || !state || state === 'reconciling' || uncertain || undelivered) count += 1;
    }
    return count;
  }

  async function ownedWorktree({ runId, repositoryKey, workspaceRef }) {
    const barrier = ledger.runBarrier(runId, 'create_worktree');
    const bound = ledger.bindings().find((b) => b.runId === runId);
    const repoPath = repositories[repositoryKey];
    if (!barrier || !bound || !repoPath || !stateDir || workspaceRef !== runWorkspaceRef(runId) || barrier.ref?.workspaceRef !== workspaceRef) return { problem: 'ownership_unverified' };
    if (!ledger.commandRecord(barrier.commandId)?.receipts.some((r) => r.effect === 'create_worktree')) return { problem: 'ownership_unverified' };
    let directory;
    try {
      directory = join(realpathSync(join(stateDir, 'worktrees')), workspaceRef);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return { problem: 'worktree_missing' };
    }
    if (bound.workspaceDir !== directory) return { problem: 'ownership_unverified' };
    const branch = barrier.ref.branchName;
    const problem = await ownedWorktreeProblem({ repoPath, directory, branchName: branch });
    if (problem === 'missing') return { problem: 'worktree_missing', directory, branch, repoPath };
    if (problem === 'git_unreadable') return { problem: 'git_unreadable', directory, branch, repoPath };
    if (problem !== null && problem !== 'dirty') return { problem: 'ownership_unverified', directory, branch, repoPath };
    return { problem: null, directory, branch, repoPath, expectedUpstream: barrier.ref.upstream ?? null };
  }

  async function wrapupCheck(params) {
    const counts = new Map();
    const add = (code, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
    const worktree = await ownedWorktree(params);
    if (worktree.problem) add(worktree.problem);
    if (worktree.problem === 'worktree_missing' && ledger.archiveAttempt(params.runId) && !ledger.worktreeArchive(params.runId)) add('archive_receipt_missing');
    if (containment?.state !== 'verified') add('descendants_unverifiable');
    const bootId = await readBootId();
    const sessions = [];
    for (const w of ledger.workers().filter((x) => x.runId === params.runId)) {
      const entry = live.get(w.sessionId);
      const current = entry?.generation === w.generation;
      if (current) {
        const pending = entry.worker.pending().length;
        if (pending) add('pending_requests', pending);
      }
      sessions.push({ sessionId: w.sessionId, backend: w.backend, generation: w.generation, state: current ? (entry.worker.idle?.() === true ? 'idle' : 'active') : closed.get(w.sessionId)?.generation === w.generation ? 'closed' : 'not_live' });
      if (containment?.state !== 'verified') continue;
      const state = await inspect(w, bootId);
      if (state.populated === null || w.needsRecovery) {
        add('descendants_unverifiable');
        continue;
      }
      if (state.populated) add('owned_activity');
      if (escapesOf(w).length) add('descendants_escaped');
      if (w.identity && (await isLive(w.identity))) {
        const held = typeof ops.holds === 'function' && state.leaf ? await ops.holds({ cgroupPath: state.leaf, identity: w.identity }) : undefined;
        if (held === false) add('descendants_escaped');
        else if (held === undefined) add('descendants_unverifiable');
      }
    }
    const unresolved = unresolvedCommands(params.runId);
    if (unresolved) add('unresolved_commands', unresolved);
    /** @type {Record<string, unknown>} */
    let git = { ok: false, failCode: 'git_unreadable' };
    if (worktree.directory && worktree.problem !== 'worktree_missing') {
      const checked = await worktreeGitCheck({ directory: worktree.directory, branchName: worktree.branch, expectedUpstream: worktree.expectedUpstream ?? null });
      git = checked.git;
      for (const b of checked.blockers) add(b.code, b.count ?? 1);
      const scan = typeof ops.worktreeUsers === 'function' ? ops.worktreeUsers : worktreeUsers;
      const { users, unverifiable } = await scan({ directory: worktree.directory });
      if (users.length) add('worktree_in_use', users.length);
      if (unverifiable) {
        log({ msg: 'native wrap-up process state unreadable', runId: params.runId, processes: unverifiable });
        add('descendants_unverifiable');
      }
    }
    const liveNow = [...live.values()].filter((e) => e.runId === params.runId).length;
    if (liveNow && !counts.has('owned_activity')) add('owned_activity', liveNow);
    const unresolvedNow = unresolvedCommands(params.runId);
    if (unresolvedNow && !counts.has('unresolved_commands')) add('unresolved_commands', unresolvedNow);
    const blockers = [...counts].map(([code, count]) => (count > 1 ? { code, count } : { code }));
    if (blockers.length) log({ msg: 'native wrap-up blocked', runId: params.runId, blockers });
    return { owned: worktree.problem === null, workspaceRef: params.workspaceRef, directoryKnown: Boolean(worktree.directory), sessions, git, blockers, worktree };
  }

  const publicCheck = ({ worktree: _worktree, ...check }) => check;

  function encodedEvent(event) {
    return Buffer.from(JSON.stringify(event.payload), 'utf8');
  }

  return {
    async hello() {
      return { deliveredSeq: ledger.deliveredSeq, admissionStopped: ledger.admissionStopped };
    },

    async reserveSlots(params) {
      const { notAfter } = parse(ReserveSlotsParams, params);
      await settleSlots();
      const free = slots.available();
      dropEmptyBatches();
      const heldBatches = [...batches].map(([id, b]) => ({ grantId: id, counts: { ...b.counts }, notAfter: b.notAfter, version: b.version }));
      const availableSlots = {};
      for (const backend of SLOT_BACKENDS) availableSlots[backend] = Math.min(MAX_POLL_SLOTS, Math.max(0, free[backend] - granted(backend)));
      const grantId = randomUUID();
      if (SLOT_BACKENDS.some((k) => availableSlots[k] > 0)) batches.set(grantId, { counts: { ...availableSlots }, notAfter: notAfter ?? null, version: 1 });
      return { availableSlots, grantId, heldBatches };
    },

    async releaseSlots(params) {
      const { grantId, unused, version } = parse(ReleaseSlotsParams, params);
      const targets = grantId ? [batches.get(grantId)].filter(Boolean) : [...batches.values()];
      if (version !== undefined && targets.some((b) => b.version !== version)) return { released: false, stale: true };
      for (const b of targets) b.version += 1;
      for (const backend of SLOT_BACKENDS) {
        let n = unused[backend] ?? 0;
        for (const b of targets) {
          const take = Math.min(n, b.counts[backend]);
          b.counts[backend] -= take;
          n -= take;
        }
      }
      dropEmptyBatches();
      return { released: true };
    },

    async submit(params) {
      const cmd = parse(SubmitParams, params);
      if (ledger.admissionStopped && !ledger.commandRecord(cmd.commandId)) {
        log({ msg: 'native admission refused', commandId: cmd.commandId, backend: cmd.backend, reason: 'ledger_stopped' });
        return { state: 'failed', errorCode: 'startup_failed' };
      }
      const recorded = ledger.submit({ commandId: cmd.commandId, digest: cmd.digest, runId: cmd.runId, sessionId: cmd.sessionId, backend: cmd.backend, kind: cmd.kind });
      if (recorded.state !== 'new') return replay(cmd);
      return track(cmd.commandId, () => dispatchNew(cmd));
    },

    async deliver(params) {
      const { commandId, digest, text } = parse(DeliverParams, params);
      const rec = ledger.commandRecord(commandId);
      if (!rec || !LAUNCH_KINDS.has(rec.accept.kind)) throw new RequestError('invalid_request');
      if (rec.accept.digest !== digest) throw new RequestError('digest_mismatch');
      if (rec.closure) return { state: 'failed', errorCode: 'request_unavailable' };
      const key = `deliver:${commandId}`;
      if (inflight.has(key)) return inflight.get(key);
      if (rec.barriers.some((b) => b.effect === 'prompt')) {
        if (rec.receipts.some((r) => r.effect === 'prompt')) return { state: 'applied' };
        if (ledger.noWrite(commandId, 'prompt')) return { state: 'failed', errorCode: 'request_unavailable' };
        return { state: 'reconciling', errorCode: 'reconciling' };
      }
      if (rec.outcome?.state !== 'accepted') return rec.outcome ? { state: rec.outcome.state, ...(rec.outcome.errorCode ? { errorCode: rec.outcome.errorCode } : {}) } : { state: 'reconciling', errorCode: 'reconciling' };
      const entry = live.get(rec.accept.sessionId);
      if (!entry || entry.runId !== rec.accept.runId) return { state: 'reconciling', errorCode: 'reconciling' };
      if (wrapping.has(rec.accept.runId) || ledger.worktreeArchive(rec.accept.runId)) {
        log({ msg: 'native delivery refused', commandId, runId: rec.accept.runId, reason: 'run_wrapped_up' });
        return finish(commandId, 'failed', 'request_unavailable');
      }
      return track(key, () => (async () => {
        let prompt = text;
        if (rec.accept.kind === 'summarize') {
          const composed = await summaryPrompt(commandId, entry, text);
          if (composed.refused) return composed.refused;
          prompt = composed.text;
        }
        return sendPrompt(commandId, entry, prompt, 'start');
      })().catch((err) => finishAfterError(commandId, err)));
    },

    async events(params) {
      const { afterSeq, limit } = parse(EventsParams, params);
      const out = [];
      let total = 0;
      for (const event of ledger.eventsAfter(afterSeq, limit)) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (size > LARGE_EVENT_BYTES) {
          if (out.length === 0) {
            const { payload: _payload, ...rest } = event;
            out.push({ ...rest, payload: null, chunked: { bytes: encodedEvent(event).length } });
          }
          break;
        }
        if (total + size > EVENT_BATCH_BYTES) break;
        out.push(event);
        total += size;
      }
      return { events: out };
    },

    async eventChunk(params) {
      const { seq: at, offset } = parse(EventChunkParams, params);
      const event = ledger.eventAt(at);
      if (!event) throw new RequestError('request_unavailable');
      const bytes = encodedEvent(event);
      if (offset > bytes.length) throw new RequestError('invalid_request');
      return { total: bytes.length, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') };
    },

    async ackEvents(params) {
      const { uptoSeq } = parse(AckParams, params);
      ledger.markDelivered(uptoSeq);
      return { deliveredSeq: ledger.deliveredSeq };
    },

    async status() {
      return {
        containment: { state: containment?.state === 'verified' ? 'verified' : 'unavailable' },
        admissionStopped: ledger.admissionStopped || stopping,
        supervisor: { pid: process.pid },
        capacity: Object.fromEntries(Object.entries(slots.snapshot()).map(([backend, { limit, sessions }]) => [backend, { limit, used: sessions.length }])),
        profiles: await publishReadiness({ profiles, containment, backends }),
        workers: await workerStates(),
      };
    },

    async stop(params) {
      const { timeoutMs } = parse(StopParams, params);
      stopping = true;
      const started = Date.now();
      const graceMs = Math.min(DEFAULT_STOP_TIMEOUT_MS, Math.floor(timeoutMs / 2));
      for (const entry of [...live.values()]) {
        if (typeof entry.worker.idle === 'function' && entry.worker.idle() === true) continue;
        const commandId = `ff-stop:${randomUUID()}`;
        ledger.submit({ commandId, digest: 'ff-stop', runId: entry.runId, sessionId: entry.sessionId, backend: entry.backend, kind: 'stop_interrupt' });
        await interruptWorker(commandId, entry, { finishOnSuccess: true, confirmCancel: true });
      }
      let uncertain = 0;
      for (const entry of [...live.values()]) {
        entry.closing = true;
        entry.shutdownGraceMs = graceMs;
        entry.shutdownKillWaitMs = Math.max(0, timeoutMs - graceMs - (Date.now() - started));
        try {
          await entry.worker.close({ reason: 'supervisor_stop' });
        } catch (err) {
          log({ msg: 'native worker close failed', sessionId: entry.sessionId, error: err?.message });
        }
        const result = await entry.stopOwned({ reason: 'shutdown' });
        if (result === 'quiesced') live.delete(entry.sessionId);
        else uncertain += 1;
      }
      const bootId = await readBootId();
      let unproven = 0;
      const targets = [];
      for (const w of ledger.workers()) {
        if (live.get(w.sessionId)?.generation === w.generation) continue;
        const state = await inspect(w, bootId);
        if (state.populated === null || (state.populated && !state.killable)) unproven += 1;
        else if (state.populated) targets.push(w);
      }
      for (const w of targets) {
        try {
          await ops.kill({ cgroupPath: w.cgroupPath, generation: w.generation, sessionId: w.sessionId });
        } catch (err) {
          if (!(err instanceof ContainmentError && err.code === 'leaf_missing')) throw err;
        }
      }
      const deadline = started + timeoutMs;
      let remaining = targets;
      for (;;) {
        const next = [];
        for (const w of remaining) if ((await inspect(w, bootId)).populated !== false) next.push(w);
        remaining = next;
        if (remaining.length === 0 || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const w of ledger.workers()) if (escapesOf(w).length) uncertain += 1;
      if (remaining.length || unproven || uncertain) log({ msg: 'supervisor stop could not confirm every worker stopped', populated: remaining.length, unproven, uncertain });
      const state = remaining.length || unproven || uncertain ? 'uncertain' : 'stopped';
      onStopped?.(state);
      return { state };
    },

    async pendingQuestions() {
      const requests = [];
      for (const entry of live.values()) {
        for (const r of entry.worker.pending()) {
          requests.push({
            requestId: ffRequestId(entry, r.nativeRequestId), sessionId: entry.sessionId, runId: entry.runId, backend: entry.backend, generation: entry.generation,
            nativeRequestId: r.nativeRequestId, kind: r.kind, fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : null,
            secret: r.secret === true, hostOnly: r.hostOnly === true || r.secret === true,
            questions: Array.isArray(r.questions) ? r.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description ?? null })) : null, multiSelect: q.multiSelect === true, allowOther: q.allowOther === true, secret: q.secret === true })) : null,
          });
        }
      }
      return { requests };
    },

    async localAnswer(params) {
      const p = parse(LocalAnswerParams, params);
      const known = ledger.commandRecord(p.localCommandId);
      if (known) return localReplay(p.localCommandId, known);
      if (refusedLocal.has(p.localCommandId)) return { ...refusedLocal.get(p.localCommandId) };
      const found = pendingByRequestId(p.requestId);
      if (!found || found.request.kind !== 'question' || !/^[0-9a-f]{64}$/.test(found.request.fingerprint ?? '')) {
        log({ msg: 'host-local answer refused', localCommandId: p.localCommandId, reason: found ? 'not_a_question' : 'not_pending' });
        const refused = { state: 'failed', errorCode: 'request_unavailable' };
        refusedLocal.set(p.localCommandId, refused);
        return { ...refused };
      }
      if (!controlPlaneFresh()) return { state: 'failed', errorCode: 'request_unavailable' };
      const { entry, request } = found;
      ledger.acceptLocal({ localCommandId: p.localCommandId, runId: entry.runId, sessionId: entry.sessionId, backend: entry.backend, requestId: p.requestId, fingerprint: request.fingerprint, generation: entry.generation, operation: 'answer' });
      return track(p.localCommandId, () => serializeAnswer(entry, request.nativeRequestId, () => {
        if (!controlPlaneFresh()) return finish(p.localCommandId, 'failed', 'request_unavailable');
        registerAnswerValues(entry.sessionId, request, p.selections);
        return dispatchAnswer(p.localCommandId, entry, { nativeRequestId: request.nativeRequestId, response: { selections: p.selections, fingerprint: request.fingerprint }, source: 'local' });
      }));
    },

    async workspace(params) {
      const { runId } = parse(WorkspaceParams, params);
      if (ledger.worktreeArchive(runId) || ledger.archiveResolution(runId)) return { workspaceDir: null };
      const bound = ledger.bindings().filter((b) => b.runId === runId).at(-1);
      return { workspaceDir: bound?.workspaceDir ?? null };
    },

    async wrapupPreflight(params) {
      const p = parse(WrapupParams, params);
      const unknown = ledger.archiveResolution(p.runId);
      if (unknown) return { owned: true, workspaceRef: p.workspaceRef, directoryKnown: false, sessions: [], git: { ok: false, failCode: 'worktree_missing' }, blockers: [{ code: 'archive_outcome_unknown' }] };
      const archived = ledger.worktreeArchive(p.runId);
      if (archived) return { owned: true, workspaceRef: p.workspaceRef, directoryKnown: false, sessions: [], archived, git: { ok: true, branch: archived.branch, headCommit: archived.headCommit, upstream: archived.upstream, uncommitted: 0, untracked: 0, unpushed: 0 }, blockers: [] };
      return publicCheck(await wrapupCheck(p));
    },

    async wrapupCloseSessions(params) {
      const { runId } = parse(CloseParams, params);
      if (wrapping.has(runId)) return { ok: false, blockers: [{ code: 'wrapup_in_progress' }] };
      wrapping.add(runId);
      try {
        const entries = [...live.values()].filter((e) => e.runId === runId);
        const counts = new Map();
        const add = (code, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
        if (containment?.state !== 'verified') add('descendants_unverifiable');
        for (const entry of entries) {
          const pending = entry.worker.pending().length;
          if (pending) add('pending_requests', pending);
          if (typeof entry.worker.idle !== 'function' || entry.worker.idle() !== true) add('owned_activity');
        }
        const unresolved = unresolvedCommands(runId);
        if (unresolved) add('unresolved_commands', unresolved);
        const blockers = [...counts].map(([code, count]) => (count > 1 ? { code, count } : { code }));
        if (blockers.length) {
          log({ msg: 'native wrap-up closure blocked', runId, blockers });
          return { ok: false, blockers };
        }
        let closedSessions = 0;
        const failures = [];
        for (const entry of entries) {
          entry.closing = true;
          await entry.worker.close({ reason: 'wrapup' });
          const stop = await entry.stopOwned({ reason: 'wrapup' });
          if (stop !== 'quiesced') {
            failures.push({ code: 'descendants_unverifiable' });
            continue;
          }
          live.delete(entry.sessionId);
          closed.set(entry.sessionId, entry);
          closedSessions += 1;
        }
        if (failures.length) log({ msg: 'native wrap-up closure incomplete', runId, failures });
        return failures.length ? { ok: false, blockers: failures, closedSessions } : { ok: true, closedSessions };
      } finally {
        wrapping.delete(runId);
      }
    },

    async wrapupArchive(params) {
      const p = parse(WrapupParams, params);
      const prior = ledger.worktreeArchive(p.runId);
      if (prior) return { ok: true, repeated: true, receipt: prior };
      const unknown = ledger.archiveResolution(p.runId);
      if (unknown) return { ok: false, blockers: [{ code: 'archive_outcome_unknown' }], resolution: { outcome: unknown.outcome, attemptAt: unknown.attemptAt } };
      if (wrapping.has(p.runId)) return { ok: false, blockers: [{ code: 'wrapup_in_progress' }] };
      wrapping.add(p.runId);
      try {
        const check = await wrapupCheck(p);
        const attempt = ledger.archiveAttempt(p.runId);
        const onlyMissing = check.blockers.length > 0 && check.blockers.every((b) => b.code === 'worktree_missing' || b.code === 'archive_receipt_missing');
        if (attempt && onlyMissing && check.worktree.directory && check.worktree.repoPath && attempt.workspaceRef === p.workspaceRef) {
          const evidence = await missingWorktreeEvidence({ repoPath: check.worktree.repoPath, directory: check.worktree.directory, branchName: attempt.branch });
          const gone = lstatSync(check.worktree.directory, { throwIfNoEntry: false }) === undefined;
          if (gone && !evidence.worktreeRegistered) {
            const resolution = ledger.recordArchiveResolution({ runId: p.runId, workspaceRef: p.workspaceRef, evidence: { directoryMissing: true, worktreeRegistered: false, branchHead: evidence.branchHead } });
            log({ msg: 'native archive attempt closed with an unknown outcome', runId: p.runId, workspaceRef: p.workspaceRef });
            return { ok: false, blockers: [{ code: 'archive_outcome_unknown' }], resolution: { outcome: resolution.outcome, attemptAt: resolution.attemptAt } };
          }
        }
        if (check.blockers.length) return { ok: false, preflight: publicCheck(check), blockers: check.blockers };
        const { repoPath, directory, branch, expectedUpstream } = check.worktree;
        ledger.recordArchiveAttempt({ runId: p.runId, workspaceRef: p.workspaceRef, branch });
        const removed = await archiveRunWorktree({ repoPath, directory, expectedBranch: branch, expectedUpstream });
        if (!removed.ok) {
          log({ msg: 'native wrap-up archive refused by the final Git check', runId: p.runId, blockers: removed.blockers });
          return { ok: false, preflight: publicCheck(check), blockers: removed.blockers };
        }
        const final = /** @type {{ headCommit: string, upstream: string }} */ (removed.git);
        const receipt = ledger.recordWorktreeArchived({ runId: p.runId, workspaceRef: p.workspaceRef, branch, headCommit: final.headCommit, upstream: final.upstream });
        log({ msg: 'native worktree archived', runId: p.runId, workspaceRef: p.workspaceRef });
        return { ok: true, preflight: { ...publicCheck(check), git: removed.git }, receipt };
      } finally {
        wrapping.delete(p.runId);
      }
    },

    connectorAttached(_params, ctx) {
      const epoch = ctx?.connectorEpoch;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch <= latestConnectorEpoch) return { attached: false };
      latestConnectorEpoch = epoch;
      attachedConnectorEpoch = epoch;
      controlPlaneOnlineAt = 0;
      return { attached: true };
    },

    controlPlaneStatus(params, ctx) {
      const { online } = parse(ControlPlaneStatusParams, params);
      if (ctx?.connectorEpoch !== attachedConnectorEpoch) return { recorded: false };
      controlPlaneOnlineAt = online ? Date.now() : 0;
      return { recorded: true };
    },

    connectorDetached(_params, ctx) {
      if (ctx?.connectorEpoch !== attachedConnectorEpoch) return { detached: false };
      attachedConnectorEpoch = null;
      controlPlaneOnlineAt = 0;
      log({ msg: 'connector detached with outstanding slot grants', batches: batches.size });
      return { detached: true };
    },

    async closeWorkers(reason) {
      stopping = true;
      for (const entry of live.values()) {
        entry.closing = true;
        try {
          await entry.worker.close({ reason });
        } catch (err) {
          log({ msg: 'native worker close failed', sessionId: entry.sessionId, error: err?.message });
        }
      }
    },
  };
}

/**
 * @param {{ stateDir: string, instanceId: string, configFile: string, backends: Record<string, object>, containment: { state: string, scopePath?: string, reason?: string, ops?: object }, log: (entry: object) => void, privacy?: ReturnType<typeof createSpoolPrivacy> }} opts
 */
export async function startSupervisor({ stateDir, instanceId, configFile, backends, containment, log, privacy = createSpoolPrivacy() }) {
  const absState = resolve(stateDir);
  const supDir = join(absState, 'supervisor');
  if (!(await verifyOwnerLock({ lockFile: join(supDir, 'owner.lock') }))) throw new OwnerLockNotHeld();
  ensurePrivateDir(absState);
  ensurePrivateDir(supDir);
  for (const [key, backend] of Object.entries(backends)) {
    assertBackend(backend);
    if (backend.id !== key) throw new TypeError(`Backend registered as ${key} reports id ${backend.id}`);
  }
  const { profiles, capacity } = loadLocalProfiles({ file: configFile });
  const repositories = loadRepositories({ file: configFile });
  const ledger = createLedger({ dir: supDir });
  if (containment?.state !== 'verified') log({ msg: 'standalone containment unavailable', reason: containment?.reason });
  const recovery = await recoverOnStart({ ledger, containment, bootId: await readBootId(), log });
  log({ msg: 'supervisor recovery finished', admission: recovery.admission, workers: recovery.workers.map((w) => w.result), commands: recovery.commands.length });
  let stoppedWith = null;
  const handlers = createSupervisorHandlers({ ledger, profiles, backends, containment, log, stateDir: absState, repositories, privacy, limits: capacity, onStopped: (state) => {
    if (state === 'stopped') stoppedWith?.();
  } });
  const server = createIpcServer({ instanceId, stateDir: absState, handlers, log });
  await server.listen();
  log({ msg: 'supervisor ready', containment: containment?.state });
  const stopped = new Promise((resolveStopped) => { stoppedWith = resolveStopped; });
  return {
    recovery,
    stopped,
    async close() {
      await server.close();
      await handlers.closeWorkers('supervisor_shutdown');
    },
  };
}
