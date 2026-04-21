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

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({
    reviewer: { enabled: true, max_retries: 3 },
  }),
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
vi.mock('../../src/notifications/dispatcher.js', () => ({
  notifyReviewFailure: vi.fn(),
  formatRichMessage: vi.fn().mockReturnValue('msg'),
}));

const mockCreateClaim = vi.fn();
vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaim: (...a) => mockCreateClaim(...a),
  completeClaim: vi.fn(),
  getActiveClaim: vi.fn(),
}));

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimDispatched: vi.fn().mockResolvedValue(undefined),
  onClaimResolved: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({}),
}));

import { dispatchReview } from '../../src/engine/review-manager.js';

beforeEach(() => {
  mockCreateClaim.mockReset();
  mockCreateClaim.mockResolvedValue({ id: 1, installation_id: 42 });
  mockDispatchWorkflow.mockReset();
  mockGetReviews.mockClear();
  mockDismissReview.mockClear();
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
});
