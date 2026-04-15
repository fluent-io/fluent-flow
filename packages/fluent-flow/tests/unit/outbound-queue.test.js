import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));

import { query } from '../../src/db/client.js';
import {
  enqueue,
  claimNext,
  markSucceeded,
  rescheduleWithBackoff,
  markRateLimited,
  park,
} from '../../src/db/outbound-queue.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('outbound-queue', () => {
  it('enqueue inserts a row keyed by client_ref and is idempotent on conflict', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const row = await enqueue({
      installationId: 10,
      kind: 'comment',
      clientRef: 'pr-1-comment-abc',
      payload: { body: 'hi' },
    });
    expect(row.id).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO provider_outbound_queue/i);
    expect(sql).toMatch(/ON CONFLICT \(client_ref\) DO NOTHING/i);
    expect(params[0]).toBe(10);
    expect(params[1]).toBe('comment');
    expect(params[2]).toBe('pr-1-comment-abc');
    expect(params[3]).toEqual(JSON.stringify({ body: 'hi' }));
  });

  it('claimNext uses FOR UPDATE SKIP LOCKED and excludes succeeded/parked rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, kind: 'comment', payload: {} }] });
    const row = await claimNext();
    expect(row.id).toBe(5);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(sql).toMatch(/succeeded_at IS NULL/i);
    expect(sql).toMatch(/parked_at IS NULL/i);
    expect(sql).toMatch(/next_attempt_at <= NOW\(\)/i);
  });

  it('claimNext returns null when nothing ready', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await claimNext()).toBeNull();
  });

  it('markSucceeded stamps succeeded_at', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await markSucceeded(5);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/succeeded_at = NOW\(\)/i);
    expect(params).toEqual([5]);
  });

  it('rescheduleWithBackoff increments attempts and pushes next_attempt_at forward', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await rescheduleWithBackoff(5, 'boom', 30);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/attempts = attempts \+ 1/i);
    expect(sql).toMatch(/next_attempt_at = NOW\(\) \+/i);
    expect(sql).toMatch(/last_error = \$2/i);
    expect(params[0]).toBe(5);
    expect(params[1]).toBe('boom');
    expect(params[2]).toBe(30);
  });

  it('markRateLimited increments rate_limited_attempts separately from attempts', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await markRateLimited(5, 60);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/rate_limited_attempts = rate_limited_attempts \+ 1/i);
    expect(sql).not.toMatch(/attempts = attempts \+ 1/i);
    expect(sql).toMatch(/next_attempt_at = NOW\(\) \+/i);
  });

  it('park sets parked_at and last_error', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await park(5, 'giving up');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/parked_at = NOW\(\)/i);
    expect(sql).toMatch(/last_error = \$2/i);
    expect(params).toEqual([5, 'giving up']);
  });
});
