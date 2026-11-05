import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectorLoop } from '../../../src/connector/loop.js';
import { createJournal } from '../../../src/connector/journal.js';

it('bounds actual UTF8 request bytes and event count, without starving output behind an oversized event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-batch-'));
  const journal = createJournal({ dir });
  const batches = [];
  let loop;
  const client = {
    register: async () => ({ connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 10 }),
    heartbeat: async () => ({ leaseEpoch: 1 }),
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return { commands: [] }; },
    observe: async (body) => {
      batches.push(body);
      if (batches.flatMap((batch) => batch.events).length >= 106) loop.stop();
      return { acceptedEventIds: body.events.map((event) => event.eventId) };
    },
  };
  loop = createConnectorLoop({ client, executor: {}, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', intervals: { heartbeatIntervalMs: 10 } });
  const events = Array.from({ length: 106 }, (_, index) => ({ eventId: `event-${index}`, runId: 'run', sessionId: 'session', observedAt: new Date().toISOString(), kind: 'timeline', payload: { item: { type: 'assistant_message', text: index === 0 ? '界'.repeat(500_000) : '界'.repeat(index < 5 ? 100_000 : 2) } } }));
  loop.enqueueObservations(events);
  const timeout = setTimeout(() => loop.stop(), 3000);
  try { await loop.start(); } finally { clearTimeout(timeout); rmSync(dir, { recursive: true, force: true }); }
  expect(batches.every((batch) => batch.events.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024)).toBe(true);
  const delivered = batches.flatMap((batch) => batch.events);
  expect(delivered).toHaveLength(106);
  expect(delivered.find((event) => event.eventId === 'event-0').payload).toMatchObject({ unavailable: true, reason: 'observation_too_large' });
});

