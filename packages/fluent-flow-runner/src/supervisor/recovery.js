import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainmentError, containmentOps } from './containment.js';
import { isLive, parseStat } from './process-identity.js';
import { stopContained } from './stop.js';

const CGROUP_ROOT = '/sys/fs/cgroup';
const SETTLED = new Set(['failed', 'applied']);
const LAUNCH_KINDS = new Set(['launch', 'create_session', 'summarize']);

async function recoverWorker({ w, containment, ops, bootId, stop, graceMs, killWaitMs }) {
  const unknown = (reason) => ({ result: 'reconciling', reason });
  if (containment?.state !== 'verified') return unknown('containment_unavailable');
  if (w.identity && w.identity.bootId !== bootId) return unknown('boot_changed');
  const missing = async () => (w.identity && (await isLive(w.identity)) ? unknown('process_outside_leaf') : { result: 'empty' });
  let leaf;
  try {
    leaf = ops.leaf({ cgroupPath: w.cgroupPath, generation: w.generation, sessionId: w.sessionId });
  } catch (err) {
    if (!(err instanceof ContainmentError)) throw err;
    return err.code === 'leaf_missing' ? missing() : unknown('not_owned_leaf');
  }
  let populated;
  try {
    ({ populated } = await ops.read({ cgroupPath: leaf }));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return missing();
  }
  if (populated === false) return { result: 'empty' };
  if (populated !== true) return unknown('populated_unknown');
  const result = await stop({
    worker: { sessionId: w.sessionId, generation: w.generation, cgroupPath: leaf, identity: w.identity, pgid: w.identity?.pid ?? null },
    containment: { read: ops.read, kill: ops.kill, ...(ops.terminate ? { terminate: ops.terminate } : {}) },
    graceMs, killWaitMs,
  });
  return result === 'quiesced' ? { result: 'quiesced' } : unknown('stop_uncertain');
}

function turnOpen(ledger, sessionId, generation) {
  let lastPrompt = null;
  for (const commandId of ledger.commandIds()) {
    const rec = ledger.commandRecord(commandId);
    if (rec.accept.sessionId !== sessionId) continue;
    for (const b of rec.barriers) if (b.effect === 'prompt' && b.generation === generation && (lastPrompt === null || b.at > lastPrompt)) lastPrompt = b.at;
  }
  if (lastPrompt === null) return false;
  const lastTerminal = ledger.sessionEvents(sessionId).filter((e) => e.generation === generation && e.payload?.terminal).map((e) => e.at).sort().at(-1);
  return !lastTerminal || lastTerminal <= lastPrompt;
}

function uncertainEffects(ledger, commandId) {
  const cls = ledger.classify(commandId);
  return cls === 'undispatched' ? [] : Object.entries(cls).filter(([, state]) => state === 'uncertain').map(([effect]) => effect);
}

/**
 * @param {{ ledger: any, containment: any, bootId: string, stop?: typeof stopContained, graceMs?: number, killWaitMs?: number, log?: (entry: object) => void }} opts
 */
