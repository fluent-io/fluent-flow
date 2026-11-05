import nodeFs from 'node:fs';
import { createDurableLog, DurableLogCorruptionError } from '../connector/durable-log.js';
import { openPrivateFile } from './private-file.js';


export const LEDGER_VERSION = 1;
export const EFFECTS = Object.freeze(['create_worktree', 'create_native_session', 'prompt', 'respond', 'interrupt']);
export const EVENT_KINDS = Object.freeze(['timeline', 'state', 'attention', 'usage', 'plan', 'binding']);
const OUTCOME_STATES = new Set(['accepted', 'applied', 'failed', 'reconciling']);
const shortId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const RESPOND_REF_FIELDS = {
  nativeRequestId: shortId,
  responseId: shortId,
  source: (v) => v === 'web' || v === 'local',
  requestKind: (v) => v === 'permission' || v === 'question',
  fingerprint: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
  operation: (v) => v === 'answer' || v === 'decline',
};
const RESPOND_REF_REQUIRED = ['nativeRequestId', 'source'];
const IDENTITY_KEYS = new Set(['commandId', 'effect', 'generation', 'v', 'type', 'at']);
const RECORD_TYPES = new Set(['accept', 'barrier', 'receipt', 'outcome', 'worker_intent', 'worker', 'worker_exit', 'bind', 'event', 'delivered', 'no_write', 'worktree_archived', 'slot_reserve', 'slot_release', 'resolution', 'closure', 'archive_attempt', 'archive_resolution']);
const NO_WRITE_EVIDENCE = new Set(['ff_suppressed']);
const NATIVE_ID = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const GENERATION = (v) => Number.isSafeInteger(v) && v >= 1;
const RESOLUTION_EVIDENCE = {
  ff_no_write: { source: (v) => v === 'no_write' },
  operator_closed: { stop: (v) => v === 'quiesced' },
  native_absent: { nativeSessionId: NATIVE_ID, source: (v) => v === 'claude_resume_not_found', generation: GENERATION },
  native_present: { nativeSessionId: NATIVE_ID, source: (v) => v === 'native_resume_bound', generation: GENERATION },
};
const NATIVE_RESOLUTIONS = new Set(['native_absent', 'native_present']);
const MAX_EVENTS_PER_READ = 500;

export class LedgerDigestMismatch extends Error {
  constructor(commandId) {
    super(`Command ${commandId} was re-submitted with a different digest`);
    this.name = 'LedgerDigestMismatch';
    this.code = 'digest_mismatch';
  }
}

export class LedgerAdmissionStopped extends Error {
  constructor(cause) {
    super('Supervisor ledger stopped after a failed durable write', { cause });
    this.name = 'LedgerAdmissionStopped';
    this.code = 'admission_stopped';
  }
}

export class LedgerCorruption extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LedgerCorruption';
    this.code = 'ledger_corrupt';
  }
}

export class LedgerConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerConflict';
    this.code = 'ledger_conflict';
  }
}

const workerKey = (sessionId, generation) => `${sessionId}\u0000${generation}`;

