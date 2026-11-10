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
