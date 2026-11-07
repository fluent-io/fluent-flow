import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  assertClaimOwner: vi.fn(),
  assertClaimReporter: vi.fn(),
  cancelClaimById: vi.fn(),
  completeClaimById: vi.fn(),
  createFollowOnClaim: vi.fn(),
  extendClaim: vi.fn(),
  failClaimById: vi.fn(),
  redispatchClaim: vi.fn(),
  withClaimOwner: vi.fn(),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getVerificationResultByClaim: vi.fn(),
    insertVerificationResultAtomic: vi.fn(),
    markVerificationTransitionApplied: vi.fn(),
  };
});

vi.mock('../../src/engine/verify-transitions.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyVerifyTransition: vi.fn(),
    applyVerifyTransitionWithEffects: vi.fn(),
    handleVerifyRedispatchExhausted: vi.fn(),
  };
});

import { handleClaimResult } from '../../src/routes/runner.js';
import {
  assertClaimOwner,
  assertClaimReporter,
  completeClaimById,
} from '../../src/agents/claim-manager.js';
import {
  getVerificationResultByClaim,
  insertVerificationResultAtomic,
  markVerificationTransitionApplied,
} from '@fluent-flow/db';
import {
  applyVerifyTransition,
  applyVerifyTransitionWithEffects,
} from '../../src/engine/verify-transitions.js';

const ACTIVE_VERIFY = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'verify',
  status: 'claimed',
  payload: { phase: 'red' },
  head_sha: 'abc123',
};

const VERIFICATION = {
  phase: 'red',
  framework: 'vitest',
  outcome: 'PASS',
  matrix: {
    requirements: [],
    suite: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 },
    schema_version: 1,
  },
  test_hashes: [{ path: 'test/verify/req1.test.ts', sha256: 'abcd' }],
  artifact_sha: '1234567890abcdef1234567890abcdef12345678',
  red_base_sha: 'abcdef1234567890abcdef1234567890abcdef12',
};

function request(body) {
  return {
    body: {
      status: 'completed',
      repo: 'o/r',
      pr_number: 5,
      attempt: 2,
      claim_id: 7,
      session_id: 3,
      ...body,
    },
    tokenInfo: { org_id: 'o1', agent_id: 'a1' },
  };
}

function response() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  assertClaimOwner.mockResolvedValue(ACTIVE_VERIFY);
  getVerificationResultByClaim.mockResolvedValue({
    phase: VERIFICATION.phase,
    framework: VERIFICATION.framework,
    outcome: VERIFICATION.outcome,
    matrix: VERIFICATION.matrix,
    testHashes: VERIFICATION.test_hashes,
    artifactSha: VERIFICATION.artifact_sha,
    redBaseSha: VERIFICATION.red_base_sha,
    greenSha: null,
    transitionAppliedAt: null,
  });
  completeClaimById.mockImplementation(async (_orgId, _claimId, _sessionId, onFinalize) => {
    const completed = { ...ACTIVE_VERIFY, status: 'completed' };
    await onFinalize?.({ tx: true }, completed);
    return completed;
  });
  applyVerifyTransition.mockResolvedValue({ action: 'dispatch_review' });
  applyVerifyTransitionWithEffects.mockResolvedValue({ action: 'create_claim' });
});

describe('handleClaimResult verification results', () => {
  it('persists a completed verification and applies its transition', async () => {
    const res = response();
    await handleClaimResult(request({ verification: VERIFICATION }), res);

    expect(insertVerificationResultAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'o1',
        claimId: 7,
        phase: 'red',
        outcome: 'PASS',
        artifactSha: VERIFICATION.artifact_sha,
      }),
      { tx: true },
    );
    expect(applyVerifyTransitionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: 'completed' }),
      VERIFICATION,
      { orgId: 'o1' },
    );
    expect(markVerificationTransitionApplied).toHaveBeenCalledWith(7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, claim_id: 7, status: 'completed' });
  });

  it('rejects a completed verify claim without verification evidence', async () => {
    const res = response();
    await handleClaimResult(request({}), res);

    expect(res.statusCode).toBe(400);
    expect(completeClaimById).not.toHaveBeenCalled();
  });

  it('rejects verification evidence on a non-verify claim', async () => {
    assertClaimOwner.mockResolvedValue({ ...ACTIVE_VERIFY, claim_type: 'review' });
    const res = response();
    await handleClaimResult(request({ verification: VERIFICATION }), res);

    expect(res.statusCode).toBe(400);
    expect(completeClaimById).not.toHaveBeenCalled();
  });

  it('replays an already-completed transition without finalizing again', async () => {
    const ownershipError = new Error('Claim is not active for this runner');
    ownershipError.statusCode = 409;
    assertClaimOwner.mockRejectedValue(ownershipError);
    assertClaimReporter.mockResolvedValue({ ...ACTIVE_VERIFY, status: 'completed' });
    const decision = { action: 'dispatch_review' };
    applyVerifyTransition.mockResolvedValue(decision);
    const res = response();

    await handleClaimResult(request({ verification: VERIFICATION }), res);

    expect(applyVerifyTransitionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: 'completed' }),
      expect.objectContaining({ phase: 'red', outcome: 'PASS' }),
      { orgId: 'o1' },
      decision,
    );
    expect(markVerificationTransitionApplied).toHaveBeenCalledWith(7);
    expect(completeClaimById).not.toHaveBeenCalled();
    expect(res.body.note).toBe('already_resolved');
  });
});
