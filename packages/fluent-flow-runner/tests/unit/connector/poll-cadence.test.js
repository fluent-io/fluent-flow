import { describe, it, expect, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ConnectorApiError } from '../../../src/connector/connector-client.js';
import { createConnectorLoop } from '../../../src/connector/loop.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

function fakeClient({ poll, observe } = {}) {
  const calls = { polls: [], heartbeats: [], observes: [], acks: [], observeInFlight: 0, maxObserveInFlight: 0 };
  const client = {
    register: async () => ({ connectorSessionId: 'cs-1', leaseEpoch: 1, heartbeatIntervalMs: undefined }),
    heartbeat: async (body) => {
      calls.heartbeats.push(performance.now());
      return { leaseEpoch: body.leaseEpoch };
    },
    poll: async (body, opts) => {
      const entry = { startedAt: performance.now(), endedAt: null, body };
      calls.polls.push(entry);
      try {
        return await poll(calls.polls.length, opts?.signal);
      } finally {
        entry.endedAt = performance.now();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    ack: async (id, body) => {
      calls.acks.push({ id, state: body.state, at: performance.now() });
      return { state: body.state };
    },
    observe: async (body, opts) => {
      calls.observeInFlight += 1;
      calls.maxObserveInFlight = Math.max(calls.maxObserveInFlight, calls.observeInFlight);
      calls.observes.push({ at: performance.now(), eventIds: body.events.map((e) => e.eventId) });
      try {
        if (observe) await observe(opts?.signal);
        return { acceptedEventIds: body.events.map((e) => e.eventId) };
      } finally {
        calls.observeInFlight -= 1;
      }
    },
  };
  return { client, calls };
}

const journal = {
  append: async () => {},
  markObservationsAccepted: async () => {},
  pendingObservationIds: () => [],
  observationById: () => null,
};

const executor = { execute: async () => ({ state: 'applied', result: {}, observations: [] }) };

function observation(id) {
  return { eventId: id, runId: '00000000-0000-4000-8000-000000000001', sessionId: null, observedAt: new Date().toISOString(), kind: 'timeline', payload: { text: id } };
}

let loops = [];
function build(client, intervals = {}, capacity = undefined) {
  const loop = createConnectorLoop({
    client, executor, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', capacity,
    intervals: { heartbeatIntervalMs: 15_000, baseBackoffMs: 200, maxBackoffMs: 1_000, ...intervals },
  });
  loops.push(loop);
  return loop;
}

afterEach(() => {
  for (const loop of loops) loop.stop();
  loops = [];
});

describe('connector poll cadence', () => {
  it('repeated immediate empty responses cannot spin the poll loop', async () => {
    const { client, calls } = fakeClient({ poll: async () => ({ commands: [] }) });
    const loop = build(client);
    const running = loop.start();
    await sleep(1500);
    loop.stop();
    await running;
    expect(calls.polls.length).toBeGreaterThanOrEqual(2);
    expect(calls.polls.length).toBeLessThanOrEqual(3);
  });

  it('a server-held empty poll is followed by the next poll without extra delay', async () => {
    const { client, calls } = fakeClient({ poll: async (_n, signal) => { await abortable(1100, signal); return { commands: [] }; } });
    const loop = build(client);
    const running = loop.start();
    await sleep(2400);
    loop.stop();
    await running;
    expect(calls.polls.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < calls.polls.length; i++) {
      expect(calls.polls[i].startedAt - calls.polls[i - 1].endedAt).toBeLessThan(100);
    }
  });

  it('non-empty batches drain back to back', async () => {
    const command = (n) => ({ id: `cmd-${n}`, runId: `run-${n}`, sessionId: null, kind: 'launch', payload: {}, leaseEpoch: 1 });
    const { client, calls } = fakeClient({ poll: async (n) => ({ commands: n <= 3 ? [command(n)] : [] }) });
    const loop = build(client);
    const started = performance.now();
    const running = loop.start();
    await sleep(500);
    loop.stop();
    await running;
    expect(calls.acks.map((a) => a.id)).toEqual(['cmd-1', 'cmd-2', 'cmd-3']);
    expect(calls.acks[2].at - started).toBeLessThan(300);
  });

  it('stop interrupts the idle wait promptly', async () => {
    const { client } = fakeClient({ poll: async () => ({ commands: [] }) });
    const loop = build(client);
    const running = loop.start();
    await sleep(150);
    const stoppedAt = performance.now();
    loop.stop();
    await running;
    expect(performance.now() - stoppedAt).toBeLessThan(100);
  });

  it('heartbeats keep their own cadence while polls are idle', async () => {
    const { client, calls } = fakeClient({ poll: async () => ({ commands: [] }) });
    const loop = build(client, { heartbeatIntervalMs: 100 });
    const running = loop.start();
    await sleep(850);
    loop.stop();
    await running;
    expect(calls.heartbeats.length).toBeGreaterThanOrEqual(6);
    expect(calls.polls.length).toBeLessThanOrEqual(2);
  });

  it('poll errors still use the normal exponential backoff', async () => {
    const { client, calls } = fakeClient({ poll: async () => { throw new ConnectorApiError('Poll', 500, 'internal_error'); } });
    const loop = build(client, { baseBackoffMs: 200 });
    const running = loop.start();
    await sleep(700);
    loop.stop();
    await running;
    expect(calls.polls.length).toBe(3);
    const gap1 = calls.polls[1].startedAt - calls.polls[0].endedAt;
    const gap2 = calls.polls[2].startedAt - calls.polls[1].endedAt;
    expect(gap1).toBeGreaterThanOrEqual(190);
    expect(gap1).toBeLessThan(350);
    expect(gap2).toBeGreaterThanOrEqual(390);
  });

  it('live observations flush promptly while a poll is held and heartbeats are 15s apart', async () => {
    const { client, calls } = fakeClient({ poll: async (_n, signal) => { await abortable(25_000, signal); return { commands: [] }; } });
    const loop = build(client, { heartbeatIntervalMs: 15_000 });
    const running = loop.start();
    await sleep(100);
    const queuedAt = performance.now();
    for (let i = 0; i < 5; i++) loop.enqueueObservations([observation(`ev-${i}`)]);
    await sleep(1000);
    expect(calls.observes.length).toBe(1);
    expect(calls.observes[0].eventIds).toEqual(['ev-0', 'ev-1', 'ev-2', 'ev-3', 'ev-4']);
    expect(calls.observes[0].at - queuedAt).toBeLessThan(750);
    expect(loop.pendingObservationIds).toEqual([]);
    const stoppedAt = performance.now();
    loop.stop();
    await running;
    expect(performance.now() - stoppedAt).toBeLessThan(100);
  });

  it('a freed slot aborts a held poll and re-polls with the new availability after the 1-second floor', async () => {
    const free = { 'claude-code': 1, codex: 0 };
    const reserves = [];
    const releases = [];
    const capacity = {
      async reserve() {
        const granted = { ...free };
        free['claude-code'] = 0;
        free.codex = 0;
        reserves.push({ at: performance.now(), granted });
        return { availableSlots: granted, grantId: `g-${reserves.length}`, heldBatches: [] };
      },
      async release(unused) { releases.push(unused); },
    };
    const { client, calls } = fakeClient({ poll: async (_n, signal) => { await abortable(25_000, signal); return { commands: [] }; } });
    const loop = build(client, {}, capacity);
    const running = loop.start();
    await sleep(300);
    expect(calls.polls).toHaveLength(1);
    expect(calls.polls[0].body.availableSlots).toEqual({ 'claude-code': 1, codex: 0 });
    free.codex = 1;
    await sleep(1500);
    loop.stop();
    await running;
    expect(calls.polls.length).toBeGreaterThanOrEqual(2);
    const [held, next] = calls.polls;
    expect(held.endedAt - held.startedAt).toBeLessThan(1600);
    expect(next.body.availableSlots).toEqual({ 'claude-code': 0, codex: 1 });
    expect(next.startedAt - held.startedAt).toBeGreaterThanOrEqual(1000);
    expect(next.startedAt - held.startedAt).toBeLessThan(1600);
    expect(releases.every((unused) => !unused['claude-code'])).toBe(true);
  });

  it('observations queued during an in-flight flush follow it without overlapping', async () => {
    const { client, calls } = fakeClient({
      poll: async (_n, signal) => { await abortable(25_000, signal); return { commands: [] }; },
      observe: (signal) => abortable(300, signal),
    });
    const loop = build(client);
    const running = loop.start();
    await sleep(100);
    loop.enqueueObservations([observation('a')]);
    await sleep(400);
    loop.enqueueObservations([observation('b')]);
    await sleep(1200);
    loop.stop();
    await running;
    expect(calls.maxObserveInFlight).toBe(1);
    expect(calls.observes.map((o) => o.eventIds)).toEqual([['a'], ['b']]);
  });

  function grantModel(free) {
    const batches = new Map();
    const releases = [];
    let seq = 0;
    const total = (k) => [...batches.values()].reduce((n, b) => n + b.counts[k], 0);
    return {
      batches,
      releases,
      free,
      total,
      capacity: {
        async reserve({ notAfter } = {}) {
          const heldBatches = [...batches.entries()].filter(([, b]) => total && (b.counts['claude-code'] || b.counts.codex)).map(([grantId, b]) => ({ grantId, counts: { ...b.counts }, notAfter: b.notAfter }));
          const availableSlots = { ...free };
          for (const k of Object.keys(free)) free[k] = 0;
          const grantId = `g${++seq}`;
          batches.set(grantId, { counts: { ...availableSlots }, notAfter: notAfter ?? null });
          return { availableSlots, grantId, heldBatches };
        },
        async release({ grantId, unused }) {
          releases.push({ grantId, unused });
          const b = batches.get(grantId);
          for (const k of Object.keys(unused)) { const n = Math.min(unused[k], b?.counts[k] ?? 0); if (b) b.counts[k] -= n; free[k] += n; }
        },
      },
      consume(backend) {
        for (const b of batches.values()) if (b.counts[backend] > 0) { b.counts[backend] -= 1; return true; }
        return false;
      },
    };
  }
  const T0 = Date.parse('2026-11-05T12:00:00.000Z');
  const at = (ms) => new Date(T0 + ms).toISOString();
  const withClock = (client, serverTime = at(0)) => Object.assign(client, { register: async () => ({ connectorSessionId: 'cs-1', leaseEpoch: 1, serverTime }) });

  it('a lost poll keeps its grants while the server still reports them claimed', async () => {
    const model = grantModel({ 'claude-code': 0, codex: 1 });
    let held = 1;
    let serverMs = 0;
    const { client, calls } = fakeClient({ poll: async (n) => {
      if (n === 1) throw new Error('Poll request failed: socket hang up');
      serverMs += 60_000;
      return { commands: [], heldClaims: { 'claude-code': 0, codex: held }, serverTime: at(serverMs) };
    } });
    const loop = build(withClock(client), { baseBackoffMs: 20, maxBackoffMs: 20, minIdlePollCycleMs: 20 }, model.capacity);
    const running = loop.start();
    await sleep(400);
    expect(calls.polls.length).toBeGreaterThan(4);
    expect(model.total('codex')).toBe(1);
    expect(model.releases.some((r) => r.unused.codex > 0)).toBe(false);
    held = 0;
    const settledAt = model.releases.length;
    await sleep(150);
    loop.stop();
    await running;
    expect(model.releases.slice(settledAt).find((r) => r.unused.codex > 0)).toEqual({ grantId: 'g1', unused: { 'claude-code': 0, codex: 1 } });
    expect(model.total('codex') + model.free.codex).toBe(1);
  });

  it('a held claim redelivered in a limited batch uses its grant, and an omitted one keeps its own', async () => {
    const model = grantModel({ 'claude-code': 0, codex: 2 });
    const launchOf = (id) => ({ id, runId: `run-${id}`, sessionId: `s-${id}`, kind: 'launch', payload: { execution: { backend: 'codex' } }, leaseEpoch: 1, slotHeld: true });
    const { client } = fakeClient({ poll: async (n) => {
      if (n === 1) throw new Error('Poll request failed: socket hang up');
      if (n === 2) return { commands: [launchOf('a')], heldClaims: { 'claude-code': 0, codex: 1 }, serverTime: at(60_000) };
      if (n === 3) return { commands: [launchOf('b')], heldClaims: { 'claude-code': 0, codex: 0 }, serverTime: at(120_000) };
      return { commands: [], heldClaims: { 'claude-code': 0, codex: 0 }, serverTime: at(180_000) };
    } });
    const executed = [];
    const consuming = { execute: async (command) => { executed.push([command.id, model.total('codex')]); model.consume('codex'); return { state: 'accepted', stage: 'other', result: {}, observations: [] }; } };
    const loop = createConnectorLoop({ client: withClock(client), executor: consuming, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', capacity: model.capacity,
      intervals: { heartbeatIntervalMs: 15_000, baseBackoffMs: 20, maxBackoffMs: 20, minIdlePollCycleMs: 20 } });
    loops.push(loop);
    const running = loop.start();
    await sleep(300);
    loop.stop();
    await running;
    expect(executed).toEqual([['a', 2], ['b', 1]]);
    expect(model.releases.some((r) => r.unused.codex > 0)).toBe(false);
    expect(model.total('codex')).toBe(0);
  });

  it("a lost poll's grant is released only after an answer's server time passes that poll's own deadline", async () => {
    const model = grantModel({ 'claude-code': 0, codex: 1 });
    let serverMs = 1_000;
    const { client, calls } = fakeClient({ poll: async (n) => {
      if (n === 1) throw new Error('Poll request failed: socket hang up');
      return { commands: [], heldClaims: { 'claude-code': 0, codex: 0 }, serverTime: at(serverMs) };
    } });
    const loop = build(withClock(client), { baseBackoffMs: 20, maxBackoffMs: 20, minIdlePollCycleMs: 20 }, model.capacity);
    const running = loop.start();
    await sleep(250);
    const deadline = calls.polls[0].body.notAfter;
    expect(Date.parse(deadline)).toBeGreaterThan(T0 + 25_000);
    expect(calls.polls.length).toBeGreaterThan(3);
    expect(model.total('codex')).toBe(1);
    expect(model.releases.some((r) => r.grantId === 'g1')).toBe(false);
    serverMs = Date.parse(deadline) - T0 + 1;
    await sleep(150);
    loop.stop();
    await running;
    expect(model.releases.find((r) => r.grantId === 'g1')).toEqual({ grantId: 'g1', unused: { 'claude-code': 0, codex: 1 } });
    expect(calls.polls.every((p) => typeof p.body.notAfter === 'string')).toBe(true);
  });
});
