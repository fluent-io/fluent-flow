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

// Mock db
let mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();

vi.mock('@fluent-flow/db', () => ({
  get db() { return { select: mockDbSelect, insert: mockDbInsert, update: mockDbUpdate }; },
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
      payload: 'payload',
    },
  },
  sql: vi.fn((fn) => fn),
}));

vi.mock('../../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

// Mock claim-manager functions
const mockCreateClaimWithRetry = vi.fn().mockResolvedValue(null);
const mockNextChainAttempt = vi.fn().mockResolvedValue(1);
const mockGetClaimById = vi.fn().mockResolvedValue(null);
const mockGetVerificationResultByClaim = vi.fn().mockResolvedValue(null);

vi.mock('../../../src/agents/claim-manager.js', () => ({
  createClaimWithRetry: (...a) => mockCreateClaimWithRetry(...a),
  nextChainAttempt: (...a) => mockNextChainAttempt(...a),
  getClaimById: (...a) => mockGetClaimById(...a),
  getVerificationResultByClaim: (...a) => mockGetVerificationResultByClaim(...a),
}));

import { handleCheckRun, isFluentFlowCheckRun } from '../../../src/providers/github/check-run-handler.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  mockDbSelect = vi.fn();
  mockGetPRsForCommit.mockResolvedValue([{
    number: 42,
    state: 'open',
    body: '',
    head: { ref: 'feature/x' },
  }]);
  mockClaimDispatch.mockResolvedValue({ retry_count: 0, last_issues: [] });
});

describe('handleCheckRun — green claim creation', () => {
  it('creates green claim with inlined red record + config snapshot when review_fix has source_claim_id linkage', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: 1,
        orgId: 'org-1',
        repo: 'test-org/test-repo',
        prNumber: 42,
        claimType: 'review_fix',
        status: 'completed',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        payload: { source_claim_id: 5 },
      }]),
    };
    
    const mockOrderBy = {
      desc: vi.fn().mockReturnValue(mockQuery),
    };
    
    mockQuery.orderBy = vi.fn().mockReturnValue(mockOrderBy);
    mockDbSelect.mockReturnValue(mockQuery);

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: {
        verification: {
          framework: 'vitest',
          test_file_patterns: ['**/*.test.js'],
        },
      },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      org_id: 'org-1',
      claim_id: 5,
      repo: 'test-org/test-repo',
      pr_number: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'passed',
      matrix: { requirements: { node: '>=20' } },
      test_hashes: { 'test.js': 'hash1', 'test2.js': 'hash2' },
      artifact_sha: 'artifact-sha-123',
      created_at: new Date('2026-01-01T00:00:00Z'),
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
          outcome: 'passed',
          matrix: { requirements: { node: '>=20' } },
          test_hashes: { 'test.js': 'hash1', 'test2.js': 'hash2' },
          artifact_sha: 'artifact-sha-123',
        },
        verification: {
          framework: 'vitest',
          test_file_patterns: ['**/*.test.js'],
        },
      },
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('returns early on duplicate green claim (23505 conflict) without fall-through to review dispatch', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: 1,
        orgId: 'org-1',
        repo: 'test-org/test-repo',
        prNumber: 42,
        claimType: 'review_fix',
        status: 'completed',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        payload: { source_claim_id: 5 },
      }]),
    };
    
    const mockOrderBy = {
      desc: vi.fn().mockReturnValue(mockQuery),
    };
    
    mockQuery.orderBy = vi.fn().mockReturnValue(mockOrderBy);
    mockDbSelect.mockReturnValue(mockQuery);

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { verification: { framework: 'vitest' } },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      org_id: 'org-1',
      claim_id: 5,
      repo: 'test-org/test-repo',
      pr_number: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'passed',
      matrix: { requirements: {} },
      test_hashes: {},
      artifact_sha: 'artifact-sha-123',
      created_at: new Date('2026-01-01T00:00:00Z'),
    });

    mockNextChainAttempt.mockResolvedValueOnce(2);

    mockCreateClaimWithRetry.mockResolvedValueOnce(null);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockCreateClaimWithRetry).toHaveBeenCalledTimes(1);
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('falls through to review dispatch when review_fix lacks source_claim_id linkage', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: 1,
        orgId: 'org-1',
        repo: 'test-org/test-repo',
        prNumber: 42,
        claimType: 'review_fix',
        status: 'completed',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        payload: {},
      }]),
    };
    
    const mockOrderBy = {
      desc: vi.fn().mockReturnValue(mockQuery),
    };
    
    mockQuery.orderBy = vi.fn().mockReturnValue(mockOrderBy);
    mockDbSelect.mockReturnValue(mockQuery);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockGetClaimById).not.toHaveBeenCalled();
    expect(mockGetVerificationResultByClaim).not.toHaveBeenCalled();
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red claim not found via source_claim_id', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: 1,
        orgId: 'org-1',
        repo: 'test-org/test-repo',
        prNumber: 42,
        claimType: 'review_fix',
        status: 'completed',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        payload: { source_claim_id: 5 },
      }]),
    };
    
    const mockOrderBy = {
      desc: vi.fn().mockReturnValue(mockQuery),
    };
    
    mockQuery.orderBy = vi.fn().mockReturnValue(mockOrderBy);
    mockDbSelect.mockReturnValue(mockQuery);

    mockGetClaimById.mockResolvedValueOnce(null);

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

    expect(mockGetVerificationResultByClaim).not.toHaveBeenCalled();
    expect(mockCreateClaimWithRetry).not.toHaveBeenCalled();
    expect(mockDispatchReview).toHaveBeenCalledTimes(1);
  });

  it('falls through to review dispatch when red result has no test_hashes (nothing to verify)', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: 1,
        orgId: 'org-1',
        repo: 'test-org/test-repo',
        prNumber: 42,
        claimType: 'review_fix',
        status: 'completed',
        completedAt: new Date('2026-01-01T00:00:00Z'),
        payload: { source_claim_id: 5 },
      }]),
    };
    
    const mockOrderBy = {
      desc: vi.fn().mockReturnValue(mockQuery),
    };
    
    mockQuery.orderBy = vi.fn().mockReturnValue(mockOrderBy);
    mockDbSelect.mockReturnValue(mockQuery);

    mockGetClaimById.mockResolvedValueOnce({
      id: 5,
      org_id: 'org-1',
      repo: 'test-org/test-repo',
      pr_number: 42,
      claim_type: 'verify',
      status: 'completed',
      payload: { verification: { framework: 'vitest' } },
    });

    mockGetVerificationResultByClaim.mockResolvedValueOnce({
      id: 100,
      org_id: 'org-1',
      claim_id: 5,
      repo: 'test-org/test-repo',
      pr_number: 42,
      phase: 'red',
      framework: 'vitest',
      outcome: 'passed',
      matrix: { requirements: {} },
      test_hashes: null,
      artifact_sha: 'artifact-sha-123',
      created_at: new Date('2026-01-01T00:00:00Z'),
    });

    await handleCheckRun('test-org', 'test-repo', makePayload(), defaultConfig);

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