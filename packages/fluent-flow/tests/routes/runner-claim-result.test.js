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
  nextChainAttempt: vi.fn(),
  countCompletedFixIterations: vi.fn(),
  createClaimWithRetry: vi.fn(),
}));

vi.mock('../../src/engine/verify-transitions.js', async () => {
  const actual = await vi.importActual('../../src/engine/verify-transitions.js');
  return {
    ...actual,
    handleVerifyRedispatchExhausted: vi.fn(),
  };
});
const mockAddLabel = vi.fn().mockResolvedValue(undefined);
const mockPostComment = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/providers/github/rest.js', () => ({
  addLabel: (...a) => mockAddLabel(...a),
  postComment: (...a) => mockPostComment(...a),
}));

const mockNotifyDispatch = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/notifications/dispatcher.js', () => ({
  dispatch: (...a) => mockNotifyDispatch(...a),
}));

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ default_agent: 'agent-1' }),
  installationCtxForRepo: vi.fn().mockResolvedValue({ installation_id: 456 }),
}));

const mockDbExecute = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('@fluent-flow/db', async () => {
  const actual = await vi.importActual('@fluent-flow/db');
  return {
    ...actual,
    db: { execute: (...a) => mockDbExecute(...a), ...(actual.db ?? {}) },
    withTransaction: async (fn) => fn(null),
    insertVerificationResult: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  completeClaimById,
  failClaim,
  failClaimById,
  getClaimById,
  getClaimByAttempt,
  createClaim,
  redispatchClaim,
} from '../../src/agents/claim-manager.js';
import { handleVerifyRedispatchExhausted } from '../../src/engine/verify-transitions.js';
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

  it('completed review with FAIL verdict does NOT auto-chain review_fix (handleReviewResult is the sole coordinator)', async () => {
    completeClaimById.mockResolvedValueOnce({ ...CLAIM_ROW, status: 'completed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'completed', repo: 'o/r', pr_number: 5, attempt: 2, claim_id: 7, verdict: 'fail' }),
      res,
    );

    expect(createClaim).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.claim_id).toBe(7);
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

  it('turns exhausted transient verify failures into an ungated review_fix transition', async () => {
    const verifyClaim = {
      ...CLAIM_ROW,
      attempt: 10,
      claim_type: 'verify',
      payload: { phase: 'red', branch: 'fix/x', verification: { skip_policy: 'allow_ungated' } },
      status: 'failed',
    };
    failClaimById.mockResolvedValueOnce(verifyClaim);
    redispatchClaim.mockResolvedValueOnce(null);
    const res = makeRes();

    await handleClaimResult(
      REQ({ status: 'failed', repo: 'o/r', pr_number: 5, attempt: 10, claim_id: 7, failure_kind: 'transient' }),
      res,
    );

    expect(redispatchClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 7, claim_type: 'verify' }));
    expect(handleVerifyRedispatchExhausted).toHaveBeenCalledWith(verifyClaim, { orgId: 'o1' });
    expect(res.statusCode).toBe(200);
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

describe('handleClaimResult — verify redelivery', () => {
  it('terminal verify result re-delivery returns already_resolved without label/comment/notify side effects', async () => {
    completeClaimById.mockResolvedValueOnce(null);
    getClaimById.mockResolvedValueOnce({
      ...CLAIM_ROW,
      claim_type: 'verify',
      payload: { phase: 'green' },
      status: 'completed',
    });
    const res = makeRes();

    await handleClaimResult(
      REQ({
        status: 'completed',
        repo: 'o/r',
        pr_number: 5,
        attempt: 2,
        claim_id: 7,
        verification: { phase: 'green', framework: 'vitest', outcome: 'TAMPERED', matrix: null },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe('already_resolved');
    // TAMPERED is terminal (needs_human + PR comment) — the first delivery already
    // posted them; redelivery must not repeat terminal side effects.
    expect(mockAddLabel).not.toHaveBeenCalled();
    expect(mockPostComment).not.toHaveBeenCalled();
    expect(mockNotifyDispatch).not.toHaveBeenCalled();
  });
});