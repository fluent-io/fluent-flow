/** Durable live timeline observation. Initial prompts wait for subscription,
 * complete backfill and current pending permissions; reconnect failures hold
 * the same command for redelivery rather than inventing a terminal failure. */
export function createObserver({ paseo, journal, adapter, onObservations, log = (_obj) => {}, privacy = null }) {
  const subscriptions = new Map();
  const pending = new Map();

  async function record(binding, observations) {
    for (const original of observations) {
      const obs = privacy ? privacy.observation(original) : original;
      if (journal.observationById(obs.eventId)) continue;
      await journal.append({ type: 'observation', ...obs, at: obs.observedAt });
      await onObservations([obs]);
      if (obs.providerCursor) await journal.append({ type: 'cursor', sessionId: binding.sessionId, ...obs.providerCursor });
    }
  }

  async function emit(binding, events) {
    await record(binding, adapter.normalizeTimelineEvents({ ...binding, agentId: binding.paseoAgentId, events }));
  }

  async function backfill(entry) {
    const saved = journal.cursor(entry.binding.sessionId);
    const sequence = saved?.seq == null ? null : Number(saved.seq);
    if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('native cursor cannot be represented safely');
    let cursor = saved?.epoch && sequence !== null ? { epoch: saved.epoch, seq: sequence } : null;
    for (let page = 0; page < 100; page++) {
      const payload = await entry.handle.timeline.refetch({ ...(cursor ? { cursor } : {}), direction: cursor ? 'after' : 'tail', projection: 'canonical' });
      if (payload.error || payload.gap || payload.staleCursor || payload.reset) {
        await emit(entry.binding, [{ event: { type: 'timeline', item: { type: 'notification', level: 'warning', message: 'Execution history is incomplete; reconnecting.' } }, timestamp: new Date().toISOString() }]);
        if (payload.gap || payload.staleCursor || payload.reset) await journal.append({ type: 'cursor', sessionId: entry.binding.sessionId, epoch: null, seq: null });
        throw new Error('timeline history is incomplete');
      }
      const windows = [payload];
      if (!cursor) {
        let oldest = payload;
        for (let older = 0; oldest.hasOlder; older++) {
          if (older === 100 || !oldest.startCursor) throw new Error('retained history exceeds bounded window');
          const previous = await entry.handle.timeline.refetch({ cursor: oldest.startCursor, direction: 'before', projection: 'canonical' });
          if (previous.error || previous.gap || previous.staleCursor || previous.reset || JSON.stringify(previous.startCursor) === JSON.stringify(oldest.startCursor)) throw new Error('retained history is incomplete');
          windows.unshift(previous);
          oldest = previous;
        }
      }
      for (const window of windows) await emit(entry.binding, (window.entries ?? []).map((item) => ({
        event: { type: 'timeline', item: item.item, ...(item.turnId ? { turnId: item.turnId } : {}) },
        timestamp: item.timestamp, seq: item.seqEnd, epoch: window.epoch,
      })));
      if (!payload.hasNewer) return;
      if (!payload.endCursor || JSON.stringify(cursor) === JSON.stringify(payload.endCursor)) throw new Error('timeline cursor did not advance');
      cursor = payload.endCursor;
    }
    throw new Error('timeline backfill exceeds bounded window');
  }

  async function reconcileSnapshot(entry) {
    const response = await entry.handle.refresh();
    const agent = response?.agent ?? response;
    if (!Array.isArray(agent?.pendingPermissions)) throw new Error('pending permissions unavailable');
    const previous = pending.get(entry.binding.sessionId) ?? new Set();
    const current = new Set(agent.pendingPermissions.map((request) => request.id));
    const timestamp = new Date().toISOString();
    await emit(entry.binding, agent.pendingPermissions.map((request) => ({ event: { type: 'permission_requested', request }, timestamp })));
    await emit(entry.binding, [...previous].filter((id) => !current.has(id)).map((requestId) => ({ event: { type: 'permission_resolved', requestId }, timestamp })));
    pending.set(entry.binding.sessionId, current);
    await record(entry.binding, adapter.normalizeAgentSnapshot({ ...entry.binding, agentId: entry.binding.paseoAgentId, snapshot: agent }));
  }

  function attach(binding) {
    const handle = paseo.agents.ref(binding.paseoAgentId);
    const entry = { binding, handle, ready: null, unsub: null, backfilled: false, buffered: [], chain: Promise.resolve() };
    entry.unsub = handle.timeline.subscribe((payload) => {
      if (payload?.event?.type === 'replacement' || payload?.event?.type === 'subscription_restored') entry.backfilled = false;
      if (!entry.backfilled) { entry.buffered.push(payload); return; }
      entry.chain = entry.chain.then(async () => {
        await emit(binding, [payload]);
        if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(payload?.event?.type)) await reconcileSnapshot(entry);
      }).catch((error) => {
        entry.backfilled = false;
        log({ msg: 'timeline observation held', error: error.message });
      });
    });
    entry.ready = entry.unsub?.ready ?? Promise.resolve();
    entry.ready.catch(() => {}); // Readiness rejection is consumed by ensureReady.
    subscriptions.set(binding.paseoAgentId, entry);
    return entry;
  }

  async function release(entry) {
    if (typeof entry.unsub === 'function') entry.unsub();
    await entry.unsub?.release?.();
    await entry.chain;
  }

  async function ensureReady(binding) {
    if (!binding.paseoAgentId) throw Object.assign(new Error('Execution observer is not ready.'), { code: 'observer_not_ready' });
    let entry;
    try {
      entry = subscriptions.get(binding.paseoAgentId) ?? attach(binding);
      await entry.ready;
      await entry.chain;
      if (!entry.backfilled) {
        await backfill(entry);
      }
      await reconcileSnapshot(entry);
      while (entry.buffered.length) await emit(binding, entry.buffered.splice(0));
      entry.backfilled = true;
    } catch (cause) {
      subscriptions.delete(binding.paseoAgentId);
      if (entry) await release(entry).catch((error) => log({ msg: 'observer release failed', error: error.message }));
      throw Object.assign(new Error('Execution observer is not ready.', { cause }), { code: 'observer_not_ready' });
    }
  }

  return {
    async sync() {
      const bindings = new Map();
      for (const id of journal.boundCommandIds()) {
        const binding = journal.byCommand(id)?.binding;
        if (binding?.paseoAgentId) bindings.set(binding.paseoAgentId, binding);
      }
      await Promise.all([...bindings.values()].map(ensureReady));
      return bindings.size;
    },
    ensureReady,
    isAttached: (id) => subscriptions.has(id),
    async close() {
      await Promise.all([...subscriptions.values()].map((entry) => release(entry).catch((error) => log({ msg: 'observer close failed', error: error.message }))));
      subscriptions.clear();
    },
  };
}
