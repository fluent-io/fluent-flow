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

import {
  completeClaimById,
  failClaim,
  failClaimById,
  getClaimById,
  getClaimByAttempt,
  createClaim,
  redispatchClaim,
} from '../../src/agents/claim-manager.js';
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

const CLAIM_ROW = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'review',
  payload: { branch: 'fix/x' },
  head_sha: 'abc123',
  status: 'claimed',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleClaimResult — claim_id path', () => {
  it('completes by id without any natural-key lookup (no cross-type ambiguity)', async () => {
    completeClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      res,
    );

    expect(completeClaimById).toHaveBeenCalledWith('o1', 7);
    expect(getClaimByAttempt).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.claim_id).toBe(7);
  });

  it('completed review with FAIL verdict still auto-chains review_fix at attempt+1', async () => {
    completeClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    createClaim.mockResolvedValueOnce({ id: 8 });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7, verdict: 'fail' }),
      res,
    );

    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({
      claimType: 'review_fix',
      attempt: 3,
      prNumber: 5,
    }));
  });

  it('already-resolved claim by id returns 200 already_resolved', async () => {
    completeClaimById.mockResolvedValueOnce(null);
    getClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe('already_resolved');
  });

  it('transient failure fails by id and re-dispatches at attempt+1', async () => {
    failClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, claim_type: 'review_fix', status: 'failed' });
    redispatchClaim.mockResolvedValueOnce({ id: 8, attempt: 3 });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'failed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7, failure_kind: 'transient' }),
      res,
    );

    expect(failClaimById).toHaveBeenCalledWith('o1', 7);
    expect(redispatchClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, claim_type: 'review_fix', payload: CLAIM_ROW.payload, head_sha: 'abc123' }),
    );
    expect(res.body.status).toBe('failed');
  });

  it('terminal failure (default) does NOT re-dispatch', async () => {
    failClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'failed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'failed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7 }),
      res,
    );

    expect(redispatchClaim).not.toHaveBeenCalled();
  });

  it('payloads without claim_id keep the legacy natural-key path', async () => {
    getClaimByAttempt.mockResolvedValueOnce({ ...CLAIM_ROW, claim_type: 'review_fix', status: 'claimed' });
    failClaim.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'failed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'failed', repo: 'o/r', pr_number: 5, attempt: 2, failure_kind: 'transient' }),
      res,
    );

    expect(failClaim).toHaveBeenCalledWith('o1', 'o/r', 5, 2, 'review_fix');
    expect(failClaimById).not.toHaveBeenCalled();
    expect(redispatchClaim).toHaveBeenCalled();
  });
});
