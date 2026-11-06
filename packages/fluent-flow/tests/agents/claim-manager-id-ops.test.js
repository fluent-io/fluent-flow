import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/agents/session-manager.js', () => ({
  setSessionStatus: vi.fn().mockResolvedValue(undefined),
}));

const state = vi.hoisted(() => ({
  updateSet: [],
  insertValues: [],
  order: [],
  client: { query: vi.fn(), release: vi.fn() },
  pool: { connect: vi.fn() },
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockImplementation((args) => {
    state.updateSet.push(args);
    return { where };
  });
  const update = vi.fn().mockReturnValue({ set });
  const insertReturning = vi.fn().mockResolvedValue([]);
  const onConflict = vi.fn().mockReturnValue({ returning: insertReturning });
  const values = vi.fn().mockImplementation((args) => {
    state.insertValues.push(args);
    return { onConflictDoNothing: onConflict };
  });
  const insert = vi.fn().mockReturnValue({ values });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    }),
  });
  return {
    db: { update, insert, select, set, where, returning, values, onConflict },
    schema: real.schema,
    getPool: vi.fn(() => state.pool),
    cancelOpenClaimInteractions: vi.fn(),
  };
});

import { cancelOpenClaimInteractions, db } from '@fluent-flow/db';
import { setSessionStatus } from '../../src/agents/session-manager.js';
import {
  assertClaimOwner,
  withClaimOwner,
  cancelClaimById,
  completeClaimById,
  extendClaim,
  failClaimById,
  getClaimById,
  MAX_RETRY_ATTEMPTS,
  redispatchClaim,
} from '../../src/agents/claim-manager.js';

const CLAIM = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  session_id: 3,
  claim_type: 'review_fix',
  status: 'claimed',
  payload: { branch: 'fix/x' },
  head_sha: 'abc123',
};

const RAW_CLAIM = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  session_id: 3,
  claim_type: 'review_fix',
  status: 'completed',
  payload: { branch: 'fix/x' },
  head_sha: 'abc123',
  session_agent_id: 'a1',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.updateSet.length = 0;
  state.insertValues.length = 0;
  state.order.length = 0;
  state.pool.connect.mockResolvedValue(state.client);
  state.client.query.mockImplementation(async (text) => {
    state.order.push(String(text).trim().split(/\s+/)[0].toUpperCase());
    if (/UPDATE\s+agent_claims/i.test(String(text))) return { rows: [RAW_CLAIM] };
    return { rows: [] };
  });
  cancelOpenClaimInteractions.mockImplementation(async () => {
    state.order.push('CANCEL_INTERACTIONS');
  });
  setSessionStatus.mockImplementation(async () => {
    state.order.push('FREE_SESSION');
  });
});