it('a native observation over 1 MiB is sent as fragments and accepted only when every fragment is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-batch-native-'));
  const journal = createJournal({ dir });
  const batches = [];
  let rejectOnce = true;
  let loop;
  const id = 'codex:22222222-2222-4222-8222-222222222222:1:item:big:completed';
  const client = {
    register: async () => ({ connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 10 }),
    heartbeat: async () => ({ leaseEpoch: 1 }),
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return { commands: [] }; },
    observe: async (body) => {
      batches.push(body);
      const accepted = body.events.map((event) => event.eventId).filter((eventId) => !(rejectOnce && eventId.endsWith('#f1/4')));
      if (body.events.some((event) => event.eventId.endsWith('#f1/4'))) rejectOnce = false;
      return { acceptedEventIds: accepted };
    },
  };
  loop = createConnectorLoop({ client, executor: {}, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', intervals: { heartbeatIntervalMs: 10 } });
  const text = '界🎉'.repeat(150_000);
  const payload = { phase: 'completed', item: { type: 'agentMessage', id: 'big', text }, source: { backend: 'codex', generation: 1, nativeEventId: 'item:big:completed', seq: 1 } };
  const observation = { eventId: id, runId: 'run', sessionId: 'session', observedAt: new Date().toISOString(), kind: 'timeline', payload };
  await journal.append({ type: 'observation', ...observation, at: observation.observedAt });
  loop.enqueueObservations([observation]);
  const timeout = setTimeout(() => loop.stop(), 8000);
  const watcher = setInterval(() => { if (journal.pendingObservationIds().length === 0) loop.stop(); }, 20);
  try { await loop.start(); } finally { clearTimeout(timeout); clearInterval(watcher); }
  try {
    expect(batches.every((batch) => batch.events.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024)).toBe(true);
    const sent = batches.flatMap((batch) => batch.events);
    expect(sent.some((event) => event.eventId === id)).toBe(false);
    const fragments = [...new Map(sent.map((event) => [event.eventId, event])).values()];
    expect(fragments.map((event) => event.eventId)).toEqual([0, 1, 2, 3].map((i) => `${id}#f${i}/4`));
    expect(fragments.every((event) => event.kind === 'timeline' && event.runId === 'run' && event.sessionId === 'session' && event.observedAt === observation.observedAt)).toBe(true);
    const bytes = Buffer.concat(fragments.map((event) => Buffer.from(event.payload.data, 'base64')));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(payload);
    expect(fragments.map((event) => [event.payload.fragmentOf, event.payload.index, event.payload.count, event.payload.encoding])).toEqual([0, 1, 2, 3].map((i) => [id, i, 4, 'base64']));
    expect(journal.pendingObservationIds()).toEqual([]);
    expect(batches.filter((batch) => batch.events.some((event) => event.eventId.endsWith('#f1/4')))).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

it('a following native observation waits for every remaining fragment of the earlier original, including a retried one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-batch-order-'));
  const journal = createJournal({ dir });
  const batches = [];
  const acceptedBefore = [];
  const accepted = new Set();
  let dropOnce = true;
  let loop;
  const session = '22222222-2222-4222-8222-222222222222';
  const id = `codex:${session}:1:item:big:completed`;
  const followingId = `codex:${session}:1:item:after:completed`;
  const client = {
    register: async () => ({ connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 10 }),
    heartbeat: async () => ({ leaseEpoch: 1 }),
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return { commands: [] }; },
    observe: async (body) => {
      batches.push(body.events.map((e) => e.eventId));
      acceptedBefore.push(new Set(accepted));
      const ok = body.events.map((e) => e.eventId).filter((eventId) => !(dropOnce && eventId === `${id}#f1/4`));
      if (body.events.some((e) => e.eventId === `${id}#f1/4`)) dropOnce = false;
      for (const eventId of ok) accepted.add(eventId);
      return { acceptedEventIds: ok };
    },
  };
  loop = createConnectorLoop({ client, executor: {}, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', intervals: { heartbeatIntervalMs: 10 } });
  const observedAt = new Date().toISOString();
  const big = { eventId: id, runId: 'run', sessionId: session, observedAt, kind: 'timeline', payload: { item: { type: 'agentMessage', text: '界🎉'.repeat(150_000) } } };
  const following = { eventId: followingId, runId: 'run', sessionId: session, observedAt, kind: 'timeline', payload: { item: { type: 'agentMessage', text: 'after' } } };
  for (const o of [big, following]) await journal.append({ type: 'observation', ...o, at: o.observedAt });
  loop.enqueueObservations([big, following]);
  const timeout = setTimeout(() => loop.stop(), 8000);
  const watcher = setInterval(() => { if (journal.pendingObservationIds().length === 0) loop.stop(); }, 20);
  try { await loop.start(); } finally { clearTimeout(timeout); clearInterval(watcher); }
  try {
    const firstWithFollowing = batches.findIndex((b) => b.includes(followingId));
    expect(firstWithFollowing).toBeGreaterThan(-1);
    const fragments = [0, 1, 2, 3].map((i) => `${id}#f${i}/4`);
    const remaining = fragments.filter((f) => !acceptedBefore[firstWithFollowing].has(f));
    const batch = batches[firstWithFollowing];
    for (const f of remaining) expect(batch.indexOf(f), f).toBeGreaterThan(-1);
    for (const f of remaining) expect(batch.indexOf(f), f).toBeLessThan(batch.indexOf(followingId));
    expect(journal.pendingObservationIds()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

for (const failure of ['rejected', 'omitted']) {
  it(`a following event never overtakes an original whose final fragment was ${failure} once`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-batch-final-'));
    const journal = createJournal({ dir });
    const session = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    const id = `codex:${session}:1:item:big:completed`;
    const finalFragment = `${id}#f3/4`;
    const followingId = `codex:${session}:1:item:after:completed`;
    const otherId = `codex:${other}:1:item:other:completed`;
    const requests = [];
    const trace = [];
    const acceptedFragments = new Set();
    let failOnce = true;
    let loop;
    const client = {
      register: async () => ({ connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 10 }),
      heartbeat: async () => ({ leaseEpoch: 1 }),
      poll: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return { commands: [] }; },
      observe: async (body) => {
        const ids = body.events.map((e) => e.eventId);
        const failNow = failOnce && ids.includes(finalFragment);
        if (failNow) failOnce = false;
        const accepted = ids.filter((eventId) => !(failNow && eventId === finalFragment));
        requests.push({ sent: ids, accepted });
        for (const eventId of accepted) {
          if (eventId.startsWith(`${id}#f`)) {
            acceptedFragments.add(eventId);
            if (acceptedFragments.size === 4 && !trace.includes(id)) trace.push(id);
          } else trace.push(eventId);
        }
        return { acceptedEventIds: accepted, rejectedEventIds: failNow && failure === 'rejected' ? [finalFragment] : [] };
      },
    };
    loop = createConnectorLoop({ client, executor: {}, journal, catalog: {}, instanceId: 'pc', sdkVersion: 'test', daemonVersion: 'test', intervals: { heartbeatIntervalMs: 10 } });
    const observedAt = new Date().toISOString();
    const big = { eventId: id, runId: 'run', sessionId: session, observedAt, kind: 'timeline', payload: { item: { type: 'agentMessage', text: '界🎉'.repeat(150_000) } } };
    const following = { eventId: followingId, runId: 'run', sessionId: session, observedAt, kind: 'timeline', payload: { item: { type: 'agentMessage', text: 'after' } } };
    const independent = { eventId: otherId, runId: 'run-2', sessionId: other, observedAt, kind: 'timeline', payload: { item: { type: 'agentMessage', text: 'other session' } } };
    for (const o of [big, following, independent]) await journal.append({ type: 'observation', ...o, at: o.observedAt });
    loop.enqueueObservations([big, following, independent]);
    const timeout = setTimeout(() => loop.stop(), 8000);
    const watcher = setInterval(() => { if (journal.pendingObservationIds().length === 0) loop.stop(); }, 20);
    try { await loop.start(); } finally { clearTimeout(timeout); clearInterval(watcher); }
    try {
      expect(requests.filter((r) => r.sent.includes(finalFragment))).toHaveLength(2);
      expect(trace.indexOf(id)).toBeGreaterThan(-1);
      expect(trace.indexOf(id)).toBeLessThan(trace.indexOf(followingId));
      const firstFollowing = requests.findIndex((r) => r.sent.includes(followingId));
      const acceptedBefore = new Set(requests.slice(0, firstFollowing).flatMap((r) => r.accepted));
      expect([0, 1, 2, 3].every((i) => acceptedBefore.has(`${id}#f${i}/4`))).toBe(true);
      const otherAt = requests.findIndex((r) => r.accepted.includes(otherId));
      const finalAcceptedAt = requests.findIndex((r) => r.accepted.includes(finalFragment));
      expect(otherAt).toBeLessThan(finalAcceptedAt);
      expect(journal.pendingObservationIds()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
