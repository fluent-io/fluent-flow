import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestRequest, pollResource } from '@/lib/collab/live';

afterEach(() => vi.useRealTimers());

describe('live resource refresh', () => {
  it('invalidates an older request and every request after disposal', () => {
    const requests = new LatestRequest();
    const old = requests.begin();
    const current = requests.begin();
    expect(old.aborted).toBe(true);
    expect(requests.current(old)).toBe(false);
    expect(requests.current(current)).toBe(true);
    requests.dispose();
    expect(current.aborted).toBe(true);
    expect(requests.current(current)).toBe(false);
  });

  it('keeps polling serial and aborts the resource when its view closes', async () => {
    vi.useFakeTimers();
    const observed: AbortSignal[] = [];
    let release!: () => void;
    const stop = pollResource(async signal => {
      observed.push(signal);
      if (observed.length === 1) await new Promise<void>(resolve => { release = resolve; });
    }, 3000);
    expect(observed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(observed).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(observed).toHaveLength(2);
    stop();
    expect(observed[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(observed).toHaveLength(2);
  });
});
