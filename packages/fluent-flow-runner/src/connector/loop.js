import { performance } from 'node:perf_hooks';
import { ConnectorApiError } from './connector-client.js';


const NATIVE_EVENT_ID = /^(claude-code|codex):/;
const MAX_BATCH_BYTES = 1024 * 1024;
export const FRAGMENT_BYTES = 300 * 1024;

export function fragmentObservation(observation) {
  const bytes = Buffer.from(JSON.stringify(observation.payload), 'utf8');
  const count = Math.ceil(bytes.length / FRAGMENT_BYTES);
  return Array.from({ length: count }, (_, index) => ({
    ...observation,
    eventId: `${observation.eventId}#f${index}/${count}`,
    payload: { fragmentOf: observation.eventId, index, count, encoding: 'base64', data: bytes.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES).toString('base64') },
  }));
}

const DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  pollWaitMs: 25_000,
  pollLimit: 1,
  maxConsecutiveFailures: 10,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  minIdlePollCycleMs: 1_000,
  observationFlushDelayMs: 200,
  capacityCheckMs: 1_000,
  pollDeadlineMarginMs: 5_000,
};

const SLOT_BACKENDS = ['claude-code', 'codex'];
const MAX_POLL_SLOTS = 64;
const addSlots = (a, b) => Object.fromEntries(SLOT_BACKENDS.map((k) => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));
const anySlots = (slots) => SLOT_BACKENDS.some((k) => (slots?.[k] ?? 0) > 0);

