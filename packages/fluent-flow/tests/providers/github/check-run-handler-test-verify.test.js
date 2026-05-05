import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.js', async () => {
  const { createMockLogger } = await import('../../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../../src/db/client.js', () => ({ audit: vi.fn() }));

const mockResolveAgentId = vi.fn().mockReturnValue(null);
const mockDispatch = vi.fn();
vi.mock('../../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: (...a) => mockResolveAgentId(...a),
  dispatch: (...a) => mockDispatch(...a),
}));

const mockGetPRsForCommit = vi.fn();
vi.mock('../../../src/providers/github/rest.js', () => ({
  getPRsForCommit: (...a) => mockGetPRsForCommit(...a),
  getCheckRunsForCommit: vi.fn(),
  getCheckRunAnnotations: vi.fn(),
}));

const mockDispatchReview = vi.fn();
const mockClaimDispatch = vi.fn();
vi.mock('../../../src/engine/review-manager.js', () => ({
  dispatchReview: (...a) => mockDispatchReview(...a),
  claimDispatch: (...a) => mockClaimDispatch(...a),
}));

vi.mock('../../../src/engine/test-manager.js', () => ({
  handleTestFailure: vi.fn(),
  handleTestSuccess: vi.fn(),
}));
vi.mock('../../../src/engine/pause-manager.js', () => ({
  getActivePause: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/engine/test-parser.js', () => ({
  parseCheckAnnotations: vi.fn().mockReturnValue([]),
}));

const mockResolveOrgId = vi.fn().mockResolvedValue('self-hosted');
vi.mock('../../../src/config/loader.js', () => ({
  resolveOrgId: (...a) => mockResolveOrgId(...a),
}));

const mockCreateClaim = vi.fn();
vi.mock('../../../src/agents/claim-manager.js', () => ({
  createClaim: (...a) => mockCreateClaim(...a),
}));

/**
 * Two separate `db.select(...)` calls happen on the test_verify path:
 *   1. existence probe for a completed review_fix claim
 *   2. MAX(attempt) for prior test_verify claims on this PR
 *
 * We script `mockSelectResults` as a queue so each `select().from().where().limit()`
 * chain pops one canned response in order.
 */
const mockSelectResults = [];
function makeChain() {
  // Both probes terminate with either `.limit(1)` or by being awaited directly,
  // so make both return a thenable that resolves to the next canned row set.
  const result = mockSelectResults.shift() ?? [];
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit, then: (resolve) => resolve(result) });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}
vi.mock('@fluent-flow/db', () => ({
  db: { select: () => makeChain() },
  schema: { agentClaims: { /* unused — drizzle expressions are opaque under mocks */ } },
}));

const { handleCheckRun } = await import('../../../src/providers/github/check-run-handler.js');

const config = {
  reviewer: { enabled: true, max_retries: 3, trigger_check: 'test' },
};

const successCheckRunPayload = {
  action: 'completed',
  check_run: {
    id: 99,
    name: 'test (20)',
    conclusion: 'success',
    status: 'completed',
    head_sha: 'abc123',
    completed_at: '2026-05-05T00:00:00Z',
    app: { slug: 'github-actions' },
  },
  installation: { id: 555 },
};

beforeEach(() => {
  mockSelectResults.length = 0;
  mockCreateClaim.mockReset();
  mockDispatchReview.mockReset();
  mockClaimDispatch.mockReset();
  mockGetPRsForCommit.mockReset();
  mockResolveOrgId.mockClear().mockResolvedValue('self-hosted');

  mockGetPRsForCommit.mockResolvedValue([
    { number: 7, state: 'open', body: '', head: { ref: 'feature/x' }, title: 'Test PR' },
  ]);
  mockClaimDispatch.mockResolvedValue({ retry_count: 0, last_issues: [] });
});

describe('handleCheckRunSuccess — test_verify attempt computation', () => {
  it('uses attempt=1 when no prior test_verify claim exists for the PR', async () => {
    // 1st select: review_fix exists
    mockSelectResults.push([{ one: 1 }]);
    // 2nd select: MAX(attempt) for test_verify — none yet
    mockSelectResults.push([{ max: 0 }]);
    mockCreateClaim.mockResolvedValue({ id: 100 });

    await handleCheckRun('fluent-io', 'fluent-flow', successCheckRunPayload, config);

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.claimType).toBe('test_verify');
    expect(call.attempt).toBe(1);
    // test_verify path was taken — must early-return before review dispatch.
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('uses attempt=N+1 on subsequent review_fix → test_verify cycles (regression)', async () => {
    // 1st select: review_fix exists (could be a later cycle)
    mockSelectResults.push([{ one: 1 }]);
    // 2nd select: MAX(attempt) = 3 from prior test_verify rows
    mockSelectResults.push([{ max: 3 }]);
    mockCreateClaim.mockResolvedValue({ id: 200 });

    await handleCheckRun('fluent-io', 'fluent-flow', successCheckRunPayload, config);

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.claimType).toBe('test_verify');
    // The bug was hardcoding `attempt: 1` here, which collided with the
    // existing attempt=3 row and silently no-op'd via ON CONFLICT, falling
    // through to a regular review dispatch instead of running test_verify.
    expect(call.attempt).toBe(4);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('falls through to dispatchReview when no completed review_fix claim exists', async () => {
    // 1st select: no review_fix completed
    mockSelectResults.push([]);
    // 2nd select would not run, but stub anyway
    mockSelectResults.push([{ max: 0 }]);

    await handleCheckRun('fluent-io', 'fluent-flow', successCheckRunPayload, config);

    expect(mockCreateClaim).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });
});
