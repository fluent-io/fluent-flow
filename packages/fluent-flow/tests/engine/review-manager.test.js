import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

// review-manager only touches db.update/insert for reviewRetries — stub them
// to no-op so dispatchReview can run without a real connection.
vi.mock('@fluent-flow/db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ retryCount: 1 }],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  },
  schema: { reviewRetries: {} },
}));

const mockResolveConfig = vi.fn().mockResolvedValue({
  reviewer: { enabled: true, max_retries: 3 },
  installation_id: 99,
});
const mockInstallationCtxForRepo = vi.fn().mockResolvedValue({ installation_id: 99 });
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: (...a) => mockResolveConfig(...a),
  resolveOrgId: vi.fn().mockResolvedValue('self-hosted'),
  installationCtxForRepo: (...a) => mockInstallationCtxForRepo(...a),
}));

const mockDispatchWorkflow = vi.fn();
const mockGetReviews = vi.fn().mockResolvedValue([]);
const mockDismissReview = vi.fn();
vi.mock('../../src/providers/github/rest.js', () => ({
  dispatchWorkflow: (...a) => mockDispatchWorkflow(...a),
  addLabel: vi.fn(),
  getReviews: (...a) => mockGetReviews(...a),
  dismissReview: (...a) => mockDismissReview(...a),
}));
vi.mock('../../src/providers/github/graphql.js', () => ({
  enablePullRequestAutoMerge: vi.fn(),
  getPRNodeId: vi.fn(),
}));
vi.mock('../../src/engine/pause-manager.js', () => ({
  recordPause: vi.fn(),
  getActivePause: vi.fn().mockResolvedValue(null),
}));
const mockDispatch = vi.fn();
vi.mock('../../src/notifications/dispatcher.js', () => ({
  notifyReviewFailure: vi.fn(),
  formatRichMessage: vi.fn().mockReturnValue('msg'),
  dispatch: (...a) => mockDispatch(...a),
}));

const mockCreateClaim = vi.fn();
vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaim: (...a) => mockCreateClaim(...a),
  completeClaim: vi.fn(),
  getActiveClaim: vi.fn(),
}));

const mockOnClaimDispatched = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/engine/check-run.js', () => ({
  onClaimDispatched: (...a) => mockOnClaimDispatched(...a),
  onClaimResolved: vi.fn().mockResolvedValue(undefined),
}));
const mockGetProvider = vi.fn().mockReturnValue({});
vi.mock('../../src/providers/index.js', () => ({
  getProvider: (...a) => mockGetProvider(...a),
}));

import { dispatchReview, handleReviewResult } from '../../src/engine/review-manager.js';

beforeEach(() => {
  mockCreateClaim.mockReset();
  // Real toSnakeClaim does NOT include installation_id — align mock with actual shape.
  // installation_id must come from config.installation_id (the fallback path).
  mockCreateClaim.mockResolvedValue({ id: 1, claim_type: 'review' });
  mockDispatchWorkflow.mockReset();
  mockGetReviews.mockClear();
  mockDismissReview.mockClear();
  mockOnClaimDispatched.mockClear();
  mockGetProvider.mockClear();
  mockResolveConfig.mockResolvedValue({ reviewer: { enabled: true, max_retries: 3 } });
  mockDispatch.mockClear();
});

