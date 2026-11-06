import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listPipelines, getPipelineDetail } = await import('../../src/queries/pipelines');

describe('listPipelines', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns pipelines grouped by PR for given orgs (active filter default)', async () => {
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
    expect(mockQuery.mock.calls[0][0]).toContain('archived_at IS NULL');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('filters archived pipelines when filter=archived', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listPipelines(['fluent-io'], 'archived');
    expect(mockQuery.mock.calls[0][0]).toContain('archived_at IS NOT NULL');
  });

  it('shows all pipelines when filter=all', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listPipelines(['fluent-io'], 'all');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('archived_at IS NULL');
    expect(sql).not.toContain('archived_at IS NOT NULL');
  });

  it('returns pipelines with null pr_number (standalone claims)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          org_id: 'fluent-io',
          repo: 'fluent-io/fluent-flow',
          pr_number: null,
          latest_attempt: 1,
          last_activity: new Date(),
          stages: [
            { claim_type: 'spec', status: 'pending', created_at: new Date().toISOString(), claimed_at: null, completed_at: null },
          ],
        },
      ],
    });

    const result = await listPipelines(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].pr_number).toBeNull();
    expect(result[0].stages[0].claim_type).toBe('spec');
  });

  it('returns no pipelines for empty-org non-superadmin without querying', async () => {
    const result = await listPipelines([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns all pipelines for explicit superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listPipelines([], 'active', true);
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

  it('returns claims for a null-pr pipeline (standalone)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: null,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'pending',
          payload: { auto_chain: false }, claimed_at: null, completed_at: null,
          expires_at: null, created_at: new Date(), agent_id: 'ff-runner', session_meta: {},
        },
      ],
    });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/fluent-flow', null);
    expect(result).toHaveLength(1);
    expect(result[0].claim_type).toBe('spec');
    expect(result[0].pr_number).toBeNull();
  });

  it('returns no claims for empty-org non-superadmin without querying', async () => {
    const result = await getPipelineDetail([], 'fluent-io/fluent-flow', 28);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns claims across orgs for explicit superadmin', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, org_id: 'legacy-org', repo: 'legacy-org/legacy', pr_number: 28,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'completed',
          payload: {}, claimed_at: new Date(), completed_at: new Date(),
          expires_at: null, created_at: new Date(), agent_id: 'ff-runner', session_meta: {},
        },
      ],
    });

    const result = await getPipelineDetail([], 'legacy-org/legacy', 28, 'active', true);
    expect(result).toHaveLength(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['legacy-org/legacy', 28]);
  });

  it('returns empty array when pipeline not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/nonexistent', 999);
    expect(result).toEqual([]);
  });
});
