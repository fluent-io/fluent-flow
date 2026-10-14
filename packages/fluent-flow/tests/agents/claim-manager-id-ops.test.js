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

const captured = { updateSet: [], insertValues: [], selectRan: false };

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();

  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockImplementation((args) => {
    captured.updateSet.push(args);
    return { where };
  });
  const update = vi.fn().mockReturnValue({ set });

  const insertReturning = vi.fn().mockResolvedValue([]);
  const onConflict = vi.fn().mockReturnValue({ returning: insertReturning });
  const values = vi.fn().mockImplementation((args) => {
    captured.insertValues.push(args);
    return { onConflictDoNothing: onConflict };
  });
  const insert = vi.fn().mockReturnValue({ values });

  const selectLimit = vi.fn().mockResolvedValue([]);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockImplementation(() => {
    captured.selectRan = true;
    return { from: selectFrom };
  });

  return {
    db: { update, insert, select, set, where, returning, values, onConflict },
    schema: real.schema,
  };
});

import { db } from '@fluent-flow/db';
import { setSessionStatus } from '../../src/agents/session-manager.js';
import { extendClaim, getClaimById, completeClaimById, redispatchClaim, MAX_RETRY_ATTEMPTS } from '../../src/agents/claim-manager.js';

const CLAIM = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'review_fix',
  payload: { branch: 'fix/x' },
  head_sha: 'abc123',
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.updateSet = [];
  captured.insertValues = [];
  captured.selectRan = false;
});

describe('extendClaim', () => {
  it('sets a future expires_at and returns the row id when extended', async () => {
    db.returning.mockResolvedValueOnce([{ id: 7 }]);
    const before = Date.now();
    const res = await extendClaim({ orgId: 'o1', claimId: 7, sessionId: 3, ttlMs: 900_000 });

    expect(res).toEqual({ id: 7 });
    const setArg = captured.updateSet[0];
    expect(setArg.expiresAt).toBeInstanceOf(Date);
    expect(setArg.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 890_000);
  });

  it('returns null when no matching claimed row (missing, pending, or other session)', async () => {
    db.returning.mockResolvedValueOnce([]);
    const res = await extendClaim({ orgId: 'o1', claimId: 404, sessionId: 3 });
    expect(res).toBeNull();
  });
});

describe('getClaimById', () => {
  it('selects a single row and normalizes to snake_case', async () => {
    const { selectFrom } = db;
    // reach the limit() resolution used by getClaimById
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 7, orgId: 'o1', repo: 'o/r', prNumber: 5, attempt: 2, claimType: 'review_fix', payload: {}, headSha: null }]),
        }),
      }),
    });
    const res = await getClaimById('o1', 7);
    expect(res).toMatchObject({ id: 7, org_id: 'o1', repo: 'o/r', pr_number: 5, claim_type: 'review_fix' });
  });

  it('returns null when absent', async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
    expect(await getClaimById('o1', 404)).toBeNull();
  });
});

describe('completeClaimById', () => {
  it('uses the provided transaction executor for claim completion and session release', async () => {
    const txReturning = vi.fn().mockResolvedValue([{
      id: 7,
      orgId: 'o1',
      repo: 'o/r',
      prNumber: 5,
      attempt: 2,
      sessionId: 3,
      claimType: 'verify',
      status: 'completed',
      payload: { phase: 'red' },
      claimedAt: null,
      completedAt: new Date('2026-01-01T00:00:00Z'),
      archivedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      checkRunExternalId: 321,
      headSha: 'abc123',
      sessionAgentId: 'agent-1',
    }]);
    const txWhere = vi.fn().mockReturnValue({ returning: txReturning });
    const txSet = vi.fn().mockReturnValue({ where: txWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: txSet });
    const tx = { update: txUpdate };

    const res = await completeClaimById('o1', 7, tx);

    expect(txUpdate).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(setSessionStatus).toHaveBeenCalledWith('o1', 'agent-1', 3, 'online', tx);
    expect(res).toMatchObject({ id: 7, claim_type: 'verify', check_run_external_id: 321 });
  });
});

describe('redispatchClaim', () => {
  it('inserts a follow-on claim at attempt + 1 preserving type, payload, and head_sha', async () => {
    const newClaim = { id: 99, attempt: 3 };
    db.onConflict.mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([newClaim]) });

    const res = await redispatchClaim(CLAIM);

    expect(res).toEqual(newClaim);
    expect(captured.insertValues).toHaveLength(1);
    expect(captured.insertValues[0]).toMatchObject({
      orgId: 'o1',
      repo: 'o/r',
      prNumber: 5,
      attempt: 3,
      claimType: 'review_fix',
      payload: { branch: 'fix/x' },
      headSha: 'abc123',
      status: 'pending',
      sessionId: null,
    });
  });

  it('never re-dispatches past MAX_RETRY_ATTEMPTS', async () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(10);
    const res = await redispatchClaim({ ...CLAIM, attempt: 10 });
    expect(res).toBeNull();
    expect(captured.insertValues).toHaveLength(0);
  });
});