describe('dispatchReview (runner-claim based)', () => {
  it('creates a review claim — claimType=review, carries priorIssues + branch', async () => {
    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'feature/xyz',
      attempt: 1,
      priorIssues: [{ file: 'src/a.js', line: 3, issue: 'npe' }],
    });

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.claimType).toBe('review');
    expect(call.repo).toBe('fluent-io/fluent-flow');
    expect(call.prNumber).toBe(42);
    expect(call.attempt).toBe(1);
    expect(call.payload?.priorIssues).toEqual([{ file: 'src/a.js', line: 3, issue: 'npe' }]);
    expect(call.payload?.branch).toBe('feature/xyz');
  });

  it('does NOT call dispatchWorkflow (runner-claim path replaces it)', async () => {
    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('still dismisses stale Fluent Flow reviews before creating the new claim', async () => {
    mockGetReviews.mockResolvedValueOnce([
      { id: 99, state: 'CHANGES_REQUESTED', body: 'old review\n<!-- reviewer-result: {...} -->' },
    ]);

    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 2,
      priorIssues: [],
    });

    expect(mockDismissReview).toHaveBeenCalledWith('fluent-io', 'fluent-flow', 42, 99, 'Superseded by new review');
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
  });

  it('calls onClaimDispatched with installation_id from config when headSha is provided', async () => {
    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'feature/xyz',
      headSha: 'abc123',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockGetProvider).toHaveBeenCalledWith({ installation_id: 99 });
    expect(mockOnClaimDispatched).toHaveBeenCalledTimes(1);
    const [, claimArg] = mockOnClaimDispatched.mock.calls[0];
    expect(claimArg.head_sha).toBe('abc123');
    expect(claimArg.installation_id).toBe(99);
  });

  it('skips onClaimDispatched when headSha is not provided', async () => {
    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockOnClaimDispatched).not.toHaveBeenCalled();
  });

  it('skips onClaimDispatched when no installation_id is available', async () => {
    mockResolveConfig.mockResolvedValueOnce({ reviewer: { enabled: true, max_retries: 3 } });
    mockInstallationCtxForRepo.mockResolvedValueOnce(undefined);

    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      headSha: 'abc123',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockOnClaimDispatched).not.toHaveBeenCalled();
  });

  it('pushes pre-assigned claim to runner via long-poll dispatch', async () => {
    mockCreateClaim.mockResolvedValueOnce({ id: 1, claim_type: 'review', session_id: 42 });
    mockResolveConfig.mockResolvedValueOnce({ reviewer: { enabled: true, max_retries: 3 }, default_agent: 'cc-1' });

    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockDispatch).toHaveBeenCalledWith({
      agentId: 'cc-1',
      event: 'review',
      payload: expect.objectContaining({ session_id: 42, repo: 'fluent-io/fluent-flow', prNumber: 42 }),
    });
  });

  it('does not dispatch via long-poll when claim has no session_id', async () => {
    mockCreateClaim.mockResolvedValueOnce({ id: 1, claim_type: 'review' });
    mockResolveConfig.mockResolvedValueOnce({ reviewer: { enabled: true, max_retries: 3 }, default_agent: 'cc-1' });

    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch via long-poll when no agent is configured', async () => {
    mockCreateClaim.mockResolvedValueOnce({ id: 1, claim_type: 'review', session_id: 42 });
    mockResolveConfig.mockResolvedValueOnce({ reviewer: { enabled: true, max_retries: 3 } });

    await dispatchReview({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      ref: 'main',
      attempt: 1,
      priorIssues: [],
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rethrows createClaim errors so callers can respond appropriately', async () => {
    mockCreateClaim.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      dispatchReview({
        owner: 'fluent-io',
        repo: 'fluent-flow',
        prNumber: 42,
        ref: 'main',
        attempt: 1,
        priorIssues: [],
      })
    ).rejects.toThrow('DB connection lost');
  });
});

describe('handleReviewResult', () => {
  it('creates review_fix claim at attempt+1 on FAIL, preserving the original review claim', async () => {
    await handleReviewResult({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      issueNumber: 10,
      result: { status: 'FAIL', blocking: [{ file: 'a.ts', line: 1, issue: 'bug' }], advisory: [], attempt: 1 },
      reviewSha: 'abc123',
      agentId: 'cc-1',
      headBranch: 'main',
    });

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.attempt).toBe(2); // attempt + 1, not 1
    expect(call.claimType).toBe('review_fix');
    expect(call.repo).toBe('fluent-io/fluent-flow');
    expect(call.prNumber).toBe(42);
  });

  it('does not create a claim on PASS', async () => {
    const result = await handleReviewResult({
      owner: 'fluent-io',
      repo: 'fluent-flow',
      prNumber: 42,
      issueNumber: 10,
      result: { status: 'PASS', blocking: [], advisory: [], attempt: 1 },
      reviewSha: 'abc123',
      headBranch: 'main',
    });

    expect(result.action).toBe('pass');
    expect(mockCreateClaim).not.toHaveBeenCalled();
  });
});
