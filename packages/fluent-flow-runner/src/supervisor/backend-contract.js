
export const BACKEND_IDS = Object.freeze(['claude-code', 'codex']);
const WORKER_METHODS = ['send', 'respond', 'interrupt', 'pending', 'close'];

export class BackendContractError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'BackendContractError';
  }
}

export function assertBackend(backend) {
  if (!backend || typeof backend !== 'object') throw new BackendContractError('A native backend must be an object');
  if (!BACKEND_IDS.includes(backend.id)) throw new BackendContractError(`Unknown native backend id ${JSON.stringify(backend.id)}`);
  for (const method of ['readiness', 'open']) {
    if (typeof backend[method] !== 'function') throw new BackendContractError(`Native backend ${backend.id} is missing ${method}()`);
  }
  return backend;
}

export function assertWorker(worker) {
  if (!worker || typeof worker !== 'object') throw new BackendContractError('A native worker must be an object');
  for (const method of WORKER_METHODS) {
    if (typeof worker[method] !== 'function') throw new BackendContractError(`Native worker is missing ${method}()`);
  }
  if (typeof worker.events?.[Symbol.asyncIterator] !== 'function') throw new BackendContractError('Native worker events must be async iterable');
  const id = worker.identity;
  if (!id || !Number.isSafeInteger(id.pid) || !Number.isSafeInteger(id.startTicks) || typeof id.bootId !== 'string') {
    throw new BackendContractError('Native worker identity must carry pid, startTicks and bootId');
  }
  return worker;
}

/**
 * @param {{ ledger: ReturnType<typeof import('./ledger.js').createLedger>, commandId: string, sessionId: string, runId: string, backend: string, generation: number, workspaceDir: string, prior?: { nativeSessionId: string, onAbsent: (nativeSessionId: string) => Promise<void> } | null }} scope
 */
export function openEffects({ ledger, commandId, sessionId, runId, backend, generation, workspaceDir, prior = null }) {
  let bound = false;
  let absent = false;
  return Object.freeze({
    /** @param {{ nativeSessionId?: string, evidence?: string }} [arg] */
    async absent({ nativeSessionId, evidence } = {}) {
      if (!prior || absent) throw new BackendContractError('open() effects record native absence only for one recorded earlier create');
      if (nativeSessionId !== prior.nativeSessionId || evidence !== 'resume_not_found') throw new BackendContractError('Native absence must name the exact recorded native session');
      absent = true;
      await prior.onAbsent(nativeSessionId);
    },
    async barrier(effect, ref) {
      if (effect !== 'create_native_session') {
        throw new BackendContractError(`open() effects only barrier create_native_session, not ${effect}`);
      }
      ledger.barrier(commandId, { effect, generation, ref });
    },
    async bind(nativeSessionId) {
      if (bound) throw new BackendContractError('open() effects bind once');
      if (typeof nativeSessionId !== 'string' || nativeSessionId === '') throw new BackendContractError('bind needs a native session id');
      ledger.bind({ sessionId, runId, backend, nativeSessionId, generation, workspaceDir });
      bound = true;
    },
  });
}

const CALL_EFFECTS = ['prompt', 'respond', 'interrupt'];

/**
 * @param {{ ledger: ReturnType<typeof import('./ledger.js').createLedger>, commandId: string, effect: 'prompt' | 'respond' | 'interrupt', generation: number }} scope
 * @returns {(ref?: object) => Promise<void>}
 */
export function createCommandBarrier({ ledger, commandId, effect, generation }) {
  if (!CALL_EFFECTS.includes(effect)) throw new BackendContractError(`Per-call barriers are only for prompt, respond or interrupt, not ${effect}`);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BackendContractError('A per-call barrier needs a positive worker generation');
  if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('A per-call barrier needs a command id');
  let used = false;
  return async function barrier(ref = {}) {
    if (used) throw new BackendContractError(`The ${effect} barrier for command ${commandId} is single-use`);
    used = true;
    ledger.barrier(commandId, { effect, generation, ref });
  };
}

const ANSWER_BARRIER_KEYS = new Set(['type', 'responseId', 'requestId', 'fingerprint', 'generation', 'source', 'operation']);

export function answerBarrierRef(record) {
  if (record?.type !== 'answer_barrier') throw new BackendContractError('Only an answer_barrier record maps to a respond barrier');
  const extra = Object.keys(record).filter((key) => !ANSWER_BARRIER_KEYS.has(key));
  if (extra.length) throw new BackendContractError('An answer barrier records request metadata only');
  return {
    nativeRequestId: record.requestId,
    responseId: record.responseId,
    source: record.source,
    requestKind: 'question',
    fingerprint: record.fingerprint,
    operation: record.operation,
  };
}
