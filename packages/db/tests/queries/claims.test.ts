import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getAgentClaims, dismissClaim, dismissStaleClaims, dismissPipelineClaims } = await import('../../src/queries/claims');

describe('getAgentClaims', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns claims for an agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1, org_id: 'fluent-io', repo: 'fluent-io/app', pr_number: 1,
        attempt: 1, session_id: 1, claim_type: 'review_fix', status: 'completed',
        payload: {}, claimed_at: new Date(), completed_at: new Date(),
        archived_at: null, expires_at: null, created_at: new Date(),
      }],
    });

    const result = await getAgentClaims('fluent-io', 'ff-runner');
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('completed');
  });
});

describe('dismissClaim', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('sets status to cancelled with archived_at and completed_at', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await dismissClaim(42);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'cancelled'");
    expect(sql).toContain('archived_at = NOW()');
    expect(sql).toContain('completed_at = NOW()');
    expect(sql).toContain('WHERE id = $1');
    expect(mockQuery.mock.calls[0][1]).toEqual([42]);
  });
});

describe('dismissStaleClaims', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('dismisses stale claims for given orgs with default 24h threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });
    const count = await dismissStaleClaims(['fluent-io']);
    expect(count).toBe(3);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status IN ('pending', 'claimed')");
    expect(sql).toContain("org_id = ANY($2)");
    // Default 86400000ms
    expect(mockQuery.mock.calls[0][1][0]).toBe('86400000');
  });

  it('dismisses all stale claims for superadmin', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });
    const count = await dismissStaleClaims([]);
    expect(count).toBe(5);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('org_id = ANY');
  });

  it('accepts custom olderThanMs threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await dismissStaleClaims(['fluent-io'], 3600_000);
    expect(mockQuery.mock.calls[0][1][0]).toBe('3600000');
  });
});

describe('dismissPipelineClaims', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('dismisses active claims for a specific repo + PR', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    const count = await dismissPipelineClaims(['fluent-io'], 'fluent-io/app', 42);
    expect(count).toBe(2);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status IN ('pending', 'claimed')");
    expect(sql).toContain("repo = $2");
    expect(sql).toContain("pr_number = $4");
  });

  it('dismisses claims for null pr_number pipeline', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const count = await dismissPipelineClaims(['fluent-io'], 'fluent-io/app', null);
    expect(count).toBe(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('pr_number IS NULL');
  });

  it('dismisses all claims in repo when prNumber not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });
    const count = await dismissPipelineClaims(['fluent-io'], 'fluent-io/app');
    expect(count).toBe(3);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('pr_number');
  });

  it('works for superadmin without org filter', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 4 });
    const count = await dismissPipelineClaims([], 'fluent-io/app', 42);
    expect(count).toBe(4);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('org_id = ANY');
  });
});
