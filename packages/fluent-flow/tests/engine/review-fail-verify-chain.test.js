import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn(),
  resolveOrgId: vi.fn(),
  installationCtxForRepo: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  nextChainAttempt: vi.fn(),
  createClaim: vi.fn(),
  completeClaim: vi.fn(),
  getActiveClaim: vi.fn(),
  createClaimWithRetry: vi.fn(),
}));

vi.mock('../../src/providers/github/rest.js', () => ({
  addLabel: vi.fn(),
  getReviews: vi.fn(),
  dismissReview: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock('../../src/providers/github/graphql.js', () => ({
  enablePullRequestAutoMerge: vi.fn(),
  getPRNodeId: vi.fn(),
}));

vi.mock('../../src/notifications/dispatcher.js', () => ({
  notifyReviewFailure: vi.fn(),
  formatRichMessage: vi.fn(() => 'Formatted message'),
  dispatch: vi.fn(),
}));

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimDispatched: vi.fn(),
  onClaimResolved: vi.fn(),
}));

vi.mock('../../src/engine/pause-manager.js', () => ({
  recordPause: vi.fn(),
  getActivePause: vi.fn(),
}));

// review-manager only touches db.update/insert for reviewRetries — stub them
// to no-op so handleReviewResult can run without a real connection.
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

import { handleReviewResult } from '../../src/engine/review-manager.js';
import { resolveConfig, resolveOrgId, installationCtxForRepo } from '../../src/config/loader.js';
import { nextChainAttempt, createClaimWithRetry } from '../../src/agents/claim-manager.js';
import { onClaimDispatched } from '../../src/engine/check-run.js';
import { postComment } from '../../src/providers/github/rest.js';

describe('handleReviewResult — review FAIL → verify:red chain coordinator', () => {
  const baseOpts = {
    owner: 'o',
    repo: 'r',
    prNumber: 5,
    issueNumber: 42,
    result: {
      status: 'FAIL',
      blocking: [{ id: 'F1', message: 'cart allows empty checkout' }],
      attempt: 2,
    },
    reviewSha: 'abc123',
    headBranch: 'fix/x',
    agentId: 'agent-1',
    ctx: { installation_id: 123 },
    prBody: 'Fixes #42',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: false },
    });
    resolveOrgId.mockResolvedValue('org-1');
    installationCtxForRepo.mockResolvedValue({ installation_id: 123 });
    nextChainAttempt.mockResolvedValue(3);
    createClaimWithRetry.mockResolvedValue({ id: 11 });
    onClaimDispatched.mockResolvedValue(undefined);
    postComment.mockResolvedValue(undefined);
  });

  it('FAIL creates verify:red (not review_fix) when verification enabled, with exact red payload structure', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: {
        enabled: true,
        framework: 'auto',
        command: 'npm test',
        install_command: 'npm ci',
        skip_policy: 'none',
        flake: { enabled: true, max_runs: 3 },
        authoring: { marker: 'verified-by' },
        timeouts_min: { verification: 10 },
      },
    });

    await handleReviewResult(baseOpts);

    expect(createClaimWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        repo: 'o/r',
        prNumber: 5,
        claimType: 'verify',
        headSha: 'abc123',
        payload: {
          phase: 'red',
          findings: [{ id: 'F1', message: 'cart allows empty checkout' }],
          pr_body: 'Fixes #42',
          issue_number: 42,
          red_base_sha: 'abc123',
          branch: 'fix/x',
          verification: {
            enabled: true,
            framework: 'auto',
            command: 'npm test',
            install_command: 'npm ci',
            skip_policy: 'none',
            flake: { enabled: true, max_runs: 3 },
            authoring: { marker: 'verified-by' },
            timeouts_min: { verification: 10 },
          },
        },
      }),
      expect.any(Function),
    );
  });

  it('FAIL creates verify:red with stable F1..Fn ids when blocking items lack ids', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: true, framework: 'auto' },
    });

    await handleReviewResult({
      ...baseOpts,
      result: {
        status: 'FAIL',
        blocking: [
          { message: 'issue one' },
          { message: 'issue two' },
          { message: 'issue three' },
        ],
        attempt: 2,
      },
    });

    const call = createClaimWithRetry.mock.calls[0];
    expect(call[0].payload.findings).toEqual([
      { id: 'F1', message: 'issue one' },
      { id: 'F2', message: 'issue two' },
      { id: 'F3', message: 'issue three' },
    ]);
  });

  it('FAIL creates verify:red with pr_body null when not threaded', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: true, framework: 'auto' },
    });

    await handleReviewResult({
      ...baseOpts,
      prBody: undefined,
    });

    const call = createClaimWithRetry.mock.calls[0];
    expect(call[0].payload.pr_body).toBeNull();
  });

  it('FAIL creates verify:red with issue_number null when not provided', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: true, framework: 'auto' },
    });

    await handleReviewResult({
      ...baseOpts,
      issueNumber: undefined,
    });

    const call = createClaimWithRetry.mock.calls[0];
    expect(call[0].payload.issue_number).toBeNull();
  });

  it('FAIL falls back to review_fix when verification disabled', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: false },
    });
    createClaimWithRetry.mockResolvedValue({ id: 15 });

    await handleReviewResult(baseOpts);

    expect(createClaimWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        repo: 'o/r',
        prNumber: 5,
        claimType: 'review_fix',
        headSha: 'abc123',
        payload: expect.objectContaining({
          branch: 'fix/x',
        }),
      }),
      expect.any(Function),
    );
  });

  it('FAIL falls back to review_fix when verification config missing entirely', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
    });
    createClaimWithRetry.mockResolvedValue({ id: 15 });

    await handleReviewResult(baseOpts);

    expect(createClaimWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        claimType: 'review_fix',
      }),
      expect.any(Function),
    );
  });

  it('verify:red claim dispatches check-run via onClaimDispatched', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: true, framework: 'auto' },
    });

    await handleReviewResult(baseOpts);

    expect(onClaimDispatched).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        id: 11,
        head_sha: 'abc123',
        installation_id: 123,
      }),
    );
  });

  it('verify:red claim posts 🔍 verifying status comment on PR', async () => {
    resolveConfig.mockResolvedValue({
      reviewer: { max_retries: 3 },
      verification: { enabled: true, framework: 'auto' },
    });

    await handleReviewResult(baseOpts);

    expect(postComment).toHaveBeenCalledWith(
      'o',
      'r',
      5,
      '🔍 **Fluent Flow** is verifying fixes for 1 blocking issue(s)...',
      { installation_id: 123 }
    );
  });
});