describe('assertClaimOwner', () => {
  it('returns the active claim only when org, agent, session, and claimed status all match', async () => {
    state.client.query.mockResolvedValueOnce({ rows: [{ ...RAW_CLAIM, status: 'claimed' }] });

    const claim = await assertClaimOwner({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 });

    expect(claim).toMatchObject({ id: 7, org_id: 'o1', session_id: 3, status: 'claimed' });
    const [sql, params] = state.client.query.mock.calls[0];
    expect(sql).toMatch(/agent_claims/i);
    expect(sql).toMatch(/agent_sessions/i);
    expect(sql).toMatch(/status\s*=\s*'claimed'/i);
    expect(params).toEqual(expect.arrayContaining(['o1', 'a1', 3, 7]));
  });

  it('distinguishes a foreign claim from a current-org stale ownership conflict without leaking detail', async () => {
    state.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(assertClaimOwner({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 70 }))
      .rejects.toMatchObject({ statusCode: 404 });

    state.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await expect(assertClaimOwner({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('withClaimOwner', () => {
  it('holds one transaction and owner row lock across the interaction mutation', async () => {
    state.client.query.mockImplementation(async (text, params) => {
      const sql = String(text);
      if (/^BEGIN$/i.test(sql)) {
        state.order.push('BEGIN');
        return { rows: [] };
      }
      if (/SELECT/i.test(sql) && /agent_claims/i.test(sql)) {
        state.order.push('LOCK_OWNER');
        expect(sql).toMatch(/FOR SHARE/i);
        expect(sql).toMatch(/agent_sessions/i);
        expect(params).toEqual(expect.arrayContaining(['o1', 'a1', 3, 7]));
        return { rows: [{ ...RAW_CLAIM, status: 'claimed' }] };
      }
      state.order.push(sql.trim().toUpperCase());
      return { rows: [] };
    });

    const result = await withClaimOwner(
      { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 },
      async (client) => {
        expect(client).toBe(state.client);
        state.order.push('MUTATION');
        return 'stored';
      },
    );

    expect(result).toBe('stored');
    expect(state.order).toEqual(['BEGIN', 'LOCK_OWNER', 'MUTATION', 'COMMIT']);
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the owner lock when the interaction mutation fails', async () => {
    state.client.query.mockImplementation(async (text) => {
      const sql = String(text);
      if (/SELECT/i.test(sql) && /agent_claims/i.test(sql)) {
        state.order.push('LOCK_OWNER');
        return { rows: [{ ...RAW_CLAIM, status: 'claimed' }] };
      }
      state.order.push(sql.trim().toUpperCase());
      return { rows: [] };
    });

    await expect(withClaimOwner(
      { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 },
      async (client) => {
        expect(client).toBe(state.client);
        state.order.push('MUTATION');
        throw new Error('interaction write failed');
      },
    )).rejects.toThrow('interaction write failed');

    expect(state.order).toEqual(['BEGIN', 'LOCK_OWNER', 'MUTATION', 'ROLLBACK']);
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it.each([
    [404, []],
    [409, [{ id: 7 }]],
  ])('rolls back and preserves generic %i ownership classification', async (statusCode, fallbackRows) => {
    let selectCount = 0;
    const mutation = vi.fn();
    state.client.query.mockImplementation(async (text) => {
      const sql = String(text);
      if (/SELECT/i.test(sql) && /agent_claims/i.test(sql)) {
        selectCount += 1;
        state.order.push(selectCount === 1 ? 'LOCK_OWNER' : 'CLASSIFY_OWNER');
        return { rows: selectCount === 1 ? [] : fallbackRows };
      }
      state.order.push(sql.trim().toUpperCase());
      return { rows: [] };
    });

    await expect(withClaimOwner(
      { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 },
      mutation,
    )).rejects.toMatchObject({ statusCode });

    expect(mutation).not.toHaveBeenCalled();
    expect(state.order).toEqual(['BEGIN', 'LOCK_OWNER', 'CLASSIFY_OWNER', 'ROLLBACK']);
    expect(state.client.release).toHaveBeenCalledOnce();
  });
});

describe.each([
  ['completed', completeClaimById],
  ['failed', failClaimById],
  ['cancelled', cancelClaimById],
])('%s claim finalization transaction', (status, finalize) => {
  it('predicates the terminal update on claimed session ownership, cancels interactions, commits, then frees the session', async () => {
    state.client.query.mockImplementation(async (text, params) => {
      const sql = String(text);
      state.order.push(sql.trim().split(/\s+/)[0].toUpperCase());
      if (/UPDATE\s+agent_claims/i.test(sql)) {
        expect(sql).toMatch(/session_id/i);
        expect(sql).toMatch(/status\s*=\s*'claimed'/i);
        expect(params).toEqual(expect.arrayContaining(['o1', 7, 3, status]));
        return { rows: [{ ...RAW_CLAIM, status }] };
      }
      return { rows: [] };
    });

    const claim = await finalize('o1', 7, 3);

    expect(claim).toMatchObject({ id: 7, status });
    expect(cancelOpenClaimInteractions).toHaveBeenCalledWith({ orgId: 'o1', claimId: 7 }, state.client);
    expect(state.order).toEqual(['BEGIN', 'UPDATE', 'CANCEL_INTERACTIONS', 'COMMIT', 'FREE_SESSION']);
    expect(setSessionStatus).toHaveBeenCalledWith('o1', 'a1', 3, 'online');
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back the status update and does not free the session when interaction cancellation fails', async () => {
    cancelOpenClaimInteractions.mockRejectedValueOnce(new Error('cancellation failed'));

    await expect(finalize('o1', 7, 3)).rejects.toThrow('cancellation failed');

    expect(state.order).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK']);
    expect(setSessionStatus).not.toHaveBeenCalled();
    expect(state.client.release).toHaveBeenCalledOnce();
  });
});

describe('existing claim id operations', () => {
  it('extends only a matching claimed session', async () => {
    db.returning.mockResolvedValueOnce([{ id: 7 }]);
    const before = Date.now();
    await expect(extendClaim({ orgId: 'o1', claimId: 7, sessionId: 3, ttlMs: 900_000 })).resolves.toEqual({ id: 7 });
    expect(state.updateSet[0].expiresAt.getTime()).toBeGreaterThanOrEqual(before + 890_000);
  });

  it('gets an org-scoped claim by id in snake case', async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 7, orgId: 'o1', repo: 'o/r', prNumber: 5, attempt: 2, sessionId: 3, claimType: 'review_fix', status: 'claimed', payload: {}, headSha: null }]),
        }),
      }),
    });
    await expect(getClaimById('o1', 7)).resolves.toMatchObject({ id: 7, org_id: 'o1', session_id: 3, claim_type: 'review_fix' });
  });

  it('redispatches at attempt plus one and preserves type, payload, and head SHA', async () => {
    db.onConflict.mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([{ id: 99, attempt: 3 }]) });
    await redispatchClaim(CLAIM);
    expect(state.insertValues[0]).toMatchObject({
      orgId: 'o1',
      attempt: 3,
      claimType: 'review_fix',
      payload: { branch: 'fix/x' },
      headSha: 'abc123',
      status: 'pending',
      sessionId: null,
    });
  });

  it('does not redispatch past the retry cap', async () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(10);
    await expect(redispatchClaim({ ...CLAIM, attempt: 10 })).resolves.toBeNull();
    expect(state.insertValues).toHaveLength(0);
  });
});
