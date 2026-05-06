import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---
vi.mock('../../../src/logger.js', async () => {
  const { createMockLogger } = await import('../../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const mockResolveAgentId = vi.fn().mockReturnValue('agent-1');
const mockDispatch = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: (...a) => mockResolveAgentId(...a),
  dispatch: (...a) => mockDispatch(...a),
}));

const mockGetPRsForCommit = vi.fn().mockResolvedValue([]);
const mockGetCheckRunsForCommit = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/providers/github/rest.js', () => ({
  getPRsForCommit: (...a) => mockGetPRsForCommit(...a),
  getCheckRunsForCommit: (...a) => mockGetCheckRunsForCommit(...a),
  getCheckRunAnnotations: vi.fn().mockResolvedValue([]),
}));

const mockDispatchReview = vi.fn().mockResolvedValue(undefined);
const mockClaimDispatch = vi.fn().mockResolvedValue(null);
vi.mock('../../../src/engine/review-manager.js', () => ({
  dispatchReview: (...a) => mockDispatchReview(...a),
  claimDispatch: (...a) => mockClaimDispatch(...a),
}));

vi.mock('../../../src/engine/test-manager.js', () => ({
  handleTestFailure: vi.fn().mockResolvedValue(undefined),
  handleTestSuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/engine/pause-manager.js', () => ({
  getActivePause: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/engine/test-parser.js', () => ({
  parseCheckAnnotations: vi.fn().mockReturnValue([]),
}));

const mockCreateClaim = vi.fn().mockResolvedValue(null);
vi.mock('../../../src/agents/claim-manager.js', () => ({
  createClaim: (...a) => mockCreateClaim(...a),
}));

vi.mock('../../../src/config/loader.js', () => ({
  resolveOrgId: vi.fn().mockResolvedValue('org-1'),
}));

// Mock db for the review_fix claim lookup, MAX(attempt) query, and test_verify
// dedup query. Drizzle chains: db.select().from().where().limit() — each step
// returns a query builder; the builder is thenable so `await` resolves to rows.
let _resolveChain;
function createChain(result = []) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve) => Promise.resolve(_resolveChain.shift() ?? result).then(resolve),
  };
  return chain;
}

let _dbChain;

vi.mock('@fluent-flow/db', () => ({
  get db() { return _dbChain; },
  schema: {
    agentClaims: {
      id: 'id',
      orgId: 'org_id',
      repo: 'repo',
      prNumber: 'pr_number',
      claimType: 'claim_type',
      status: 'status',
      headSha: 'head_sha',
      attempt: 'attempt',
    },
  },
}));

vi.mock('../../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

import { handleCheckRun } from '../../../src/providers/github/check-run-handler.js';

/**
 * Helper: build a minimal check_run.completed payload.
 */
function makePayload(overrides = {}) {
  return {
    action: 'completed',
    installation: { id: 1 },
    check_run: {
      id: 10,
      name: 'test',
      head_sha: 'abc123',
      conclusion: 'success',
      status: 'completed',
      completed_at: '2026-01-01T00:00:00Z',
      app: { slug: 'github-actions' },
      ...overrides.check_run,
    },
    ...overrides,
  };
}

const defaultConfig = {
  reviewer: { enabled: true, max_retries: 3 },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resolveChain = [];
  _dbChain = createChain([]);
});

describe('handleCheckRun — test_verify path', () => {
  it('creates test_verify claim when completed review_fix exists for the PR', async () => {
    // Setup: claimDispatch returns a retry record so we enter the dispatch path
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // DB query chain:
    // 1) Check for completed review_fix → found
    // 2) Compute next test_verify attempt via MAX(attempt) → max=0, so next=1
    // 3) Check for existing test_verify with same head_sha → none found
    _resolveChain = [[{ id: 1 }], [{ max: 0 }], []];

    // Setup: createClaim succeeds
    mockCreateClaim.mockResolvedValueOnce({
      id: 99,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      attempt: 1,
      claim_type: 'test_verify',
    });

    // Setup: PR exists
    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should create a test_verify claim (NOT dispatch review)
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    expect(mockCreateClaim.mock.calls[0][0].claimType).toBe('test_verify');
    expect(mockCreateClaim.mock.calls[0][0].attempt).toBe(1);
    expect(mockCreateClaim.mock.calls[0][0].headSha).toBe('abc123');
    // Should NOT dispatch a review — early return
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('skips test_verify and falls through to dispatchReview when review_fix claim does not exist', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // DB query: check for completed review_fix → not found
    _resolveChain = [[]];

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should NOT create a test_verify claim
    expect(mockCreateClaim).not.toHaveBeenCalled();
    // Should dispatch a regular review instead
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  // Regression: under the old unique constraint (org_id, repo, pr_number, attempt),
  // a test_verify claim at attempt 1 would collide with an existing review_fix claim
  // at attempt 1 because the constraint did not include claim_type. The per-type
  // constraint (org_id, repo, pr_number, claim_type, attempt) allows both to coexist
  // at attempt 1 without conflict.
  it('does not collide with review_fix at same attempt under per-type constraint', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // review_fix exists (query 1), MAX(attempt)=0 for test_verify (query 2),
    // no existing test_verify for this head_sha (query 3)
    _resolveChain = [[{ id: 1 }], [{ max: 0 }], []];

    // createClaim succeeds — no conflict because unique constraint includes claim_type
    mockCreateClaim.mockResolvedValueOnce({
      id: 100,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      attempt: 1,
      claim_type: 'test_verify',
    });

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    expect(mockCreateClaim.mock.calls[0][0].claimType).toBe('test_verify');
    expect(mockCreateClaim.mock.calls[0][0].attempt).toBe(1);
  });

  // Test for review item #6: createClaim returning null (duplicate) should fall
  // through to dispatchReview rather than early-returning.
  it('falls through to dispatchReview when createClaim returns null for test_verify', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // review_fix exists (query 1), MAX(attempt)=0 (query 2),
    // no existing test_verify for this head_sha (query 3)
    _resolveChain = [[{ id: 1 }], [{ max: 0 }], []];

    // createClaim returns null — claim already exists at this attempt
    mockCreateClaim.mockResolvedValueOnce(null);

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should have attempted to create a test_verify claim
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    expect(mockCreateClaim.mock.calls[0][0].claimType).toBe('test_verify');

    // Should fall through to dispatchReview (NOT early-return)
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview.mock.calls[0][0].prNumber).toBe(42);
  });

  it('skips test_verify when existing test_verify claim found for same head_sha (idempotency)', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // review_fix exists (query 1), MAX(attempt)=1 (query 2),
    // existing test_verify for this head_sha found (query 3)
    _resolveChain = [[{ id: 1 }], [{ max: 1 }], [{ id: 50 }]];

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should NOT try to create a new test_verify claim
    expect(mockCreateClaim).not.toHaveBeenCalled();
    // Should fall through to dispatchReview
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });
});
