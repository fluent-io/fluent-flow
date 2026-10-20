import { ConnectorApiError } from './connector-client.js';

/**
 * Connector main loop: register → (heartbeat ‖ poll → execute → ack → observe).
 *
 * Fencing rules:
 * - Every call carries the CURRENT captured lease fence at call time. A 409
 *   with code `stale_lease` (only that code) means the lease was superseded:
 *   drop the session, re-register, continue on the same journal. Other 409s
 *   (permission/idempotency conflicts) are transient errors, NOT fence loss.
 * - Command acks use the fence captured at poll delivery, not a re-read
 *   session, so a concurrent re-registration cannot race the ack. A stale
 *   ack leaves the command journaled-acked; the server redelivers the SAME
 *   command id and execution is idempotent.
 * - An old superseded instance never steals the lease back: registering while
 *   another instance is active returns 409 `connector_session_active`, which
 *   is retried with backoff, not treated as fence loss.
 *
 * Launch is staged with the executor: bind (idle IDs) is journaled and
 * acked `accepted` to the control plane BEFORE the initial prompt is sent.
 *
 * Observations are journaled and flushed in batches; only server-accepted
 * event ids leave the pending set; startup re-queues never-confirmed ones.
 */

const DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  pollWaitMs: 25_000,
  pollLimit: 1,
  maxConsecutiveFailures: 10,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
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
  /** Sleep that wakes early when the loop is stopped; no listener leaks. */
  const sleep = (ms) =>
    new Promise((resolve) => {
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

  let session = null; // {connectorSessionId, leaseEpoch, heartbeatIntervalMs, staleAfterMs, offlineAfterMs}
  let stopped = false;
  const stopController = new AbortController();
  const runStates = new Map(); // runId -> last observed run state
  const TERMINAL_RUN_STATES = new Set(['idle', 'failed', 'cancelled']);
  const activeRunIds = () => [...runStates.entries()].filter(([, s]) => !TERMINAL_RUN_STATES.has(s)).map(([id]) => id);
  const pendingObservations = new Map(); // eventId -> observation
  let flushing = false;

  function stop() {
    stopped = true;
    stopController.abort(new Error('connector loop stopped'));
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
    // A3's canonical code is 'stale_fence'; 'stale_lease' kept for the
    // contract spelling. Any other 409 is NOT fence loss.
    return (
      err instanceof ConnectorApiError &&
      err.status === 409 &&
      (err.code === 'stale_fence' || err.code === 'stale_lease')
    );
  }

  /** Classify an API error for the loop: 'fence' | 'fatal' | 'transient'. */
  function classify(err) {
    if (!(err instanceof ConnectorApiError)) return 'transient';
    if (err.status === 401) return 'fatal';
    if (isStaleFence(err)) return 'fence';
    return 'transient'; // includes 409 connector_session_active and other conflicts
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

  /**
   * Ensure a live session; returns null while unregistered (retry with
   * backoff). Registering into an actively-held lease waits its turn — an old
   * superseded instance must not steal the registration back.
   */
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
    if (pendingObservations.size === 0 || flushing) return;
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
    try {
      const res = await client.observe({ ...fence, events }, { signal: stopController.signal });
      const accepted = res.acceptedEventIds ?? [];
      for (const id of accepted) pendingObservations.delete(id);
      // Durably checkpoint confirmations so a restart never resubmits the
      // accepted history.
      if (accepted.length) await journal.markObservationsAccepted(accepted);
    } catch (err) {
      handleApiError(err, 'observations');
    } finally {
      flushing = false;
    }
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

  /**
   * Recovery at startup: re-queue observations journaled but never confirmed
   * accepted (server dedupes by eventId). Commands themselves are NOT
   * re-executed from local state — the server is the source of command
   * payloads and redelivers the SAME command id under short leases; local
   * replay would lack the payload. Idempotent execution + stable ids make
   * that redelivery safe.
   */
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

  /**
   * Ack with the captured fence. Returns true only when the control plane
   * CONFIRMED the ack; a lost/stale/rejected ack means the server still owns
   * an unresolved command and will redeliver the SAME id.
   */
  async function ackCommand(command, fence, state, result, errorCode) {
    await journal.append({ type: 'acked', commandId: command.id, state, errorCode, at: new Date().toISOString() });
    const target = fence ?? currentFence();
    if (!target) return { confirmed: false, recordedState: null };
    try {
      // HTTP 200 is NOT acceptance: the server records its OWN final state
      // (re-checking authorization at ack time) and returns it — only an
      // exact echo of the requested state is a grant.
      const res = await client.ack(command.id, { ...target, state, result: privacy ? privacy.redact(result) : result, errorCode }, { signal: stopController.signal });
      const recordedState = res?.state ?? null;
      return { confirmed: recordedState === state, recordedState };
    } catch (err) {
      // A stale-fence/lost ack means the server never recorded this state;
      // the journal has it and the server will redeliver the SAME id.
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
          // The control plane has NOT confirmed the bound IDs on this fence:
          // the initial prompt waits. The journaled binding makes the server's
          // redelivery of the SAME command id resume safely at this point.
          log({ msg: 'bind ack unconfirmed; prompt withheld', commandId: command.id, runId: command.runId });
          return;
        }
        // IDs persisted AND acknowledged to the control plane. Before the
        // initial (billable) prompt: the host hook (observer readiness +
        // backfill) so execution can never outrun its observation.
        if (onBeforeDeliver) {
          try {
            await onBeforeDeliver({ runId: command.runId, sessionId: command.sessionId, ...outcome.result });
          } catch (err) {
            // Observation transport/readiness cannot prove execution failed.
            // Preserve accepted binding; retry only on the same server command.
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
    /** Registration material for tests/inspection. */
    get session() {
      return session;
    },

    /** Queue externally produced observations (timeline observer). */
    enqueueObservations(observations) {
      queueObservations(observations);
    },
    get pendingObservationIds() {
      return [...pendingObservations.keys()];
    },

    register,

    /**
     * Run the loop until stop(). Startup registers (with retry), recovers
     * journaled observations, then heartbeats and polls until stopped.
     */
    async start() {
      let failures = 0;
      // Initial registration with retry; 401 is fatal, a held lease waits.
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
        try {
          const res = await client.poll({ ...fence, waitMs: cfg.pollWaitMs, limit: cfg.pollLimit }, { signal: stopController.signal });
          commands = res.commands ?? [];
          failures = 0;
        } catch (err) {
          const kind = handleApiError(err, 'poll');
          if (kind === 'fatal') break;
          if (kind === 'fence') {
            // Lease superseded: re-register immediately, no failure penalty.
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
        // Keep draining even without commands so a large old-replay backlog
        // cannot starve fresh events for a whole heartbeat interval.
        if (commands.length === 0) await flushObservations();
      }
      stopped = true;
      await heartbeatLoop;
    },

    stop,
  };
}
