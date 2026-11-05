import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createIpcServer } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { readProcessIdentity, sameProcess } from '../../../src/supervisor/process-identity.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ff-spool-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const TOTAL = 10_000;
function eventFor(i) {
  const base = { sessionId: 'sess-1', runId: 'run-1', generation: 1, nativeEventId: `n-${i}` };
  if (i === TOTAL) return { ...base, kind: 'state', payload: { terminal: 'completed' } };
  if (i % 1000 === 0) return { ...base, kind: 'attention', payload: { request: `q-${i}` } };
  return { ...base, kind: 'timeline', payload: { text: `line ${i}` } };
}

describe('durable event spool', () => {
  it('10,000 events with a detached consumer arrive in order after reconnect, terminal and attention events included', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
    const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
    const handlers = createSupervisorHandlers({ ledger, profiles: [], backends: {}, containment: { state: 'unavailable', reason: 'test' }, log: () => {} });
    const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers });
    await server.listen();
    const seen = [];
    async function drain(client, stopAfter = Infinity) {
      let { deliveredSeq } = await client.request('hello', {});
      for (;;) {
        const batch = await client.request('events', { afterSeq: deliveredSeq, limit: 500 });
        if (batch.events.length === 0 || seen.length >= stopAfter) return;
        seen.push(...batch.events);
        deliveredSeq = batch.events.at(-1).seq;
        await client.request('ackEvents', { uptoSeq: deliveredSeq });
      }
    }
    try {
      for (let i = 1; i <= 2500; i++) ledger.appendEvent(eventFor(i));
      const first = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' });
      await drain(first, 1000);
      const unacked = await first.request('events', { afterSeq: seen.at(-1).seq, limit: 500 });
      expect(unacked.events.length).toBe(500);
      await first.close();
      for (let i = 2501; i <= TOTAL; i++) ledger.appendEvent(eventFor(i));
      const second = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' });
      await drain(second);
      await second.close();
    } finally {
      await server.close();
    }
    expect(seen.map((e) => e.seq)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(seen.map((e) => e.nativeEventId)).toEqual(Array.from({ length: TOTAL }, (_, i) => `n-${i + 1}`));
    expect(seen.filter((e) => e.kind === 'attention')).toHaveLength(9);
    expect(seen.at(-1)).toMatchObject({ kind: 'state', payload: { terminal: 'completed' } });
    const reopened = createLedger({ dir: join(stateDir, 'supervisor') });
    expect(reopened.eventsAfter(TOTAL - 1)).toHaveLength(1);
    expect(reopened.appendEvent(eventFor(TOTAL))).toEqual({ seq: TOTAL });
  }, 120_000);

  it('a reused PID with other startTicks is not the same process', async () => {
    const self = await readProcessIdentity(process.pid);
    expect(self).toMatchObject({ pid: process.pid, startTicks: expect.any(Number), bootId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(sameProcess(self, { ...self })).toBe(true);
    expect(sameProcess(self, { ...self, startTicks: self.startTicks + 1 })).toBe(false);
    expect(sameProcess(self, { ...self, bootId: '00000000-0000-0000-0000-000000000000' })).toBe(false);
    expect(sameProcess(self, null)).toBe(false);
    expect(await readProcessIdentity(2 ** 22 + 7)).toBeNull();
  });
});
