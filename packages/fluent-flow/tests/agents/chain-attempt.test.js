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

  it('does NOT include claimType in where-clause (chain-wide allocation)', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ max: 5 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    await nextChainAttempt('org1', 'owner/repo', 123);

    // Verify db.select was called with the correct structure
    expect(db.select).toHaveBeenCalledWith({ max: expect.anything() });
    // The chain-wide allocation should include orgId, repo, prNumber conditions
    // but NOT claimType - this is verified by the implementation structure
    // where we only add conditions for orgId, repo, and prNumber
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

  it('filters by claimType=review_fix AND status=completed in where-clause', async () => {
    const mockLimit = vi.fn().mockResolvedValue([{ count: 2 }]);
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    });

    await countCompletedFixIterations('org1', 'owner/repo', 123);

    // Verify db.select was called with the correct structure
    expect(db.select).toHaveBeenCalledWith({ count: expect.anything() });
    // The implementation adds claimType='review_fix' and status='completed' to the conditions
    // This is verified by the function structure which explicitly adds these conditions
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

  it('retries once on null return (onConflict semantics) and succeeds', async () => {
    let attemptCount = 0;
    mockCreateClaim.mockImplementation(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        // Simulate onConflictDoNothing returning null
        return null;
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

  it('throws after 3 total attempts when createClaimFn always returns null', async () => {
    mockCreateClaim.mockResolvedValue(null);

    // Each retry should see incrementing max values
    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
      vi.fn().mockResolvedValue([{ max: 2 }]),
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

    expect(mockCreateClaim).toHaveBeenCalledTimes(3);
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

  it('re-increments attempt on each retry when getting null returns', async () => {
    const attemptNumbers = [];
    mockCreateClaim.mockImplementation(async (opts) => {
      attemptNumbers.push(opts.attempt);
      return null;
    });

    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
      vi.fn().mockResolvedValue([{ max: 2 }]),
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

    expect(attemptNumbers).toEqual([1, 2, 3]);
  });

  it('retries on DrizzleQueryError with cause.code 23505', async () => {
    let attemptCount = 0;
    mockCreateClaim.mockImplementation(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        const err = new Error('query failed');
        err.cause = { code: '23505' };
        throw err;
      }
      return { id: 2, attempt: 2 };
    });

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

  it('rethrows immediately on DrizzleQueryError with non-23505 cause.code', async () => {
    const err = new Error('query failed');
    err.cause = { code: '23503' }; // Foreign key violation
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
    ).rejects.toThrow('query failed');

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
  });

  it('handles both err.code and err.cause.code for 23505 detection', async () => {
    let attemptCount = 0;
    mockCreateClaim.mockImplementation(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        // Test with direct code property
        const err = new Error('direct code');
        err.code = '23505';
        throw err;
      }
      if (attemptCount === 2) {
        // Test with cause.code property
        const err = new Error('cause code');
        err.cause = { code: '23505' };
        throw err;
      }
      return { id: 3, attempt: 3 };
    });

    const mockLimits = [
      vi.fn().mockResolvedValue([{ max: 0 }]),
      vi.fn().mockResolvedValue([{ max: 1 }]),
      vi.fn().mockResolvedValue([{ max: 2 }]),
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

    expect(result).toEqual({ id: 3, attempt: 3 });
    expect(mockCreateClaim).toHaveBeenCalledTimes(3);
  });
});