import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaimWithRetry: vi.fn(),
  nextChainAttempt: vi.fn(),
  countCompletedFixIterations: vi.fn(),
}));

vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
}));

vi.mock('../../src/notifications/dispatcher.js', () => ({
  dispatch: vi.fn(),
}));

import { applyVerifyTransition } from '../../src/engine/verify-transitions.js';
import { createClaimWithRetry, nextChainAttempt, countCompletedFixIterations } from '../../src/agents/claim-manager.js';
import { dispatchReview } from '../../src/engine/review-manager.js';
import { dispatch as notifyDispatch } from '../../src/notifications/dispatcher.js';

function makeClaim(overrides = {}) {
  return {
    id: 1,
    org_id: 'o1',
    repo: 'owner/repo',
    pr_number: 5,
    attempt: 2,
    claim_type: 'verify',
    status: 'completed',
    payload: { phase: 'red' },
    head_sha: 'abc123',
    ...overrides,
  };
}

function makeVerification(overrides = {}) {
  return {
    phase: 'red',
    framework: 'vitest',
    outcome: 'PASS',
    matrix: null,
    test_hashes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createClaimWithRetry.mockResolvedValue({ id: 10, attempt: 3 });
  nextChainAttempt.mockResolvedValue(3);
  countCompletedFixIterations.mockResolvedValue(0);
  dispatchReview.mockResolvedValue({ claimed: true });
});

describe('verify-transitions — red phase', () => {
  it('red PASS → review_fix with source_claim_id and immutability list from test_hashes', async () => {
    const claim = makeClaim({ payload: { phase: 'red' }, id: 7 });
    const verification = makeVerification({ phase: 'red', outcome: 'PASS', test_hashes: [
      { path: 'test/verify/requirement-1.test.ts', sha256: 'abcd1234' },
      { path: 'test/verify/requirement-2.test.ts', sha256: 'efgh5678' },
    ]});
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.claimType).toBe('review_fix');
    expect(decision.claimSpec.payload.source_claim_id).toBe(7);
    expect(decision.claimSpec.payload.immutability).toEqual([
      'test/verify/requirement-1.test.ts',
      'test/verify/requirement-2.test.ts',
    ]);
    expect(nextChainAttempt).toHaveBeenCalledWith('o1', 'owner/repo', 5);
  });

  it('red FAIL → review_fix + check-run note (ungated)', async () => {
    const claim = makeClaim({ payload: { phase: 'red' } });
    const verification = makeVerification({ phase: 'red', outcome: 'FAIL', matrix: {
      requirements: [{ id: 'REQ-1', status: 'FAIL' }],
      suite: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 },
      schema_version: 1,
    }});
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.claimType).toBe('review_fix');
    expect(decision.checkRun).toBeDefined();
    expect(decision.checkRun.summary).toContain('Verification failed');
    expect(nextChainAttempt).toHaveBeenCalled();
  });

  it('red SKIPPED → review_fix (ungated) + note', async () => {
    const claim = makeClaim({ payload: { phase: 'red' } });
    const verification = makeVerification({ phase: 'red', outcome: 'SKIPPED', framework: 'none' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.claimType).toBe('review_fix');
    expect(decision.checkRun).toBeDefined();
    expect(decision.checkRun.summary).toContain('Verification skipped');
    expect(nextChainAttempt).toHaveBeenCalled();
  });

  it('red exhausted → review_fix (ungated) + notification', async () => {
    const claim = makeClaim({ payload: { phase: 'red' } });
    const verification = makeVerification({ phase: 'red', outcome: 'FAIL', matrix: {
      requirements: [],
      suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      schema_version: 1,
    }});
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.claimType).toBe('review_fix');
    expect(decision.notify).toBeDefined();
    expect(nextChainAttempt).toHaveBeenCalled();
  });
});

describe('verify-transitions — green phase', () => {
  it('green PASS → dispatchReview (re-review)', async () => {
    const claim = makeClaim({ payload: { phase: 'green' }, head_sha: 'def456' });
    const verification = makeVerification({ phase: 'green', outcome: 'PASS' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('dispatch_review');
    expect(nextChainAttempt).toHaveBeenCalledWith('o1', 'owner/repo', 5);
  });

  it('green FAIL → review_fix next cycle IF fix iterations < 10', async () => {
    const claim = makeClaim({ payload: { phase: 'green' } });
    const verification = makeVerification({ phase: 'green', outcome: 'FAIL' });
    countCompletedFixIterations.mockResolvedValue(5);
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.claimType).toBe('review_fix');
    expect(countCompletedFixIterations).toHaveBeenCalledWith('o1', 'owner/repo', 5);
    expect(nextChainAttempt).toHaveBeenCalled();
  });

  it('green FAIL with exhausted iterations → needs-human escalation', async () => {
    const claim = makeClaim({ payload: { phase: 'green' } });
    const verification = makeVerification({ phase: 'green', outcome: 'FAIL' });
    countCompletedFixIterations.mockResolvedValue(10);
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('needs_human');
    expect(decision.notify).toBeDefined();
    expect(nextChainAttempt).not.toHaveBeenCalled();
  });

  it('green SKIPPED with allow_ungated → dispatchReview (re-review with attempt)', async () => {
    const claim = makeClaim({ 
      payload: { phase: 'green', verification: { skip_policy: 'allow_ungated' } },
      head_sha: 'def456',
    });
    const verification = makeVerification({ phase: 'green', outcome: 'SKIPPED' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('dispatch_review');
    expect(nextChainAttempt).toHaveBeenCalledWith('o1', 'owner/repo', 5);
    expect(decision.dispatchReviewSpec.attempt).toBe(3);
  });

  it('green SKIPPED with require → needs-human + notify', async () => {
    const claim = makeClaim({ 
      payload: { phase: 'green', verification: { skip_policy: 'require' } },
    });
    const verification = makeVerification({ phase: 'green', outcome: 'SKIPPED' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('needs_human');
    expect(decision.notify).toBeDefined();
    expect(nextChainAttempt).not.toHaveBeenCalled();
  });

  it('green SKIPPED with manual → pause record', async () => {
    const claim = makeClaim({ 
      payload: { phase: 'green', verification: { skip_policy: 'manual' } },
    });
    const verification = makeVerification({ phase: 'green', outcome: 'SKIPPED' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('pause');
    expect(decision.notify).toBeDefined();
    expect(nextChainAttempt).not.toHaveBeenCalled();
  });
});

describe('verify-transitions — TAMPERED path', () => {
  it('any TAMPERED → PR comment + notification + needs-human; NO chain', async () => {
    const claim = makeClaim({ payload: { phase: 'red' } });
    const verification = makeVerification({ phase: 'red', outcome: 'TAMPERED' });
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('needs_human');
    expect(decision.notify).toBeDefined();
    expect(decision.notify).toEqual(
      expect.objectContaining({
        type: 'pr_comment',
        body: 'Verification detected modified verifier tests on this PR. Escalated to a human.',
      }),
    );
    expect(createClaimWithRetry).not.toHaveBeenCalled();
    expect(dispatchReview).not.toHaveBeenCalled();
  });
});