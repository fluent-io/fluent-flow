import { describe, it, expect } from 'vitest';
import { stopContained } from '../../../src/supervisor/stop.js';

const worker = { sessionId: 's1', generation: 1, cgroupPath: 'scope/w-1-s1', identity: { pid: 4242, startTicks: 7, bootId: 'b' }, pgid: 4242 };

function fakeContainment({ emptyAfterTerm = Infinity, emptyAfterKill = 0 } = {}) {
  const calls = [];
  let reads = 0;
  let termAt = null;
  let killAt = null;
  return {
    calls,
    async terminate(target) {
      calls.push({ op: 'terminate', at: Date.now(), target });
      termAt = reads;
      return true;
    },
    async kill(target) {
      calls.push({ op: 'kill', at: Date.now(), target });
      killAt = reads;
    },
    async read({ cgroupPath }) {
      reads += 1;
      calls.push({ op: 'read', at: Date.now(), cgroupPath });
      if (killAt !== null && reads - killAt > emptyAfterKill) return { populated: false };
      if (termAt !== null && reads - termAt > emptyAfterTerm) return { populated: false };
      return { populated: true };
    },
  };
}

describe('stopContained', () => {
  it('quiesced only after populated is 0', async () => {
    const containment = fakeContainment({ emptyAfterTerm: 3 });
    const result = await stopContained({ worker, containment, graceMs: 2_000, killWaitMs: 500 });
    expect(result).toBe('quiesced');
    const reads = containment.calls.filter((c) => c.op === 'read');
    expect(reads.length).toBe(4);
    expect(containment.calls[0]).toMatchObject({ op: 'terminate', target: { pgid: 4242, identity: worker.identity } });
    expect(containment.calls.some((c) => c.op === 'kill')).toBe(false);
  });

  it('killContainment runs after the grace period', async () => {
    const containment = fakeContainment({ emptyAfterKill: 1 });
    const started = Date.now();
    const result = await stopContained({ worker, containment, graceMs: 300, killWaitMs: 1_000 });
    expect(result).toBe('quiesced');
    const kill = containment.calls.find((c) => c.op === 'kill');
    expect(kill).toBeDefined();
    expect(kill.at - started).toBeGreaterThanOrEqual(300);
    expect(kill.target).toEqual({ cgroupPath: worker.cgroupPath, generation: 1, sessionId: 's1' });
    expect(containment.calls.findIndex((c) => c.op === 'terminate')).toBeLessThan(containment.calls.findIndex((c) => c.op === 'kill'));
  });

  it('still populated after killWaitMs is uncertain', async () => {
    const containment = fakeContainment({ emptyAfterKill: Infinity });
    const started = Date.now();
    const result = await stopContained({ worker, containment, graceMs: 100, killWaitMs: 300 });
    expect(result).toBe('uncertain');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(containment.calls.filter((c) => c.op === 'kill')).toHaveLength(1);
  });

  it('an unknown populated state is uncertain, never quiesced', async () => {
    const containment = { ...fakeContainment(), async read() { return { populated: null }; } };
    expect(await stopContained({ worker, containment, graceMs: 50, killWaitMs: 50 })).toBe('uncertain');
  });

  it('without a verified leader it skips SIGTERM and kills the exact leaf at once', async () => {
    const containment = fakeContainment({ emptyAfterKill: 0 });
    const result = await stopContained({ worker: { ...worker, identity: null, pgid: null }, containment, graceMs: 5_000, killWaitMs: 500 });
    expect(result).toBe('quiesced');
    expect(containment.calls.some((c) => c.op === 'terminate')).toBe(false);
    expect(containment.calls[0].op).toBe('kill');
  });
});
