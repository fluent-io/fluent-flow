import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const mockResolveAgentId = vi.fn().mockReturnValue('agent-1');
const mockDispatch = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: (...a) => mockResolveAgentId(...a),
  dispatch: (...a) => mockDispatch(...a),
}));

const mockGetPRsForCommit = vi.fn().mockResolvedValue([]);
const mockGetCheckRunsForCommit = vi.fn().mockResolvedValue([]);
const mockGetCheckRunAnnotations = vi.fn().mockResolvedValue([]);
vi.mock('../../src/providers/github/rest.js', () => ({
  getPRsForCommit: (...a) => mockGetPRsForCommit(...a),
  getCheckRunsForCommit: (...a) => mockGetCheckRunsForCommit(...a),
  getCheckRunAnnotations: (...a) => mockGetCheckRunAnnotations(...a),
}));

const mockDispatchReview = vi.fn().mockResolvedValue(undefined);
const mockClaimDispatch = vi.fn().mockResolvedValue(null);
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: (...a) => mockDispatchReview(...a),
  claimDispatch: (...a) => mockClaimDispatch(...a),
}));

vi.mock('../../src/engine/test-manager.js', () => ({
  handleTestFailure: vi.fn().mockResolvedValue(undefined),
  handleTestSuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/engine/pause-manager.js', () => ({
  getActivePause: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/engine/test-parser.js', () => ({
  parseCheckAnnotations: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/config/loader.js', () => ({
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
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
  },
  schema: {
    agentClaims: {},
    verificationResults: {},
  },
  getVerificationResultByClaim: (...a) => mockGetVerificationResultByClaim(...a),
}));

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

// Mock claim-manager functions
vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaimWithRetry: (...a) => mockCreateClaimWithRetry(...a),
  nextChainAttempt: (...a) => mockNextChainAttempt(...a),
  getClaimById: (...a) => mockGetClaimById(...a),
}));

import { handleCheckRun, isFluentFlowCheckRun } from '../../src/providers/github/check-run-handler.js';

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
  reviewer: { enabled: true, max_retries: 3, trigger_check: 'test' },
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
  // Reset all mocks to their default state
  mockGetPRsForCommit.mockResolvedValue([{
    number: 42,
    state: 'open',
    body: '',
    head: { ref: 'feature/x' },
  }]);
  mockClaimDispatch.mockResolvedValue({ retry_count: 0, last_issues: [] });
  mockGetClaimById.mockResolvedValue(null);
  mockGetVerificationResultByClaim.mockResolvedValue(null);
  mockCreateClaimWithRetry.mockResolvedValue(null);
  mockNextChainAttempt.mockResolvedValue(1);
});

