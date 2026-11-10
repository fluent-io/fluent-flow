import { performance } from 'node:perf_hooks';
import { ConnectorApiError } from './connector-client.js';


const DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  pollWaitMs: 25_000,
  pollLimit: 1,
  maxConsecutiveFailures: 10,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  minIdlePollCycleMs: 1_000,
  observationFlushDelayMs: 200,
};

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
  onBeforeDeliver = null,
  onReconcile = null,
  privacy = null,
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
  let flushing = false;
  let flushAgain = false;
  let flushTimer = null;

  function stop() {
    stopped = true;
    if (flushTimer) timers.clearTimeout(flushTimer);
    flushTimer = null;
    stopController.abort(new Error('connector loop stopped'));
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
    session = registration;
    return registration;
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
    try {
      const res = await client.heartbeat(
        { connectorSessionId: s.connectorSessionId, leaseEpoch: s.leaseEpoch, activeRunIds: activeRunIds(), observedAt: new Date().toISOString() },
        { signal: stopController.signal },
      );
      if (typeof res.leaseEpoch === 'number' && session && session.connectorSessionId === s.connectorSessionId) {
        session = { ...session, leaseEpoch: res.leaseEpoch };
      }
    } catch (err) {
      handleApiError(err, 'heartbeat');
    }
  }

  function handleApiError(err, label) {
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
      handleApiError(err, 'register');
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
    for (const original of pendingObservations.values()) {
      if (events.length === 100) break;
      let event = original;
      if (bytes([event]) > 1024 * 1024) {
        event = { ...original, payload: { unavailable: true, reason: 'observation_too_large', originalKind: original.kind } };
      }
      if (bytes([...events, event]) > 1024 * 1024) break;
      events.push(event);
    }
    if (!events.length) return;
    flushing = true;
    flushAgain = false;
    let progressed = false;
    try {
      const res = await client.observe({ ...fence, events }, { signal: stopController.signal });
      const accepted = res.acceptedEventIds ?? [];
      for (const id of accepted) pendingObservations.delete(id);
      if (accepted.length) await journal.markObservationsAccepted(accepted);
      progressed = accepted.length > 0;
    } catch (err) {
      handleApiError(err, 'observations');
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
    try {
      const res = await client.ack(command.id, { ...target, state, result: privacy ? privacy.redact(result) : result, errorCode }, { signal: stopController.signal });
      const recordedState = res?.state ?? null;
      return { confirmed: recordedState === state, recordedState };
    } catch (err) {
      handleApiError(err, 'ack');
      return { confirmed: false, recordedState: null };
    }
  }

  async function handleCommand(command, fence) {
    if (!runStates.has(command.runId)) runStates.set(command.runId, 'queued');
    try {
      const outcome = await executor.execute(command);
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
        const pollStartedAt = performance.now();
        try {
          const res = await client.poll({ ...fence, waitMs: cfg.pollWaitMs, limit: cfg.pollLimit }, { signal: stopController.signal });
          commands = res.commands ?? [];
          failures = 0;
        } catch (err) {
          const kind = handleApiError(err, 'poll');
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
