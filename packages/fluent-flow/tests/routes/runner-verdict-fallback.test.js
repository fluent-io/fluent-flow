import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
  completeClaimById: vi.fn(),
  failClaimById: vi.fn(),
  getClaimById: vi.fn(),
  getClaimByAttempt: vi.fn(),
  createClaim: vi.fn(),
  redispatchClaim: vi.fn(),
}));

vi.mock('../../src/engine/review-manager.js', () => ({
  fetchLatestReviewVerdict: vi.fn(),
  dispatchReview: vi.fn(),
}));

import { completeClaimById, createClaim } from '../../src/agents/claim-manager.js';
import { fetchLatestReviewVerdict } from '../../src/engine/review-manager.js';
import { handleClaimResult } from '../../src/routes/runner.js';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

const REQ = (body) => ({ body, tokenInfo: { org_id: 'o1', agent_id: 'a1' } });

const REVIEW_CLAIM = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'review',
  payload: {},
  head_sha: 'abc123',
  status: 'claimed',
};

beforeEach(() => {
  vi.clearAllMocks();
  completeClaimById.mockResolvedValue({ ...REVIEW_CLAIM, status: 'completed' });
});

describe('verdict fallback from GitHub review body', () => {
  it('fetches the latest review when a review claim completes without a stdout verdict', async () => {
    fetchLatestReviewVerdict.mockResolvedValueOnce('fail');
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      res,
    );

    expect(fetchLatestReviewVerdict).toHaveBeenCalledWith({ owner: 'o', repo: 'r', prNumber: 5 });
    // FAIL via the fallback must still auto-chain review_fix at attempt + 1
    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({
      claimType: 'review_fix',
      attempt: 3,
      prNumber: 5,
    }));
  });

  it('does not fetch when the runner already parsed a verdict from stdout', async () => {
    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7, verdict: 'fail' }),
      makeRes(),
    );
    expect(fetchLatestReviewVerdict).not.toHaveBeenCalled();
    expect(createClaim).toHaveBeenCalled();
  });

  it('does not fetch for non-review claim types', async () => {
    completeClaimById.mockResolvedValueOnce({ ...REVIEW_CLAIM, claim_type: 'review_fix', status: 'completed' });
    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      makeRes(),
    );
    expect(fetchLatestReviewVerdict).not.toHaveBeenCalled();
  });

  it('a fallback failure is logged, not thrown — the completion still 200s', async () => {
    fetchLatestReviewVerdict.mockRejectedValueOnce(new Error('GitHub API error: 404'));
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(createClaim).not.toHaveBeenCalled(); // no verdict → no chain
  });

  it('a PASS fallback verdict does not chain review_fix', async () => {
    fetchLatestReviewVerdict.mockResolvedValueOnce('pass');
    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      makeRes(),
    );
    expect(createClaim).not.toHaveBeenCalled();
  });
});