/** @param {{ dir: string, fs?: typeof nodeFs }} opts */
export function createLedger({ dir, fs = nodeFs }) {
  const commands = new Map();
  const workers = new Map();
  const binds = [];
  const events = [];
  const eventIds = new Map();
  const archives = new Map();
  const archiveAttempts = new Map();
  const archiveResolutions = new Map();
  const slotHolders = new Map();
  let deliveredSeq = 0;
  let stopped = null;

  function apply(entry) {
    switch (entry.type) {
      case 'accept':
        commands.set(entry.commandId, { accept: entry, barriers: new Map(), receipts: new Map(), noWrites: new Map(), resolutions: new Map(), closure: null, outcome: null });
        break;
      case 'barrier': commands.get(entry.commandId).barriers.set(entry.effect, entry); break;
      case 'no_write': commands.get(entry.commandId).noWrites.set(entry.effect, entry); break;
      case 'resolution': commands.get(entry.commandId).resolutions.set(entry.effect, entry); break;
      case 'closure': commands.get(entry.commandId).closure = entry; break;
      case 'receipt': commands.get(entry.commandId).receipts.set(entry.effect, entry); break;
      case 'outcome': commands.get(entry.commandId).outcome = entry; break;
      case 'worker_intent':
        workers.set(workerKey(entry.sessionId, entry.generation), {
          sessionId: entry.sessionId, runId: entry.runId, backend: entry.backend, generation: entry.generation,
          cgroupPath: entry.cgroupPath, identity: null, exit: null, startedAt: entry.at ?? null,
        });
        break;
      case 'worker': {
        const w = workers.get(workerKey(entry.sessionId, entry.generation));
        w.identity = entry.identity;
        w.exit = null;
        break;
      }
      case 'worker_exit': workers.get(workerKey(entry.sessionId, entry.generation)).exit = entry.exit; break;
      case 'bind': binds.push(entry); break;
      case 'event':
        events.push(entry);
        eventIds.set(`${workerKey(entry.sessionId, entry.generation)}\u0000${entry.nativeEventId}`, entry.seq);
        break;
      case 'delivered': deliveredSeq = Math.max(deliveredSeq, entry.seq); break;
      case 'worktree_archived': archives.set(entry.runId, entry); break;
      case 'archive_attempt': archiveAttempts.set(entry.runId, entry); break;
      case 'archive_resolution': archiveResolutions.set(entry.runId, entry); break;
      case 'slot_reserve': slotHolders.set(entry.sessionId, entry.backend); break;
      case 'slot_release': slotHolders.delete(entry.sessionId); break;
    }
  }

  const validateAndApply = (entries) => {
    for (const [index, entry] of entries.entries()) {
      if (entry.v !== LEDGER_VERSION) {
        throw new LedgerCorruption(`Supervisor ledger record ${index + 1} has unsupported version ${JSON.stringify(entry.v)}; file preserved for repair`);
      }
      if (['barrier', 'receipt', 'outcome', 'no_write', 'resolution', 'closure'].includes(entry.type) && !commands.has(entry.commandId)) {
        throw new LedgerCorruption(`Supervisor ledger record ${index + 1} references an unaccepted command; file preserved for repair`);
      }
      if (['worker', 'worker_exit'].includes(entry.type) && !workers.has(workerKey(entry.sessionId, entry.generation))) {
        throw new LedgerCorruption(`Supervisor ledger record ${index + 1} references an unrecorded worker; file preserved for repair`);
      }
      apply(entry);
    }
  };

  let log;
  try {
    log = createDurableLog({
      dir, file: 'ledger.jsonl', recordTypes: RECORD_TYPES, fs, validate: validateAndApply,
      openFile: (path, { access, create }) => openPrivateFile(path, { access, create, fs }),
    });
  } catch (err) {
    if (!(err instanceof DurableLogCorruptionError)) throw err;
    throw new LedgerCorruption(`Supervisor ledger is corrupt at line ${err.line}; file preserved for repair`, { cause: err });
  }

  function write(record) {
    if (stopped) throw new LedgerAdmissionStopped(stopped);
    const entry = { v: LEDGER_VERSION, ...record, at: new Date().toISOString() };
    try {
      log.append(entry);
    } catch (err) {
      stopped = err;
      throw err;
    }
    apply(entry);
    return entry;
  }

  function command(commandId) {
    const rec = commands.get(commandId);
    if (!rec) throw new LedgerConflict(`Command ${commandId} was never accepted`);
    return rec;
  }

  function isBound(rec, generation) {
    return binds.some((b) => b.sessionId === rec.accept.sessionId && b.generation === generation);
  }

  return {
    get admissionStopped() {
      return stopped !== null;
    },

    submit({ commandId, digest, runId, sessionId, backend, kind }) {
      const existing = commands.get(commandId);
      if (existing) {
        if (existing.accept.digest !== digest) throw new LedgerDigestMismatch(commandId);
        const outcome = existing.outcome;
        return outcome ? { state: outcome.state, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) } : { state: 'accepted' };
      }
      if (stopped) throw new LedgerAdmissionStopped(stopped);
      write({ type: 'accept', commandId, digest, runId, sessionId, backend, kind });
      return { state: 'new' };
    },

    acceptLocal({ localCommandId, runId, sessionId, backend, requestId, fingerprint, generation, operation }) {
      if (stopped) throw new LedgerAdmissionStopped(stopped);
      if (commands.has(localCommandId)) throw new LedgerConflict(`Command ${localCommandId} was already accepted`);
      const valid = shortId(localCommandId) && shortId(runId) && shortId(sessionId) && shortId(backend) && /^[0-9a-f]{32}$/.test(requestId ?? '') &&
        RESPOND_REF_FIELDS.fingerprint(fingerprint) && Number.isSafeInteger(generation) && generation >= 1 && RESPOND_REF_FIELDS.operation(operation);
      if (!valid) throw new LedgerConflict('A local answer records typed request metadata only');
      write({ type: 'accept', commandId: localCommandId, digest: 'local', runId, sessionId, backend, kind: 'local_answer', requestId, fingerprint, generation, operation });
    },

    barrier(commandId, { effect, generation, ref }) {
      if (stopped) throw new LedgerAdmissionStopped(stopped);
      if (!EFFECTS.includes(effect)) throw new LedgerConflict(`Unknown effect ${effect}`);
      const rec = command(commandId);
      if (rec.barriers.has(effect)) throw new LedgerConflict(`A ${effect} barrier already exists for command ${commandId}; it is never repeated`);
      if (ref !== undefined && (ref === null || typeof ref !== 'object' || Array.isArray(ref))) throw new LedgerConflict('A barrier ref must be a plain object');
      if (Object.keys(ref ?? {}).some((key) => IDENTITY_KEYS.has(key))) throw new LedgerConflict('A barrier ref cannot restate barrier identity');
      if (effect === 'respond') {
        const entries = Object.entries(ref ?? {});
        const valid = entries.every(([key, value]) => Object.hasOwn(RESPOND_REF_FIELDS, key) && RESPOND_REF_FIELDS[key](value)) &&
          RESPOND_REF_REQUIRED.every((key) => Object.hasOwn(ref ?? {}, key));
        if (!valid) throw new LedgerConflict('A respond barrier records typed request metadata only');
      }
      write({ type: 'barrier', commandId, effect, generation, ref: ref ?? {} });
    },

    receipt(commandId, { effect, evidence }) {
      const rec = command(commandId);
      if (!rec.barriers.has(effect)) throw new LedgerConflict(`No ${effect} barrier for command ${commandId}`);
      if (rec.receipts.has(effect)) throw new LedgerConflict(`A ${effect} receipt already exists for command ${commandId}`);
      write({ type: 'receipt', commandId, effect, evidence: evidence ?? {} });
    },

    outcome(commandId, { state, errorCode, dispatched, closure }) {
      if (!OUTCOME_STATES.has(state)) throw new LedgerConflict(`Unknown outcome state ${state}`);
      if (dispatched !== undefined && dispatched !== false) throw new LedgerConflict('An outcome records only dispatched: false');
      if (closure !== undefined && closure !== 'operator') throw new LedgerConflict('An outcome records only closure: operator');
      command(commandId);
      write({ type: 'outcome', commandId, state, ...(errorCode ? { errorCode } : {}), ...(dispatched === false ? { dispatched: false } : {}), ...(closure ? { closure } : {}) });
    },

    classify(commandId) {
      const rec = command(commandId);
      if (rec.barriers.size === 0) return 'undispatched';
      const out = {};
      for (const [effect, barrier] of rec.barriers) {
        const proven = rec.receipts.has(effect) || (effect === 'create_native_session' && isBound(rec, barrier.generation));
        out[effect] = proven ? 'receipted' : rec.resolutions.has(effect) ? 'resolved' : 'uncertain';
      }
      return out;
    },

    recordWorkerIntent({ sessionId, runId, backend, generation, cgroupPath }) {
      if (stopped) throw new LedgerAdmissionStopped(stopped);
      if (workers.has(workerKey(sessionId, generation))) {
        throw new LedgerConflict(`Worker generation ${generation} of session ${sessionId} already exists`);
      }
      write({ type: 'worker_intent', sessionId, runId, backend, generation, cgroupPath });
    },

    recordWorker({ sessionId, generation, identity }) {
      const worker = workers.get(workerKey(sessionId, generation));
      if (!worker) throw new LedgerConflict(`No worker intent for session ${sessionId} generation ${generation}`);
      if (worker.identity && worker.exit?.kind !== 'child_exit') throw new LedgerConflict(`Worker identity already recorded for session ${sessionId} generation ${generation}`);
      write({ type: 'worker', sessionId, generation, identity });
    },

    recordWorkerExit({ sessionId, generation, ...exit }) {
      if (!workers.has(workerKey(sessionId, generation))) {
        throw new LedgerConflict(`No worker intent for session ${sessionId} generation ${generation}`);
      }
      write({ type: 'worker_exit', sessionId, generation, exit });
    },

    workers() {
      return [...workers.values()].map((w) => ({ ...w, needsRecovery: w.identity === null && w.exit === null }));
    },

    bind({ sessionId, runId, backend, nativeSessionId, generation, workspaceDir }) {
      write({ type: 'bind', sessionId, runId, backend, nativeSessionId, generation, workspaceDir });
    },

    bindings() {
      return [...binds];
    },

    appendEvent({ sessionId, runId, generation, kind, nativeEventId, payload }) {
      if (!EVENT_KINDS.includes(kind)) throw new LedgerConflict(`Unknown event kind ${kind}`);
      const known = eventIds.get(`${workerKey(sessionId, generation)}\u0000${nativeEventId}`);
      if (known !== undefined) return { seq: known };
      const seq = (events.at(-1)?.seq ?? 0) + 1;
      write({ type: 'event', seq, sessionId, runId, generation, kind, nativeEventId, payload });
      return { seq };
    },

    eventsAfter(seq, limit = MAX_EVENTS_PER_READ) {
      const bounded = Math.max(1, Math.min(Number(limit) || MAX_EVENTS_PER_READ, MAX_EVENTS_PER_READ));
      return events.slice(Math.max(0, seq), Math.max(0, seq) + bounded);
    },

    get deliveredSeq() {
      return deliveredSeq;
    },

    recordNoWrite(commandId, { effect, generation, sessionId, backend, evidence }) {
      const rec = command(commandId);
      if (!rec.barriers.has(effect)) throw new LedgerConflict(`No ${effect} barrier for command ${commandId}`);
      if (rec.receipts.has(effect)) throw new LedgerConflict(`A ${effect} receipt already exists for command ${commandId}`);
      if (rec.noWrites.has(effect)) return;
      if (!NO_WRITE_EVIDENCE.has(evidence)) throw new LedgerConflict(`Unknown no-write evidence ${evidence}`);
      write({ type: 'no_write', commandId, effect, generation, sessionId, backend, evidence });
    },

    recordResolution(commandId, { effect, kind, by = null, evidence }) {
      const rec = command(commandId);
      const barrier = rec.barriers.get(effect);
      if (!barrier) throw new LedgerConflict(`No ${effect} barrier for command ${commandId}`);
      if (rec.receipts.has(effect)) throw new LedgerConflict(`A ${effect} receipt already exists for command ${commandId}`);
      const shape = RESOLUTION_EVIDENCE[kind];
      if (!shape) throw new LedgerConflict(`Unknown resolution ${kind}`);
      if (rec.resolutions.has(effect)) return rec.resolutions.get(effect);
      const fields = Object.entries(evidence ?? {});
      if (fields.length !== Object.keys(shape).length || !fields.every(([key, value]) => Object.hasOwn(shape, key) && shape[key](value))) {
        throw new LedgerConflict(`A ${kind} resolution records only its typed evidence`);
      }
      if (NATIVE_RESOLUTIONS.has(kind) && (effect !== 'create_native_session' || barrier.ref?.uuid !== evidence.nativeSessionId || evidence.generation <= barrier.generation)) {
        throw new LedgerConflict(`A ${kind} resolution names the exact native session of a later generation`);
      }
      if (kind === 'ff_no_write') {
        const proof = rec.noWrites.get(effect);
        if (!proof || proof.generation !== barrier.generation || proof.sessionId !== rec.accept.sessionId || proof.backend !== rec.accept.backend) {
          throw new LedgerConflict(`No exact no-write evidence for the ${effect} barrier of command ${commandId}`);
        }
      }
      if (kind !== 'ff_no_write' && !(shortId(by) && commands.has(by))) throw new LedgerConflict('A resolution names its accepted resolving command');
      return write({ type: 'resolution', commandId, effect, generation: barrier.generation, kind, by, evidence });
    },

    recordClosure(commandId, { by, generation, sessionId, backend, stop, evidence = {} }) {
      const rec = command(commandId);
      if (rec.closure) return rec.closure;
      if (!(shortId(by) && commands.has(by))) throw new LedgerConflict('A closure names its accepted closing command');
      if (stop !== 'quiesced') throw new LedgerConflict('A closure requires a quiesced owned stop');
      if (sessionId !== rec.accept.sessionId || backend !== rec.accept.backend) throw new LedgerConflict('A closure addresses the exact recorded session and backend');
      return write({ type: 'closure', commandId, by, generation, sessionId, backend, stop, evidence });
    },

    closure(commandId) {
      return commands.get(commandId)?.closure ?? null;
    },

    noWrite(commandId, effect) {
      return commands.get(commandId)?.noWrites.get(effect) ?? null;
    },

    commandRecord(commandId) {
      const rec = commands.get(commandId);
      if (!rec) return null;
      return { accept: rec.accept, outcome: rec.outcome, barriers: [...rec.barriers.values()], receipts: [...rec.receipts.values()], noWrites: [...rec.noWrites.values()], resolutions: [...rec.resolutions.values()], closure: rec.closure };
    },

    commandIds() {
      return [...commands.keys()];
    },

    runBarrier(runId, effect) {
      for (const rec of commands.values()) {
        if (rec.accept.runId === runId && rec.barriers.has(effect)) return rec.barriers.get(effect);
      }
      return null;
    },

    sessionEvents(sessionId) {
      return events.filter((e) => e.sessionId === sessionId);
    },

    eventAt(seq) {
      return Number.isInteger(seq) && seq >= 1 ? events[seq - 1] ?? null : null;
    },

    recordWorktreeArchived({ runId, workspaceRef, branch, headCommit, upstream }) {
      if (archives.has(runId)) throw new LedgerConflict(`The worktree of run ${runId} is already recorded as archived`);
      return write({ type: 'worktree_archived', runId, workspaceRef, branch, headCommit, upstream });
    },

    recordArchiveAttempt({ runId, workspaceRef, branch }) {
      if (archiveAttempts.has(runId)) return archiveAttempts.get(runId);
      if (!shortId(runId) || !/^ffw_[0-9a-f]{16}$/.test(workspaceRef ?? '') || !shortId(branch)) throw new LedgerConflict('An archive attempt records the run, its workspace reference and branch only');
      return write({ type: 'archive_attempt', runId, workspaceRef, branch });
    },

    archiveAttempt(runId) {
      return archiveAttempts.get(runId) ?? null;
    },

    recordArchiveResolution({ runId, workspaceRef, evidence }) {
      if (archiveResolutions.has(runId)) return archiveResolutions.get(runId);
      const attempt = archiveAttempts.get(runId);
      if (!attempt || archives.has(runId) || attempt.workspaceRef !== workspaceRef) throw new LedgerConflict('Only an unreceipted archive attempt of this exact workspace can be closed');
      const keys = Object.keys(evidence ?? {}).sort().join(',');
      const valid = keys === 'branchHead,directoryMissing,worktreeRegistered' && evidence.directoryMissing === true && evidence.worktreeRegistered === false &&
        (evidence.branchHead === null || /^[0-9a-f]{40,64}$/.test(evidence.branchHead));
      if (!valid) throw new LedgerConflict('An archive resolution records only its typed evidence');
      return write({ type: 'archive_resolution', runId, workspaceRef, attemptAt: attempt.at, outcome: 'unknown', evidence });
    },

    archiveResolution(runId) {
      return archiveResolutions.get(runId) ?? null;
    },

    worktreeArchive(runId) {
      return archives.get(runId) ?? null;
    },

    reserveSlot({ sessionId, backend }) {
      if (slotHolders.has(sessionId)) throw new LedgerConflict(`Session ${sessionId} already holds a slot`);
      return write({ type: 'slot_reserve', sessionId, backend });
    },

    releaseSlot({ sessionId }) {
      if (!slotHolders.has(sessionId)) throw new LedgerConflict(`Session ${sessionId} holds no slot`);
      return write({ type: 'slot_release', sessionId });
    },

    slotHolders() {
      return new Map(slotHolders);
    },

    markDelivered(seq) {
      const last = events.at(-1)?.seq ?? 0;
      if (!Number.isInteger(seq) || seq < 0 || seq > last) throw new LedgerConflict(`Cannot acknowledge event ${seq}`);
      if (seq <= deliveredSeq) return;
      write({ type: 'delivered', seq });
    },
  };
}
