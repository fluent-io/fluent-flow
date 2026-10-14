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

  it('returns all pipelines for superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listPipelines([]);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });
});

describe('getPipelineDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns every claim attempt in order with verification results when present', async () => {
    const redCreatedAt = new Date('2026-08-27T10:00:00.000Z');
    const greenCreatedAt = new Date('2026-08-27T10:05:00.000Z');
    const verificationResult = {
      id: 7,
      org_id: 'fluent-io',
      claim_id: 2,
      repo: 'fluent-io/fluent-flow',
      pr_number: 28,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: { total: 2, passed: 2 },
      manifest: { requirements: [{ requirement: { id: 'REQ-1' }, tests: ['test/verify/req-1.test.js'] }] },
      test_hashes: { 'packages/db/tests/queries/pipelines.test.ts': 'abc123' },
      artifact_sha: 'artifact-sha',
      red_base_sha: 'red-base-sha',
      green_sha: 'green-sha',
      created_at: '2026-08-27T10:06:00.000Z',
    };
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'completed',
          payload: {}, claimed_at: redCreatedAt, completed_at: redCreatedAt,
          expires_at: null, created_at: redCreatedAt, agent_id: 'ff-runner', session_meta: {},
          verification_result: null,
        },
        {
          id: 2, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28,
          attempt: 2, session_id: 13, claim_type: 'verify', status: 'completed',
          payload: { phase: 'green' }, claimed_at: greenCreatedAt, completed_at: greenCreatedAt,
          expires_at: null, created_at: greenCreatedAt, agent_id: 'ff-runner', session_meta: {},
          verification_result: verificationResult,
        },
      ],
    });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/fluent-flow', 28);
    const sql = mockQuery.mock.calls[0][0] as string;

    expect(result).toHaveLength(2);
    expect(result.map((claim) => claim.attempt)).toEqual([1, 2]);
    expect(result[0].verification_result).toBeNull();
    expect(result[1].claim_type).toBe('verify');
    expect(result[1].agent_id).toBe('ff-runner');
    expect(result[1].verification_result).toEqual(verificationResult);
    expect(sql).toContain('LEFT JOIN verification_results vr ON vr.claim_id = c.id');
    expect(sql).not.toContain('MAX(c2.attempt)');
    expect(sql).toContain('ORDER BY c.attempt ASC, c.created_at ASC');
  });

  it('returns claims for a null-pr pipeline (standalone)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: null,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'pending',
          payload: { auto_chain: false }, claimed_at: null, completed_at: null,
          expires_at: null, created_at: new Date(), agent_id: 'ff-runner', session_meta: {},
          verification_result: null,
        },
      ],
    });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/fluent-flow', null);
    expect(result).toHaveLength(1);
    expect(result[0].claim_type).toBe('spec');
    expect(result[0].pr_number).toBeNull();
    expect(result[0].verification_result).toBeNull();
  });

  it('returns empty array when pipeline not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/nonexistent', 999);
    expect(result).toEqual([]);
  });
});
