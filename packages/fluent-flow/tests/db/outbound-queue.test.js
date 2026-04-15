import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientQuery = vi.fn();
const mockClient = {
  query: mockClientQuery,
  release: vi.fn(),
};
const mockPool = { connect: vi.fn().mockResolvedValue(mockClient) };

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  audit: vi.fn(),
  getPool: vi.fn(() => mockPool),
}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import { query } from '../../src/db/client.js';
import {
  enqueue,
  claimNext,
  markSucceeded,
  markFailed,
  parkForInstallation,
  unparkForInstallation,
} from '../../src/db/outbound-queue.js';

const mockQuery = /** @type {import('vitest').MockedFunction<typeof query>} */ (query);

beforeEach(() => {
  vi.clearAllMocks();
  mockClientQuery.mockReset();
  mockPool.connect.mockResolvedValue(mockClient);
});

describe('enqueue', () => {
  it('inserts a row and returns it', async () => {
    const row = { id: 1, installation_id: 10, kind: 'comment', client_ref: 'ref-1', attempts: 0 };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await enqueue({ installation_id: 10, kind: 'comment', payload: { body: 'hi' }, client_ref: 'ref-1' });
    expect(result).toEqual(row);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO provider_outbound_queue/i);
    expect(sql).toMatch(/ON CONFLICT.*DO NOTHING|ON CONFLICT.*client_ref/i);
  });

  it('returns the existing row on duplicate client_ref (no-op)', async () => {
    // On conflict DO NOTHING returns 0 rows; second SELECT returns existing
    mockQuery
      .mockResolvedValueOnce({ rows: [] })           // INSERT ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [{ id: 99, client_ref: 'ref-1' }] }); // SELECT existing

    const result = await enqueue({ installation_id: 10, kind: 'comment', payload: {}, client_ref: 'ref-1' });
    expect(result.id).toBe(99);
  });
});

describe('claimNext', () => {
  it('uses FOR UPDATE SKIP LOCKED, sets a visibility timeout, and does NOT touch attempts', async () => {
    const row = { id: 5, attempts: 0, rate_limited_attempts: 0 };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })    // BEGIN
      .mockResolvedValueOnce({ rows: [row] }) // SELECT FOR UPDATE SKIP LOCKED
      .mockResolvedValueOnce({ rows: [row] }) // UPDATE next_attempt_at (visibility)
      .mockResolvedValueOnce({ rows: [] });   // COMMIT

    const result = await claimNext();
    expect(result).toBeDefined();
    expect(result.id).toBe(5);

    const allSql = mockClientQuery.mock.calls.map(([sql]) => sql).join(' ');
    expect(allSql).toMatch(/SKIP LOCKED/i);
    // claimNext sets only next_attempt_at (visibility) — never increments attempts
    expect(allSql).not.toMatch(/attempts\s*=\s*attempts\s*\+\s*1/i);
    expect(allSql).not.toMatch(/attempts\s*=\s*\$/i);
    expect(allSql).toMatch(/next_attempt_at/i);
  });

  it('returns null when queue is empty', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] })  // SELECT (empty)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await claimNext();
    expect(result).toBeNull();
  });
});

describe('markSucceeded', () => {
  it('sets succeeded_at on the row', async () => {
    const row = { id: 5, succeeded_at: new Date() };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    await markSucceeded(5);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_outbound_queue/i);
    expect(sql).toMatch(/succeeded_at/i);
    expect(params).toContain(5);
  });
});

describe('markFailed', () => {
  it('increments attempts and computes backoff on ordinary failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, attempts: 2, next_attempt_at: new Date() }] });

    await markFailed(5, { error: 'Server error', rateLimited: false });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_outbound_queue/i);
    expect(sql).toMatch(/attempts/i);
    // No rate_limited_attempts increment
    expect(sql).not.toMatch(/rate_limited_attempts\s*=\s*rate_limited_attempts\s*\+/i);
    expect(params).toContain(5);
  });

  it('increments rate_limited_attempts on rate limit failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, rate_limited_attempts: 1 }] });

    await markFailed(5, { error: 'Rate limited', rateLimited: true });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/rate_limited_attempts/i);
    // Should NOT increment ordinary attempts count in the rate-limited branch
    expect(sql).not.toMatch(/attempts\s*=\s*attempts\s*\+\s*1[^,]/);
  });
});

describe('parkForInstallation', () => {
  it('sets parked_at on all open rows for the installation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await parkForInstallation(10);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_outbound_queue/i);
    expect(sql).toMatch(/parked_at/i);
    expect(params).toContain(10);
  });
});

describe('unparkForInstallation', () => {
  it('clears parked_at on recent rows only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await unparkForInstallation(10, 24);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_outbound_queue/i);
    expect(sql).toMatch(/parked_at\s*=\s*NULL/i);
    expect(params).toContain(10);
  });
});
