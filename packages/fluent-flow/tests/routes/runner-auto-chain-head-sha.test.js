import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 0 / Task 1: assert that auto-chain createClaim calls inside
 * handleClaimResult forward `head_sha` from the parent claim into the
 * follow-on claim. Without this, re-dispatched (post-expiry) auto-chain
 * claims can't surface a GitHub Check Run on the right commit.
 */

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: vi.fn(),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));
vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  dequeue: vi.fn(),
  hasPending: vi.fn(),
}));
vi.mock('@fluent-flow/db', () => ({
  db: { execute: vi.fn() },
}));
vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn(),
}));
vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: vi.fn(),
}));

const mockCompleteClaim = vi.fn();
const mockFailClaim = vi.fn();
const mockGetClaimByAttempt = vi.fn();
const mockCreateClaim = vi.fn();
vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: (...a) => mockCompleteClaim(...a),
  failClaim: (...a) => mockFailClaim(...a),
  getClaimByAttempt: (...a) => mockGetClaimByAttempt(...a),
  createClaim: (...a) => mockCreateClaim(...a),
}));

const mockDispatchReview = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: (...a) => mockDispatchReview(...a),
}));

import { handleClaimResult } from '../../src/routes/runner.js';

function makeReq(body) {
  return { body, tokenInfo: { org_id: 'org-1', agent_id: 'agent-1' } };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClaim.mockResolvedValue({ id: 'follow-on-1' });
  mockDispatchReview.mockResolvedValue(undefined);
});

describe('handleClaimResult auto-chain forwards head_sha', () => {
  it('review FAIL → review_fix forwards head_sha from the parent claim', async () => {
    mockGetClaimByAttempt.mockResolvedValueOnce({ id: 'r-1', claim_type: 'review' });
    mockCompleteClaim.mockResolvedValueOnce({
      id: 'r-1',
      status: 'completed',
      claim_type: 'review',
      head_sha: 'sha-review-1',
      payload: { branch: 'fix/x' },
    });

    const res = makeRes();
    await handleClaimResult(
      makeReq({ status: 'completed', repo: 'o/r', pr_number: 9, attempt: 1, verdict: 'fail' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.claimType).toBe('review_fix');
    expect(call.headSha).toBe('sha-review-1');
    expect(call.attempt).toBe(2);
  });

  it('spec → build auto-chain forwards head_sha from the parent claim', async () => {
    mockGetClaimByAttempt.mockResolvedValueOnce({ id: 's-1', claim_type: 'spec' });
    mockCompleteClaim.mockResolvedValueOnce({
      id: 's-1',
      status: 'completed',
      claim_type: 'spec',
      head_sha: 'sha-spec-1',
      payload: {},
    });

    const res = makeRes();
    await handleClaimResult(
      makeReq({ status: 'completed', repo: 'o/r', pr_number: 9, attempt: 1 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockCreateClaim).toHaveBeenCalledTimes(1);
    const call = mockCreateClaim.mock.calls[0][0];
    expect(call.claimType).toBe('build');
    expect(call.headSha).toBe('sha-spec-1');
    expect(call.attempt).toBe(2);
  });

  it('spec → build is skipped when payload.auto_chain === false', async () => {
    mockGetClaimByAttempt.mockResolvedValueOnce({ id: 's-1', claim_type: 'spec' });
    mockCompleteClaim.mockResolvedValueOnce({
      id: 's-1',
      status: 'completed',
      claim_type: 'spec',
      head_sha: 'sha-spec-2',
      payload: { auto_chain: false },
    });

    const res = makeRes();
    await handleClaimResult(
      makeReq({ status: 'completed', repo: 'o/r', pr_number: 9, attempt: 1 }),
      res,
    );

    expect(mockCreateClaim).not.toHaveBeenCalled();
  });
});