describe('handleCheckRun — green claim creation', () => {
  it('creates green claim with inlined red record + config snapshot when review_fix has source_claim_id linkage', async () => {
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

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
      },
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
      },
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    const claimInput = mockCreateClaimWithRetry.mock.calls[0][0];
    expect(claimInput).toMatchObject({
      claimType: 'verify',
      headSha: 'abc123',
      payload: {
        phase: 'green',
        green_sha: 'abc123',
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
      },
    });
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('returns early when the green-per-sha index reports an existing green claim', async () => {
    mockDbExecute
      .mockResolvedValueOnce({ rows: [{ id: 1, source_claim_id: 5 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });

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

    mockCreateClaimWithRetry.mockImplementationOnce(async (opts, createFn) => createFn({ ...opts, attempt: 2 }));

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    expect(mockDbExecute).toHaveBeenCalledTimes(3);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('falls through to review dispatch when review_fix lacks source_claim_id linkage', async () => {
    mockReviewFixRows = [{ id: 1, source_claim_id: null }];

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockGetClaimById).not.toHaveBeenCalled();
    expect(mockGetVerificationResultByClaim).not.toHaveBeenCalled();
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red claim not found via source_claim_id', async () => {
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce(null);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockGetVerificationResultByClaim).not.toHaveBeenCalled();
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red result has no test_hashes (nothing to verify)', async () => {
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
      testHashes: null,
      artifactSha: VALID_ARTIFACT_SHA,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when source claim is not the matching red verify claim', async () => {
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { phase: 'green', verification: { framework: 'vitest' } },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      orgId: 'org-1',
      claimId: 5,
      repo: 'test-org/test-repo',
      prNumber: 42,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: VALID_MATRIX,
      testHashes: VALID_TEST_HASHES,
      artifactSha: VALID_ARTIFACT_SHA,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red claim has no verification snapshot', async () => {
    mockReviewFixRows = [{ id: 1, source_claim_id: 5 }];

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { phase: 'red' },
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockGetVerificationResultByClaim).not.toHaveBeenCalled();
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });
});

describe('isFluentFlowCheckRun', () => {
  it('matches check runs with name starting with "Fluent Flow"', () => {
    expect(isFluentFlowCheckRun({ name: 'Fluent Flow — verify', app: { slug: 'other' } })).toBe(true);
    expect(isFluentFlowCheckRun({ name: 'Fluent Flow test', app: { slug: 'github-actions' } })).toBe(true);
    expect(isFluentFlowCheckRun({ name: 'fluent flow check', app: { slug: 'other' } })).toBe(true);
  });

  it('matches check runs by Fluent Flow app slug without relying on the name prefix', () => {
    expect(isFluentFlowCheckRun({ name: 'verify', app: { slug: 'fluent-flow' } })).toBe(true);
    expect(isFluentFlowCheckRun({ name: 'verify', app: { slug: 'fluent-flow-ci[bot]' } })).toBe(true);
  });

  it('does not match check runs without Fluent Flow name prefix', () => {
    expect(isFluentFlowCheckRun({ name: 'test', app: { slug: 'github-actions' } })).toBe(false);
    expect(isFluentFlowCheckRun({ name: 'review', app: { slug: 'github-actions' } })).toBe(false);
    expect(isFluentFlowCheckRun({ name: 'lint', app: { slug: 'github-actions' } })).toBe(false);
  });

  it('handles null/undefined checkRun safely', () => {
    expect(isFluentFlowCheckRun(null)).toBe(false);
    expect(isFluentFlowCheckRun(undefined)).toBe(false);
    expect(isFluentFlowCheckRun({})).toBe(false);
  });
});

describe('handleCheckRun — CI self-exclusion on both paths', () => {
  it('short-circuits on success when isFluentFlowCheckRun matches', async () => {
    const payload = makePayload({
      check_run: {
        name: 'Fluent Flow — verify',
        conclusion: 'success',
      },
    });

    await handleCheckRun('test-org', 'test-repo', payload, defaultConfig);

    expect(mockClaimDispatch).not.toHaveBeenCalled();
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('short-circuits on success when the app slug identifies Fluent Flow', async () => {
    const payload = makePayload({
      check_run: {
        name: 'test',
        app: { slug: 'fluent-flow' },
        conclusion: 'success',
      },
    });

    await handleCheckRun('test-org', 'test-repo', payload, defaultConfig);

    expect(mockGetPRsForCommit).not.toHaveBeenCalled();
    expect(mockClaimDispatch).not.toHaveBeenCalled();
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('short-circuits on failure when isFluentFlowCheckRun matches', async () => {
    const payload = makePayload({
      check_run: {
        name: 'Fluent Flow — verify',
        conclusion: 'failure',
      },
    });

    await handleCheckRun('test-org', 'test-repo', payload, defaultConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('short-circuits on failure when the app slug identifies Fluent Flow', async () => {
    const payload = makePayload({
      check_run: {
        name: 'test',
        app: { slug: 'fluent-flow' },
        conclusion: 'failure',
      },
    });

    await handleCheckRun('test-org', 'test-repo', payload, defaultConfig);

    expect(mockGetPRsForCommit).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('still excludes github-actions review-named checks on failure path (existing behavior)', async () => {
    const payload = makePayload({
      check_run: {
        name: 'review',
        app: { slug: 'github-actions' },
        conclusion: 'failure',
      },
    });

    await handleCheckRun('test-org', 'test-repo', payload, defaultConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});