export async function recoverOnStart({ ledger, containment, bootId, stop = stopContained, graceMs = 10_000, killWaitMs = 5_000, log = () => {} }) {
  const report = { admission: 'open', workers: [], commands: [] };
  const ops = containmentOps(containment);
  const sessions = new Map();
  const touch = (sessionId, runId, backend, reason) => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { runId, backend, reason });
  };
  try {
    for (const w of ledger.workers()) {
      const outcome = await recoverWorker({ w, containment, ops, bootId, stop, graceMs, killWaitMs });
      report.workers.push({ sessionId: w.sessionId, runId: w.runId, backend: w.backend, generation: w.generation, ...outcome });
      if (outcome.result === 'empty') {
        if (turnOpen(ledger, w.sessionId, w.generation)) touch(w.sessionId, w.runId, w.backend, 'turn_lost');
        continue;
      }
      log({ msg: 'supervisor recovery worker', sessionId: w.sessionId, generation: w.generation, result: outcome.result, reason: outcome.reason });
      if (!(w.exit?.kind === 'recovery_stop' && w.exit.stop === outcome.result)) {
        ledger.recordWorkerExit({ sessionId: w.sessionId, generation: w.generation, kind: 'recovery_stop', stop: outcome.result, reason: outcome.reason ?? null, bootId });
      }
      touch(w.sessionId, w.runId, w.backend, outcome.reason ?? 'worker_lost');
    }
    for (const commandId of ledger.commandIds()) {
      const rec = ledger.commandRecord(commandId);
      if (rec.closure || SETTLED.has(rec.outcome?.state)) continue;
      const before = uncertainEffects(ledger, commandId);
      for (const effect of before) {
        if (ledger.noWrite(commandId, effect)) {
          try {
            ledger.recordResolution(commandId, { effect, kind: 'ff_no_write', evidence: { source: 'no_write' } });
          } catch (err) {
            if (err?.code !== 'ledger_conflict') throw err;
            log({ msg: 'supervisor recovery no-write evidence not exact', commandId, effect });
          }
        }
      }
      const remaining = uncertainEffects(ledger, commandId);
      const undelivered = remaining.length === 0 && rec.outcome?.state === 'accepted' && LAUNCH_KINDS.has(rec.accept.kind) && !rec.barriers.some((b) => b.effect === 'prompt');
      if (remaining.length || undelivered || rec.outcome?.state === 'reconciling') {
        if (rec.outcome?.state !== 'reconciling') ledger.outcome(commandId, { state: 'reconciling', errorCode: 'reconciling' });
        report.commands.push({ commandId, state: 'reconciling' });
        touch(rec.accept.sessionId, rec.accept.runId, rec.accept.backend, 'effect_uncertain');
      } else if (before.length) {
        if (!rec.outcome) ledger.outcome(commandId, { state: 'failed', errorCode: 'request_unavailable' });
        report.commands.push({ commandId, state: 'resolved' });
      }
    }
    for (const [sessionId, { runId, backend, reason }] of sessions) {
      const generations = [...ledger.workers().filter((w) => w.sessionId === sessionId).map((w) => w.generation), ...ledger.bindings().filter((b) => b.sessionId === sessionId).map((b) => b.generation)];
      if (!generations.length) continue;
      const generation = Math.max(...generations);
      ledger.appendEvent({ sessionId, runId, generation, kind: 'state', nativeEventId: `ff:recovery:${generation}`, payload: { backend, event: { state: 'reconciling', errorCode: 'reconciling', reason } } });
    }
  } catch (err) {
    if (!ledger.admissionStopped) throw err;
    log({ msg: 'supervisor recovery stopped admission', error: err?.message, code: err?.code });
    return { ...report, admission: 'stopped', errorCode: 'startup_failed' };
  }
  return report;
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err;
  }
}

/**
 * @param {{ observed: Array<{ pid: number, startTicks: number, bootId: string }>, containment: { scopePath?: string }, cgroupRoot?: string, procRoot?: string }} opts
 * @returns {Array<{ identity: object, code: string }>}
 */
export function detectEscapes({ observed, containment, cgroupRoot = CGROUP_ROOT, procRoot = '/proc' }) {
  const scope = containment?.scopePath;
  if (typeof scope !== 'string' || !scope.startsWith('/')) return [];
  const bootId = readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
  const escapes = [];
  for (const identity of observed ?? []) {
    if (!identity || identity.bootId !== bootId || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) continue;
    const raw = readOptional(join(procRoot, String(identity.pid), 'stat'));
    const stat = raw === null ? null : parseStat(raw);
    if (!stat || stat.startTicks !== identity.startTicks || stat.state === 'Z') continue;
    const cgroup = readOptional(join(procRoot, String(identity.pid), 'cgroup'))?.split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? null;
    const actual = cgroup === null ? null : join(cgroupRoot, cgroup);
    if (actual !== null && (actual === scope || actual.startsWith(`${scope}/`))) continue;
    escapes.push({ identity, code: 'descendants_escaped' });
  }
  return escapes;
}
