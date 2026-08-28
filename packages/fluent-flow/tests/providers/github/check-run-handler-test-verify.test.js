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
const mockGetCheckRunAnnotations = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/providers/github/rest.js', () => ({
  getPRsForCommit: (...a) => mockGetPRsForCommit(...a),
  getCheckRunsForCommit: (...a) => mockGetCheckRunsForCommit(...a),
  getCheckRunAnnotations: (...a) => mockGetCheckRunAnnotations(...a),
}));

const mockDispatchReview = vi.fn().mockResolvedValue(undefined);
const mockClaimDispatch = vi.fn().mockResolvedValue(null);
vi.mock('../../../src/engine/review-manager.js', () => ({
  dispatchReview: (...a) => mockDispatchReview(...a),
  claimDispatch: (...a) => mockClaimDispatch(...a),
}));

const mockOnClaimDispatched = vi.fn().mockResolvedValue(null);
vi.mock('../../../src/engine/check-run.js', () => ({
  onClaimDispatched: (...a) => mockOnClaimDispatched(...a),
}));

const mockGetProvider = vi.fn().mockReturnValue({ provider: 'github' });
vi.mock('../../../src/providers/index.js', () => ({
  getProvider: (...a) => mockGetProvider(...a),
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

vi.mock('../../../src/config/loader.js', () => ({
  resolveOrgId: vi.fn().mockResolvedValue('org-1'),
}));

const mockCreateClaimWithRetry = vi.fn().mockResolvedValue(null);
const mockNextChainAttempt = vi.fn().mockResolvedValue(1);
const mockGetClaimById = vi.fn().mockResolvedValue(null);
const mockGetVerificationResultByClaim = vi.fn().mockResolvedValue(null);

let mockReviewFixRows = [];
const mockDbExecute = vi.fn(async () => ({ rows: mockReviewFixRows }));

vi.mock('@fluent-flow/db', () => ({
  db: {
    execute: (...a) => mockDbExecute(...a),
  },
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
      completedAt: 'completed_at',
    },
  },
  getVerificationResultByClaim: (...a) => mockGetVerificationResultByClaim(...a),
}));

vi.mock('../../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

// Mock claim-manager functions
vi.mock('../../../src/agents/claim-manager.js', () => ({
  createClaimWithRetry: (...a) => mockCreateClaimWithRetry(...a),
  nextChainAttempt: (...a) => mockNextChainAttempt(...a),
  getClaimById: (...a) => mockGetClaimById(...a),
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

const VALID_TEST_HASHES = [
  { path: 'test/verify/req-1.test.js', sha256: 'a'.repeat(64) },
  { path: 'test/verify/req-2.test.js', sha256: 'b'.repeat(64) },
];

const VALID_MATRIX = {
  requirements: [{ id: 'REQ-1', status: 'PASS' }],
  suite: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 },
  schema_version: 1,
};

const VALID_MANIFEST = {
  pr_number: 42,
  requirements: [{
    requirement: {
      id: 'REQ-1',
      form: 'when',
      text: 'When invalid login is submitted, the request fails.',
      source_finding_id: 'F1',
    },
    tests: ['test/verify/req-1.test.js'],
    dependency_files: [],
    framework: 'vitest',
  }],
};

const VALID_ARTIFACT_SHA = '1234567890abcdef1234567890abcdef12345678';

beforeEach(() => {
  vi.clearAllMocks();
  mockReviewFixRows = [];
  mockDbExecute.mockImplementation(async () => ({ rows: mockReviewFixRows }));
  mockOnClaimDispatched.mockResolvedValue(null);
  mockGetProvider.mockReturnValue({ provider: 'github' });
});

describe('handleCheckRun — green claim path (replaces test_verify)', () => {
  it('creates green claim with inlined red record + config snapshot when review_fix has source_claim_id linkage', async () => {
    // Setup: claimDispatch returns a retry record so we enter the dispatch path
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // Raw SQL lookup: review_fix with source_claim_id
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    // Red claim from getClaimById
    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: {
        phase: 'red',
        verification: {
          framework: 'vitest',
          test_file_patterns: ['**/*.test.js'],
        },
        findings: [{ id: 'F-1', issue: 'Broken auth' }],
      },
    });

    // Red verification result from getVerificationResultByClaim
    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      orgId: 'org-1',
      claimId: 5,
      repo: 'test-org/test-repo',
      prNumber: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: VALID_MATRIX,
      manifest: VALID_MANIFEST,
      testHashes: VALID_TEST_HASHES,
      artifactSha: VALID_ARTIFACT_SHA,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    mockNextChainAttempt.mockResolvedValueOnce(2);

    // createClaimWithRetry succeeds
    mockCreateClaimWithRetry.mockResolvedValueOnce({
      id: 99,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      attempt: 2,
      claim_type: 'verify',
      head_sha: 'abc123',
      payload: {
        phase: 'green',
        green_sha: 'abc123',
        red_claim_id: 5,
        red_record: {
          phase: 'red',
          framework: 'vitest',
          outcome: 'PASS',
          matrix: VALID_MATRIX,
          manifest: VALID_MANIFEST,
          test_hashes: VALID_TEST_HASHES,
          artifact_sha: VALID_ARTIFACT_SHA,
        },
        verification: {
          framework: 'vitest',
          test_file_patterns: ['**/*.test.js'],
        },
        findings: [{ id: 'F-1', issue: 'Broken auth' }],
      },
    });

    // Setup: PR exists
    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should create a green claim (NOT dispatch review)
    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    const claimInput = mockCreateClaimWithRetry.mock.calls[0][0];
    expect(claimInput).toMatchObject({
      claimType: 'verify',
      headSha: 'abc123',
      payload: {
        phase: 'green',
        green_sha: 'abc123',
        red_claim_id: 5,
        branch: 'feature/x',
        red_record: {
          phase: 'red',
          framework: 'vitest',
          outcome: 'PASS',
          matrix: VALID_MATRIX,
          manifest: VALID_MANIFEST,
          test_hashes: VALID_TEST_HASHES,
          artifact_sha: VALID_ARTIFACT_SHA,
        },
        verification: {
          framework: 'vitest',
          test_file_patterns: ['**/*.test.js'],
        },
        findings: [{ id: 'F-1', issue: 'Broken auth' }],
      },
    });
    expect(mockGetProvider).toHaveBeenCalledWith({ provider: 'github', installation_id: 1 });
    expect(mockOnClaimDispatched).toHaveBeenCalledWith(
      { provider: 'github' },
      expect.objectContaining({
        id: 99,
        claim_type: 'verify',
        head_sha: 'abc123',
        installation_id: 1,
      }),
    );
    // Should NOT dispatch a review — early return
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('returns early on duplicate green claim (23505 conflict) without fall-through to review dispatch', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // DB query: review_fix with source_claim_id
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { phase: 'red', verification: { framework: 'vitest' } },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      orgId: 'org-1',
      claimId: 5,
      repo: 'test-org/test-repo',
      prNumber: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: VALID_MATRIX,
      manifest: VALID_MANIFEST,
      testHashes: VALID_TEST_HASHES,
      artifactSha: VALID_ARTIFACT_SHA,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    mockNextChainAttempt.mockResolvedValueOnce(2);

    // createClaimWithRetry returns null (duplicate)
    mockCreateClaimWithRetry.mockResolvedValueOnce(null);

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should have attempted to create a green claim
    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    // Early return: no review dispatch even when createClaimWithRetry returns null (duplicate)
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('falls through to review dispatch when review_fix lacks source_claim_id linkage', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    // DB query: review_fix exists but no source_claim_id
    mockReviewFixRows = [{ id: 1, source_claim_id: null }];

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    // Should NOT create green claim
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    // Should fall through to review dispatch
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red claim not found via source_claim_id', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce(null);

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red result has no test_hashes (nothing to verify)', async () => {
    mockClaimDispatch.mockResolvedValueOnce({ retry_count: 0, last_issues: [] });

    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { phase: 'red', verification: { framework: 'vitest' } },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      orgId: 'org-1',
      claimId: 5,
      repo: 'test-org/test-repo',
      prNumber: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: VALID_MATRIX,
      testHashes: null,
      artifactSha: VALID_ARTIFACT_SHA,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    mockGetPRsForCommit.mockResolvedValueOnce([{
      number: 42,
      state: 'open',
      body: '',
      head: { ref: 'feature/x' },
    }]);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });
});