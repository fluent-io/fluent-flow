import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/agents/session-manager.js', () => ({
  setSessionStatus: vi.fn().mockResolvedValue(undefined),
}));

const captured = { selectRan: [], insertValues: [] };

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();

  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  const insertReturning = vi.fn().mockResolvedValue([]);
  const onConflict = vi.fn().mockReturnValue({ returning: insertReturning });
  const values = vi.fn().mockImplementation((args) => {
    captured.insertValues.push(args);
    return { onConflictDoNothing: onConflict };
  });
  const insert = vi.fn().mockReturnValue({ values });

  const limit = vi.fn().mockImplementation(function() {
    // Return the mock data that was set for this specific call
    return this._mockResolvedValue || [];
  });
  const selectWhere = vi.fn().mockReturnValue({ limit });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockImplementation(() => {
    captured.selectRan.push(true);
    return { from: selectFrom };
  });

  return {
    db: { update, insert, select, set, where, returning, values, onConflict },
    schema: real.schema,
  };
});

import { db } from '@fluent-flow/db';
import {
  nextChainAttempt,
  countCompletedFixIterations,
  createClaimWithRetry,
} from '../../src/agents/claim-manager.js';

const PG_UNIQUE_VIOLATION = '23505';

beforeEach(() => {
  vi.clearAllMocks();
  captured.selectRan = [];
  captured.insertValues = [];
});

describe('nextChainAttempt', () => {
  it('returns 1 when no claims exist for the PR', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await nextChainAttempt('org1', 'owner/repo', 123);
    expect(result).toBe(1);
  });

  it('returns max attempt + 1 across all claim types', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ max: 3 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await nextChainAttempt('org1', 'owner/repo', 123);
    expect(result).toBe(4);
  });

  it('handles NULL prNumber correctly', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ max: 2 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await nextChainAttempt('org1', 'owner/repo', null);
    expect(result).toBe(3);
  });

  it('returns 1 when max is NULL (no claims)', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ max: null }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await nextChainAttempt('org1', 'owner/repo', 123);
    expect(result).toBe(1);
  });
});

describe('countCompletedFixIterations', () => {
  it('counts completed review_fix claims for a PR', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ count: 3 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await countCompletedFixIterations('org1', 'owner/repo', 123);
    expect(result).toBe(3);
  });

  it('returns 0 when no completed fix iterations exist', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ count: 0 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await countCompletedFixIterations('org1', 'owner/repo', 123);
    expect(result).toBe(0);
  });

  it('returns 0 when query returns empty result', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await countCompletedFixIterations('org1', 'owner/repo', 123);
    expect(result).toBe(0);
  });
});

describe('createClaimWithRetry', () => {
  const mockCreateClaim = vi.fn();

  beforeEach(() => {
    mockCreateClaim.mockReset();
  });

  it('succeeds on first attempt', async () => {
    mockCreateClaim.mockResolvedValueOnce({ id: 1, attempt: 1 });
    const mockLimit = vi.fn().mockResolvedValue([{ max: 0 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    const result = await createClaimWithRetry(
      {
        orgId: 'org1',
        repo: 'owner/repo',
        prNumber: 123,
        payload: { test: 'data' },
      },
      mockCreateClaim,
    );

    expect(result).toEqual({ id: 1, attempt: 1 });
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    expect(mockCreateClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org1',
        repo: 'owner/repo',
        prNumber: 123,
        attempt: 1,
        payload: { test: 'data' },
      }),
    );
  });

  it('retries once on 23505 and succeeds', async () => {
    let attemptCount = 0;
    mockCreateClaim.mockImplementation(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        const err = new Error('duplicate key');
        err.code = PG_UNIQUE_VIOLATION;
        throw err;
      }
      return { id: 2, attempt: 2 };
    });

    // First call returns attempt 1, second call returns attempt 2
    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
    ];
    let callIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimits[callIndex++] }),
      }),
    }));

    const result = await createClaimWithRetry(
      {
        orgId: 'org1',
        repo: 'owner/repo',
        prNumber: 123,
        payload: { test: 'data' },
      },
      mockCreateClaim,
    );

    expect(result).toEqual({ id: 2, attempt: 2 });
    expect(mockCreateClaim).toHaveBeenCalledTimes(2);
  });

  it('throws after 5 failed retry attempts', async () => {
    const err = new Error('duplicate key');
    err.code = PG_UNIQUE_VIOLATION;
    mockCreateClaim.mockRejectedValue(err);

    // Each retry should see incrementing max values
    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
      vi.fn().mockResolvedValue([{ max: 2 }]),
      vi.fn().mockResolvedValue([{ max: 3 }]),
      vi.fn().mockResolvedValue([{ max: 4 }]),
    ];
    let callIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimits[callIndex++] }),
      }),
    }));

    await expect(
      createClaimWithRetry(
        {
          orgId: 'org1',
          repo: 'owner/repo',
          prNumber: 123,
          payload: { test: 'data' },
        },
        mockCreateClaim,
      ),
    ).rejects.toThrow('Failed to create claim after multiple unique constraint violations');

    expect(mockCreateClaim).toHaveBeenCalledTimes(5);
  });

  it('throws immediately on non-23505 errors', async () => {
    const err = new Error('database connection failed');
    err.code = '08006';
    mockCreateClaim.mockRejectedValue(err);

    const mockLimit = vi.fn().mockResolvedValue([{ max: 0 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    await expect(
      createClaimWithRetry(
        {
          orgId: 'org1',
          repo: 'owner/repo',
          prNumber: 123,
          payload: { test: 'data' },
        },
        mockCreateClaim,
      ),
    ).rejects.toThrow('database connection failed');

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
  });

  it('re-increments attempt on each retry', async () => {
    const attemptNumbers = [];
    mockCreateClaim.mockImplementation(async (opts) => {
      attemptNumbers.push(opts.attempt);
      const err = new Error('duplicate key');
      err.code = PG_UNIQUE_VIOLATION;
      throw err;
    });

    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
      vi.fn().mockResolvedValue([{ max: 2 }]),
      vi.fn().mockResolvedValue([{ max: 3 }]),
      vi.fn().mockResolvedValue([{ max: 4 }]),
    ];
    let callIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimits[callIndex++] }),
      }),
    }));

    await expect(
      createClaimWithRetry(
        {
          orgId: 'org1',
          repo: 'owner/repo',
          prNumber: 123,
          payload: { test: 'data' },
        },
        mockCreateClaim,
      ),
    ).rejects.toThrow();

    expect(attemptNumbers).toEqual([1, 2, 3, 4, 5]);
  });
});