export function createConnectorLoop({
  client,
  executor,
  journal,
  catalog,
  instanceId,
  sdkVersion,
  daemonVersion,
  capabilities = {},
  log = (_obj, _msg) => {},
  intervals = {},
  timers = { setTimeout, clearTimeout },
  onFatal = (_err) => {},
  onControlPlaneStatus = null,
  onBeforeDeliver = null,
  onReconcile = null,
  privacy = null,
  capacity = null,
}) {
  const cfg = { ...DEFAULTS, ...intervals, instanceId };
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stopController.signal.aborted) return resolve();
      const onAbort = () => {
        timers.clearTimeout(t);
        stopController.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const t = timers.setTimeout(() => {
        stopController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      stopController.signal.addEventListener('abort', onAbort, { once: true });
    });

  let session = null;
  let stopped = false;
  const stopController = new AbortController();
  const runStates = new Map();
  const TERMINAL_RUN_STATES = new Set(['idle', 'failed', 'cancelled']);
  const activeRunIds = () => [...runStates.entries()].filter(([, s]) => !TERMINAL_RUN_STATES.has(s)).map(([id]) => id);
  const pendingObservations = new Map();
  const fragmentProgress = new Map();
  let flushing = false;
  let flushAgain = false;
  let flushTimer = null;

  function stop() {
    stopped = true;
    if (flushTimer) timers.clearTimeout(flushTimer);
    flushTimer = null;
    stopController.abort(new Error('connector loop stopped'));
  }

  async function publishControlPlaneStatus(online) {
    if (!onControlPlaneStatus) return;
    try {
      await onControlPlaneStatus(online);
    } catch (err) {
      log({ msg: 'control-plane status update failed', online, error: err?.message });
      stop();
      onFatal(err);
      throw err;
    }
  }

  function scheduleFlush() {
    if (stopped || flushTimer) return;
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      flushObservations().catch((err) => {
        log({ msg: 'observation flush failed', error: err.message });
      });
    }, cfg.observationFlushDelayMs);
  }

  function currentFence() {
    if (!session) return null;
    return { connectorSessionId: session.connectorSessionId, leaseEpoch: session.leaseEpoch };
  }

  async function register() {
    const registration = await client.register({
      instanceId: cfg.instanceId,
      protocolVersion: 1,
      sdkVersion,
      daemonVersion,
      capabilities,
      catalog,
    });
    await publishControlPlaneStatus(true);
    session = registration;
    observeServerTime(registration?.serverTime);
    return registration;
  }

  let serverClock = null;
  function observeServerTime(serverTime) {
    if (typeof serverTime === 'string' && Number.isFinite(Date.parse(serverTime))) serverClock = { ms: Date.parse(serverTime), at: performance.now() };
  }
  function pollDeadline() {
    if (!serverClock) return undefined;
    return new Date(serverClock.ms + (performance.now() - serverClock.at) + cfg.pollWaitMs + cfg.pollDeadlineMarginMs).toISOString();
  }

  function isStaleFence(err) {
    return (
      err instanceof ConnectorApiError &&
      err.status === 409 &&
      (err.code === 'stale_fence' || err.code === 'stale_lease')
    );
  }

  function classify(err) {
    if (!(err instanceof ConnectorApiError)) return 'transient';
    if (err.status === 401) return 'fatal';
    if (isStaleFence(err)) return 'fence';
    return 'transient';
  }

  async function heartbeat() {
    const s = await ensureSession();
    if (!s) return;
    let res;
    try {
      res = await client.heartbeat(
        { connectorSessionId: s.connectorSessionId, leaseEpoch: s.leaseEpoch, activeRunIds: activeRunIds(), observedAt: new Date().toISOString() },
        { signal: stopController.signal },
      );
    } catch (err) {
      if (!stopped) await handleApiError(err, 'heartbeat');
      return;
    }
    await publishControlPlaneStatus(true);
    if (typeof res.leaseEpoch === 'number' && session && session.connectorSessionId === s.connectorSessionId) {
      session = { ...session, leaseEpoch: res.leaseEpoch };
    }
  }

  async function handleApiError(err, label) {
    await publishControlPlaneStatus(false);
    const kind = classify(err);
    if (kind === 'fatal') {
      stop();
      onFatal(err);
      return 'fatal';
    }
    if (kind === 'fence') {
      log({ msg: 'lease superseded; re-registering', source: label });
      session = null;
      return 'fence';
    }
    log({ msg: `${label} failed; will retry`, error: err.message });
    return 'transient';
  }

  async function ensureSession() {
    if (session) return session;
    try {
      await register();
      return session;
    } catch (err) {
      if (!stopped) await handleApiError(err, 'register');
      return null;
    }
  }

  async function flushObservations() {
    if (pendingObservations.size === 0) return;
    if (flushing) {
      flushAgain = true;
      return;
    }
    const fence = currentFence();
    if (!fence) return;
    const events = [];
    const bytes = (items) => Buffer.byteLength(JSON.stringify({ ...fence, events: items }), 'utf8');
    let full = false;
    const add = (event) => {
      if (events.length === 100 || bytes([...events, event]) > MAX_BATCH_BYTES) {
        full = true;
        return false;
      }
      events.push(event);
      return true;
    };
    const waitingSessions = new Set();
    for (const original of pendingObservations.values()) {
      if (full) break;
      if (waitingSessions.has(original.sessionId)) continue;
      if (bytes([original]) > MAX_BATCH_BYTES && NATIVE_EVENT_ID.test(original.eventId)) {
        if (!fragmentProgress.has(original.eventId)) fragmentProgress.set(original.eventId, { fragments: fragmentObservation(original), accepted: new Set() });
        const progress = fragmentProgress.get(original.eventId);
        for (const fragment of progress.fragments) {
          if (!progress.accepted.has(fragment.eventId) && !add(fragment)) break;
        }
        waitingSessions.add(original.sessionId);
        continue;
      }
      let event = original;
      if (bytes([event]) > MAX_BATCH_BYTES) {
        event = { ...original, payload: { unavailable: true, reason: 'observation_too_large', originalKind: original.kind } };
      }
      add(event);
    }
    if (!events.length) return;
    flushing = true;
    flushAgain = false;
    let progressed = false;
    try {
      const res = await client.observe({ ...fence, events }, { signal: stopController.signal });
      await publishControlPlaneStatus(true);
      const accepted = [];
      for (const id of res.acceptedEventIds ?? []) {
        const marker = id.lastIndexOf('#f');
        const progress = marker > 0 ? fragmentProgress.get(id.slice(0, marker)) : undefined;
        if (progress && progress.fragments.some((f) => f.eventId === id)) {
          progress.accepted.add(id);
          progressed = true;
          if (progress.accepted.size === progress.fragments.length) {
            const original = id.slice(0, marker);
            fragmentProgress.delete(original);
            pendingObservations.delete(original);
            accepted.push(original);
          }
          continue;
        }
        pendingObservations.delete(id);
        accepted.push(id);
      }
      if (accepted.length) await journal.markObservationsAccepted(accepted);
      progressed = progressed || accepted.length > 0;
    } catch (err) {
      if (!stopped) await handleApiError(err, 'observations');
    } finally {
      flushing = false;
    }
    if (pendingObservations.size > 0 && (flushAgain || progressed)) scheduleFlush();
  }

  function queueObservations(observations) {
    for (const original of observations ?? []) {
      const obs = privacy ? privacy.observation(original) : original;
      if (!obs?.eventId) continue;
      pendingObservations.set(obs.eventId, obs);
      if (obs.kind === 'state' && obs.runId && typeof obs.payload?.state === 'string') {
        runStates.set(obs.runId, obs.payload.state);
      }
      if (obs.kind === 'session_bound' && obs.runId) {
        if (!runStates.has(obs.runId)) runStates.set(obs.runId, 'launching');
      }
    }
  }

  function recover() {
    for (const eventId of journal.pendingObservationIds()) {
      const rec = journal.observationById(eventId);
      if (!rec) continue;
      queueObservations([{
        eventId,
        runId: rec.runId,
        sessionId: rec.sessionId,
        observedAt: rec.at,
        kind: rec.kind,
        payload: rec.payload,
        ...(NATIVE_EVENT_ID.test(eventId) && rec.providerCursor ? { providerCursor: rec.providerCursor } : {}),
      }]);
    }
    if (pendingObservations.size) {
      log({ msg: 'recovered unconfirmed observations', count: pendingObservations.size });
    }
  }

  async function ackCommand(command, fence, state, result, errorCode) {
    await journal.append({ type: 'acked', commandId: command.id, state, errorCode, at: new Date().toISOString() });
    const target = fence ?? currentFence();
    if (!target) return { confirmed: false, recordedState: null };
    let res;
    try {
      res = await client.ack(command.id, { ...target, state, result: privacy ? privacy.redact(result) : result, errorCode }, { signal: stopController.signal });
    } catch (err) {
      if (!stopped) await handleApiError(err, 'ack');
      return { confirmed: false, recordedState: null };
    }
    await publishControlPlaneStatus(true);
    const recordedState = res?.state ?? null;
    return { confirmed: recordedState === state, recordedState };
  }

  async function releaseSlots(grantId, unused, version) {
    if (!capacity || !anySlots(unused)) return;
    try {
      await capacity.release({ grantId, unused, ...(version !== undefined ? { version } : {}) });
    } catch (err) {
      log({ msg: 'slot release failed', error: err.message });
    }
  }

  async function reserveSlots() {
    const notAfter = pollDeadline();
    try {
      const reply = await capacity.reserve(notAfter ? { notAfter } : {});
      return { availableSlots: addSlots(reply?.availableSlots, {}), grantId: reply?.grantId ?? null, heldBatches: Array.isArray(reply?.heldBatches) ? reply.heldBatches : [], notAfter };
    } catch (err) {
      log({ msg: 'slot reservation failed', error: err.message });
      return { availableSlots: addSlots({}, {}), grantId: null, heldBatches: [], notAfter };
    }
  }

  function watchCapacity(settled, pollAbort) {
    return (async () => {
      for (;;) {
        const done = await Promise.race([settled.then(() => true), new Promise((r) => { const t = timers.setTimeout(() => r(false), cfg.capacityCheckMs); settled.then(() => timers.clearTimeout(t)); })]);
        if (done || stopped) return null;
        const fresh = await reserveSlots();
        if (anySlots(fresh.availableSlots)) {
          pollAbort.abort(new Error('slot freed'));
          return fresh;
        }
      }
    })();
  }

  async function handleCommand(command, fence) {
    if (!runStates.has(command.runId)) runStates.set(command.runId, 'queued');
    try {
      const outcome = await executor.execute(command);
      if (outcome.state === 'deferred') {
        log({ msg: 'command deferred for capacity', commandId: command.id, runId: command.runId });
        return;
      }
      queueObservations(outcome.observations);
      const accepted = await ackCommand(command, fence, outcome.state, outcome.result, outcome.errorCode);
      if (outcome.stage === 'bound' && outcome.state === 'accepted') {
        if (!accepted.confirmed) {
          log({ msg: 'bind ack unconfirmed; prompt withheld', commandId: command.id, runId: command.runId });
          return;
        }
        if (onBeforeDeliver) {
          try {
            await onBeforeDeliver({ runId: command.runId, sessionId: command.sessionId, ...outcome.result });
          } catch (err) {
            log({ msg: 'observer unavailable; prompt withheld', commandId: command.id, error: err.message });
            return;
          }
        }
        const deliver = await executor.complete(command);
        queueObservations(deliver.observations);
        await ackCommand(command, fence, deliver.state, deliver.result, deliver.errorCode);
      }
    } catch (err) {
      const code = err?.code ?? 'execution_error';
      log({ msg: 'command execution failed', commandId: command.id, code, error: err.message });
      runStates.set(command.runId, 'failed');
      await ackCommand(command, fence, 'failed', undefined, code);
    }
  }

  return {
    get session() {
      return session;
    },

    enqueueObservations(observations) {
      queueObservations(observations);
      if (pendingObservations.size > 0) scheduleFlush();
    },
    get pendingObservationIds() {
      return [...pendingObservations.keys()];
    },

    register,

    async start() {
      let failures = 0;
      while (!stopped) {
        const s = await ensureSession();
        if (s) break;
        failures += 1;
        if (failures >= cfg.maxConsecutiveFailures) {
          stop();
          onFatal(new Error('could not register: max retries reached'));
          return;
        }
        await sleep(Math.min(cfg.baseBackoffMs * 2 ** (failures - 1), cfg.maxBackoffMs));
      }
      recover();

      const heartbeatLoop = (async () => {
        while (!stopped) {
          try {
            if (onReconcile) await onReconcile();
            await heartbeat();
            await flushObservations();
          } catch (err) {
            log({ msg: 'heartbeat cycle failed', error: err.message });
          }
          if (stopped) break;
          await sleep(session?.heartbeatIntervalMs ?? cfg.heartbeatIntervalMs);
        }
      })();

      let carried = null;
      while (!stopped) {
        const s = await ensureSession();
        if (!s) {
          failures += 1;
          if (failures >= cfg.maxConsecutiveFailures) {
            stop();
            onFatal(new Error('could not re-register: max retries reached'));
            break;
          }
          await sleep(Math.min(cfg.baseBackoffMs * 2 ** (failures - 1), cfg.maxBackoffMs));
          continue;
        }
        const fence = currentFence();
        let commands = [];
        let offered = null;
        let reservation = null;
        if (capacity) {
          reservation = carried ?? (await reserveSlots());
          carried = null;
          offered = Object.fromEntries(SLOT_BACKENDS.map((k) => [k, Math.min(MAX_POLL_SLOTS, reservation.availableSlots[k])]));
        }
        const pollStartedAt = performance.now();
        const pollAbort = new AbortController();
        const onStop = () => pollAbort.abort(stopController.signal.reason);
        stopController.signal.addEventListener('abort', onStop, { once: true });
        /** @type {(value?: unknown) => void} */
        let settle = () => {};
        const settled = new Promise((r) => (settle = r));
        const watcher = capacity ? watchCapacity(settled, pollAbort) : Promise.resolve(null);
        let heldClaims = null;
        let answeredServerTime = null;
        try {
          const res = await client.poll({ ...fence, waitMs: cfg.pollWaitMs, limit: cfg.pollLimit, ...(offered ? { availableSlots: offered } : {}), ...(reservation?.notAfter ? { notAfter: reservation.notAfter } : {}) }, { signal: pollAbort.signal });
          commands = res.commands ?? [];
          heldClaims = res.heldClaims ?? null;
          answeredServerTime = typeof res.serverTime === 'string' ? res.serverTime : null;
          observeServerTime(answeredServerTime);
          await publishControlPlaneStatus(true);
          failures = 0;
        } catch (err) {
          settle();
          stopController.signal.removeEventListener('abort', onStop);
          const freed = await watcher;
          if (freed && !stopped) {
            carried = freed;
            const idleMs = cfg.minIdlePollCycleMs - (performance.now() - pollStartedAt);
            if (idleMs > 0) await sleep(idleMs);
            continue;
          }
          if (stopped) break;
          const kind = await handleApiError(err, 'poll');
          if (kind === 'fatal') break;
          if (kind === 'fence') {
            failures = 0;
            continue;
          }
          failures += 1;
          if (failures >= cfg.maxConsecutiveFailures) {
            stop();
            onFatal(err);
            break;
          }
          await sleep(Math.min(cfg.baseBackoffMs * 2 ** (failures - 1), cfg.maxBackoffMs));
          continue;
        }
        settle();
        stopController.signal.removeEventListener('abort', onStop);
        carried = await watcher;
        if (reservation) {
          const used = addSlots({}, {});
          for (const command of commands) {
            const backend = command.payload?.execution?.backend;
            if (command.slotGranted === true && SLOT_BACKENDS.includes(backend)) {
              used[backend] += 1;
              command.grantId = reservation.grantId;
            }
          }
          await releaseSlots(reservation.grantId, Object.fromEntries(SLOT_BACKENDS.map((k) => [k, Math.max(0, offered[k] - used[k])])));
          if (heldClaims && answeredServerTime) {
            const now = Date.parse(answeredServerTime);
            const expired = reservation.heldBatches.filter((b) => typeof b.notAfter === 'string' && Date.parse(b.notAfter) < now);
            const redelivered = addSlots({}, {});
            for (const command of commands) {
              const backend = command.payload?.execution?.backend;
              if (command.slotHeld === true && SLOT_BACKENDS.includes(backend)) redelivered[backend] += 1;
            }
            for (const k of SLOT_BACKENDS) {
              let unused = Math.max(0, expired.reduce((n, b) => n + (b.counts?.[k] ?? 0), 0) - redelivered[k] - (heldClaims[k] ?? 0));
              for (const b of expired) {
                const n = Math.min(unused, b.counts?.[k] ?? 0);
                if (n > 0) await releaseSlots(b.grantId, { ...addSlots({}, {}), [k]: n }, b.version);
                unused -= n;
              }
            }
          }
        }
        for (const command of commands) {
          if (stopped) break;
          await handleCommand(command, fence);
          await flushObservations();
        }
        if (commands.length === 0) {
          await flushObservations();
          const idleMs = cfg.minIdlePollCycleMs - (performance.now() - pollStartedAt);
          if (idleMs > 0 && !stopped) await sleep(idleMs);
        }
      }
      stopped = true;
      await heartbeatLoop;
    },

    stop,
  };
}
