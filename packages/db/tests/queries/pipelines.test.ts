import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listPipelines, getPipelineDetail } = await import('../../src/queries/pipelines');

describe('listPipelines', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns pipelines grouped by PR for given orgs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          org_id: 'fluent-io',
          repo: 'fluent-io/fluent-flow',
          pr_number: 28,
          latest_attempt: 1,
          last_activity: new Date(),
          stages: [
            { claim_type: 'spec', status: 'completed', created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), completed_at: new Date().toISOString() },
            { claim_type: 'build', status: 'claimed', created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), completed_at: null },
          ],
        },
      ],
    });

    const result = await listPipelines(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('fluent-io/fluent-flow');
    expect(result[0].pr_number).toBe(28);
    expect(result[0].stages).toHaveLength(2);
    expect(result[0].stages[0].claim_type).toBe('spec');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('returns all pipelines for superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listPipelines([]);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });
});

describe('getPipelineDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns claims for a specific PR pipeline', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'completed',
          payload: {}, claimed_at: new Date(), completed_at: new Date(),
          expires_at: null, created_at: new Date(), agent_id: 'ff-runner', session_meta: {},
        },
      ],
    });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/fluent-flow', 28);
    expect(result).toHaveLength(1);
    expect(result[0].claim_type).toBe('spec');
    expect(result[0].agent_id).toBe('ff-runner');
  });

  it('returns empty array when pipeline not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/nonexistent', 999);
    expect(result).toEqual([]);
  });
});
