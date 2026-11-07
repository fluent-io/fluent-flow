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
  order: [],
  drizzleRows: [],
  client: { query: vi.fn(), release: vi.fn() },
  pool: { connect: vi.fn() },
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();
  const returning = vi.fn(async () => state.drizzleRows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const limit = vi.fn(async () => [{ agentId: 'a1' }]);
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { update, set, where, returning, select, from },
    schema: real.schema,
    getPool: vi.fn(() => state.pool),
    cancelOpenClaimInteractions: vi.fn(),
  };
});

import { cancelOpenClaimInteractions } from '@fluent-flow/db';
import { setSessionStatus } from '../../src/agents/session-manager.js';
import { expireClaims } from '../../src/agents/claim-manager.js';

const EXPIRED_ROWS = [
  {
    id: 7,
    org_id: 'o1',
    repo: 'o/r',
    pr_number: 5,
    attempt: 2,
    session_id: 3,
    claim_type: 'review_fix',
    status: 'expired',
    payload: {},
    session_agent_id: 'a1',
  },
  {
    id: 8,
    org_id: 'o1',
    repo: 'o/r',
    pr_number: 6,
    attempt: 1,
    session_id: 4,
    claim_type: 'review',
    status: 'expired',
    payload: {},
    session_agent_id: 'a1',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  state.order.length = 0;
  state.drizzleRows = EXPIRED_ROWS.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    repo: row.repo,
    prNumber: row.pr_number,
    attempt: row.attempt,
    sessionId: row.session_id,
    claimType: row.claim_type,
    status: row.status,
    payload: row.payload,
  }));
  state.pool.connect.mockResolvedValue(state.client);
  state.client.query.mockImplementation(async (text) => {
    const sql = String(text);
    state.order.push(sql.trim().split(/\s+/)[0].toUpperCase());
    if (/UPDATE\s+agent_claims/i.test(sql)) return { rows: EXPIRED_ROWS };
    return { rows: [] };
  });
  cancelOpenClaimInteractions.mockImplementation(async ({ claimId }) => {
    state.order.push(`CANCEL_${claimId}`);
  });
  setSessionStatus.mockImplementation(async (_orgId, _agentId, sessionId) => {
    state.order.push(`FREE_${sessionId}`);
  });
});

describe('expireClaims atomic interaction cancellation', () => {
  it('updates expiry without archiving, cancels every claim interaction before commit, then frees sessions', async () => {
    const claims = await expireClaims();

    const updateCall = state.client.query.mock.calls.find(([text]) => /UPDATE\s+agent_claims/i.test(String(text)));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toMatch(/status\s*=\s*'expired'/i);
    expect(updateCall[0]).toMatch(/completed_at\s*=\s*NOW\(\)/i);
    expect(updateCall[0]).not.toMatch(/archived_at/i);
    expect(cancelOpenClaimInteractions).toHaveBeenNthCalledWith(1, { orgId: 'o1', claimId: 7 }, state.client);
    expect(cancelOpenClaimInteractions).toHaveBeenNthCalledWith(2, { orgId: 'o1', claimId: 8 }, state.client);
    expect(state.order).toEqual(['BEGIN', 'UPDATE', 'CANCEL_7', 'CANCEL_8', 'COMMIT', 'FREE_3', 'FREE_4']);
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 7, status: 'expired' }),
      expect.objectContaining({ id: 8, status: 'expired' }),
    ]));
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back all expirations and frees no session when cancellation fails', async () => {
    cancelOpenClaimInteractions.mockRejectedValueOnce(new Error('interaction cancellation failed'));

    await expect(expireClaims()).rejects.toThrow('interaction cancellation failed');

    expect(state.order).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK']);
    expect(setSessionStatus).not.toHaveBeenCalled();
    expect(state.client.release).toHaveBeenCalledOnce();
  });
});
