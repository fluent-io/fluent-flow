import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  assertClaimOwner: vi.fn(),
  withClaimOwner: vi.fn(),
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
  completeClaimById: vi.fn(),
  failClaimById: vi.fn(),
  cancelClaimById: vi.fn(),
  getClaimById: vi.fn(),
  getClaimByAttempt: vi.fn(),
  createClaim: vi.fn(),
  redispatchClaim: vi.fn(),
  extendClaim: vi.fn(),
}));

import {
  assertClaimOwner,
  cancelClaimById,
  completeClaimById,
  createClaim,
  failClaimById,
  redispatchClaim,
} from '../../src/agents/claim-manager.js';
import { handleClaimResult } from '../../src/routes/runner.js';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
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
  session_id: 3,
  claim_type: 'review',
  payload: { branch: 'fix/x' },
  head_sha: 'abc123',
  status: 'claimed',
};

const RESULT = {
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_id: 7,
  session_id: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  assertClaimOwner.mockResolvedValue(CLAIM_ROW);
});

describe('handleClaimResult owner-bound terminal results', () => {
  it('requires both claim_id and session_id', async () => {
    for (const body of [
      { ...RESULT, status: 'completed', claim_id: undefined },
      { ...RESULT, status: 'completed', session_id: undefined },
    ]) {
      const res = makeRes();
      await handleClaimResult(REQ(body), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Validation failed' });
      expect(res.body).not.toHaveProperty('details');
    }
    expect(assertClaimOwner).not.toHaveBeenCalled();
    expect(completeClaimById).not.toHaveBeenCalled();
  });

  it('completes only the claim currently owned by the token agent and runner session', async () => {
    completeClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'completed' }), res);

    expect(assertClaimOwner).toHaveBeenCalledWith({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 });
    expect(completeClaimById).toHaveBeenCalledWith('o1', 7, 3);
    expect(res.body).toEqual({ ok: true, claim_id: 7, status: 'completed' });
  });

  it.each([
    [404, 'foreign claim', { error: 'Claim not found' }],
    [409, 'wrong runner session or agent', { error: 'Claim is not active for this runner' }],
    [409, 'already completed claim', { error: 'Claim is not active for this runner' }],
  ])('rejects ownership failure with generic %i instead of treating %s as success', async (statusCode, detail, expectedBody) => {
    assertClaimOwner.mockRejectedValueOnce(Object.assign(new Error(detail), { statusCode }));
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'completed' }), res);

    expect(res.statusCode).toBe(statusCode);
    expect(res.body).toEqual(expectedBody);
    expect(JSON.stringify(res.body)).not.toContain(detail);
    expect(completeClaimById).not.toHaveBeenCalled();
  });

  it('completed review with a fail verdict preserves review-fix chaining after owner-bound finalization', async () => {
    completeClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    createClaim.mockResolvedValueOnce({ id: 8 });
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'completed', verdict: 'fail' }), res);

    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({
      claimType: 'review_fix',
      attempt: 3,
      prNumber: 5,
    }));
  });

  it('re-dispatches an owner-bound transient failure only after failed finalization', async () => {
    failClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, claim_type: 'review_fix', status: 'failed' });
    redispatchClaim.mockResolvedValueOnce({ id: 8, attempt: 3 });
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'failed', failure_kind: 'transient' }), res);

    expect(assertClaimOwner).toHaveBeenCalledWith({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 });
    expect(failClaimById).toHaveBeenCalledWith('o1', 7, 3);
    expect(redispatchClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 7, claim_type: 'review_fix' }));
    expect(res.body.status).toBe('failed');
  });

  it('does not re-dispatch a terminal failure', async () => {
    failClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'failed' });
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'failed' }), res);

    expect(redispatchClaim).not.toHaveBeenCalled();
  });

  it('finalizes cancellation, frees the claim, creates no follow-on, and never re-dispatches', async () => {
    cancelClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'cancelled' });
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'cancelled', failure_kind: 'transient' }), res);

    expect(assertClaimOwner).toHaveBeenCalledWith({ orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 });
    expect(cancelClaimById).toHaveBeenCalledWith('o1', 7, 3);
    expect(completeClaimById).not.toHaveBeenCalled();
    expect(failClaimById).not.toHaveBeenCalled();
    expect(createClaim).not.toHaveBeenCalled();
    expect(redispatchClaim).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, claim_id: 7, status: 'cancelled' });
  });

  it('returns a generic 409 when the ownership-predicated terminal update loses a race', async () => {
    completeClaimById.mockResolvedValueOnce(null);
    const res = makeRes();

    await handleClaimResult(REQ({ ...RESULT, status: 'completed' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Claim is not active for this runner' });
    expect(res.body).not.toHaveProperty('note');
  });
});
