import { createHash } from 'node:crypto';
import { fetchEvents } from '../supervisor/client.js';
import { nativeCursorEpoch } from '../supervisor/summary.js';


const MAX_EVENT_ID = 180;
const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', in_progress: 'in_progress', completed: 'completed' };
const RESOLVED_REQUEST_STATES = new Set(['resolved', 'withdrawn', 'settled', 'unsupported', 'expired']);
const TERMINAL_STATES = { completed: 'idle', interrupted: 'cancelled', failed: 'failed', account_limited: 'failed' };

export function nativeObservationId({ backend, sessionId, generation, nativeEventId }) {
  const prefix = `${backend}:${sessionId}:${generation}:`;
  const full = `${prefix}${nativeEventId}`;
  if (full.length <= MAX_EVENT_ID) return full;
  return `${prefix}h${createHash('sha256').update(String(nativeEventId)).digest('hex').slice(0, 32)}`;
}

const known = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function usagePayload(backend, event, p) {
  const key = typeof p?.turnId === 'string' && p.turnId ? p.turnId : event.nativeEventId;
  let tokensIn = null;
  let tokensOut = null;
  let costUsd = null;
  if (p?.tokens && typeof p.tokens === 'object') {
    tokensIn = known(p.tokens.input);
    tokensOut = known(p.tokens.output);
  } else if (Array.isArray(p?.samples) && p.samples.length) {
    const sum = (field) => (p.samples.every((s) => known(s?.[field]) !== null) ? p.samples.reduce((n, s) => n + s[field], 0) : null);
    tokensIn = sum('inputTokens');
    tokensOut = sum('outputTokens');
    costUsd = p.samples.every((s) => known(s?.cost?.amount) !== null) ? p.samples.reduce((n, s) => n + s.cost.amount, 0) : null;
  }
  const unavailable = tokensIn === null && tokensOut === null && costUsd === null;
  return { ...p, sampleKey: `${backend}:${event.sessionId}:${event.generation}:${key}`.slice(0, 300), tokensIn, tokensOut, costUsd, reason: unavailable ? 'usage_unavailable' : null };
}

function statePayload(p, terminal, ownedStop) {
  if (terminal && (ownedStop === 'pending' || ownedStop === 'uncertain')) {
    return { ...p, state: 'reconciling', nativeState: p?.nativeState ?? (typeof p?.state === 'string' && p.state ? p.state : terminal), nativeTerminal: terminal, ownedStop };
  }
  if (terminal === 'interrupted') {
    const { state: _state, ...rest } = p ?? {};
    return { ...rest, nativeState: 'interrupted' };
  }
  if (terminal) {
    const state = TERMINAL_STATES[terminal] ?? 'failed';
    const errorCode = p?.errorCode ?? (terminal === 'account_limited' ? 'account_limited' : undefined);
    return { ...p, state, nativeState: p?.nativeState ?? (typeof p?.state === 'string' && p.state ? p.state : terminal), ...(errorCode ? { errorCode } : {}) };
  }
  switch (p?.state) {
    case 'running':
    case 'reconciling':
    case 'failed':
    case 'cancelled':
      return { ...p };
    case 'profile_violation': {
      const { state: _state, ...violation } = p;
      return { state: 'reconciling', errorCode: 'profile_unavailable', violation };
    }
    case 'sign_in_required':
      return { state: 'reconciling', errorCode: 'sign_in_required' };
    default: {
      const { state: nativeState, ...rest } = p ?? {};
      return { ...rest, nativeState: nativeState ?? p?.phase ?? null };
    }
  }
}

/**
 * @param {{ seq: number, sessionId: string, runId: string, generation: number, kind: string, nativeEventId: string, at: string, payload: { backend: string, event: any, terminal?: string, receiptFor?: string, ownedStop?: string } }} event
 */
export function nativeObservation(event) {
  const { backend, event: p, terminal, receiptFor, ownedStop } = event.payload ?? {};
  const source = { backend, generation: event.generation, nativeEventId: event.nativeEventId, seq: event.seq };
  const base = { eventId: nativeObservationId({ backend, sessionId: event.sessionId, generation: event.generation, nativeEventId: event.nativeEventId }), runId: event.runId, sessionId: event.sessionId, observedAt: event.at };
  let kind;
  let payload;
  switch (event.kind) {
    case 'timeline':
      kind = 'timeline';
      payload = { ...p, ...(receiptFor ? { receiptFor } : {}) };
      break;
    case 'attention': {
      kind = 'attention';
      const requestId = p?.nativeRequestId ?? null;
      const attention = p?.state === 'pending' ? 'permission' : RESOLVED_REQUEST_STATES.has(p?.state) ? 'permission_resolved' : 'native_record';
      payload = { ...p, attention, requestId };
      break;
    }
    case 'usage':
      kind = 'usage';
      payload = usagePayload(backend, event, p);
      break;
    case 'binding':
      kind = 'session_bound';
      payload = { backend, nativeSessionId: p?.nativeSessionId ?? null, generation: p?.generation ?? null };
      break;
    case 'plan': {
      kind = 'state';
      const items = (Array.isArray(p?.plan) ? p.plan : [])
        .filter((i) => typeof i?.step === 'string' && i.step.trim() && PLAN_STATUS[i.status])
        .slice(0, 50)
        .map((i) => ({ text: i.step.slice(0, 500), status: PLAN_STATUS[i.status] }));
      payload = { nativePlan: p, ...(items.length ? { plan: { items } } : {}) };
      break;
    }
    default:
      kind = 'state';
      payload = statePayload(p, terminal, ownedStop);
  }
  return { ...base, kind, payload: { ...payload, source }, providerCursor: { epoch: nativeCursorEpoch(backend), seq: String(event.seq) } };
}

/**
 * @param {{ supervisor: { request: (method: string, params?: object) => Promise<any> }, remember: (observations: object[]) => Promise<void>, log: (entry: object) => void, intervalMs?: number }} opts
 */
export function createNativeEventPump({ supervisor, remember, log, intervalMs = 200 }) {
  let stopped = false;
  let timer = null;
  let running = null;

  async function drainOnce() {
    let { deliveredSeq } = await supervisor.request('hello', {});
    let count = 0;
    for (;;) {
      const events = await fetchEvents(supervisor, { afterSeq: deliveredSeq, limit: 500 });
      if (events.length === 0) return count;
      await remember(events.map(nativeObservation));
      deliveredSeq = events.at(-1).seq;
      await supervisor.request('ackEvents', { uptoSeq: deliveredSeq });
      count += events.length;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      running = drainOnce().catch((err) => {
        log({ msg: 'native event drain failed; will retry', code: err?.code, error: err?.message });
      }).finally(() => {
        running = null;
        schedule();
      });
    }, intervalMs);
  }

  return {
    drainOnce,
    start() {
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
