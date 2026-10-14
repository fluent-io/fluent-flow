import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaimWithRetry: vi.fn(),
  createClaim: vi.fn(),
  nextChainAttempt: vi.fn(),
  countCompletedFixIterations: vi.fn(),
}));

vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
}));

vi.mock('../../src/notifications/dispatcher.js', () => ({
  dispatch: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({ default_agent: 'agent-1' }),
  installationCtxForRepo: vi.fn().mockResolvedValue({ installation_id: 456 }),
}));

vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn((ctx) => ({ ctx })),
}));

vi.mock('../../src/providers/github/rest.js', () => ({
  addLabel: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimResolved: vi.fn(),
  renderMatrixSummary: vi.fn(() => ({ title: 'Verification Matrix', summary: 'retry limit exhausted', annotations: [] })),
}));

import { audit } from '../../src/db/client.js';
import { sweepStrandedVerifyClaims, applyVerifyTransition, applyVerifyTransitionWithEffects, handleVerifyRedispatchExhausted } from '../../src/engine/verify-transitions.js';
import { createClaimWithRetry, nextChainAttempt, countCompletedFixIterations } from '../../src/agents/claim-manager.js';
import { dispatchReview } from '../../src/engine/review-manager.js';
import { dispatch as notifyDispatch } from '../../src/notifications/dispatcher.js';
import { onClaimResolved } from '../../src/engine/check-run.js';

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

  it('red FAIL → review_fix inlines findings and test-hash immutability (ungated path)', async () => {
    const claim = makeClaim({
      id: 9,
      payload: {
        phase: 'red',
        branch: 'fix/red',
        findings: [{ id: 'F-1', issue: 'Broken auth' }, { id: 'F-2', issue: 'Missing input validation' }],
      },
    });
    const verification = makeVerification({
      phase: 'red',
      outcome: 'FAIL',
      test_hashes: [{ path: 'test/verify/red-1.test.ts', sha256: 'ffff0000' }],
      matrix: { requirements: [], suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }, schema_version: 1 },
    });

    const decision = await applyVerifyTransition(claim, verification, { orgId: 'o1' }, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.claimSpec.payload.source_claim_id).toBe(9);
    expect(decision.claimSpec.payload.branch).toBe('fix/red');
    expect(decision.claimSpec.payload.findings).toEqual([
      { id: 'F-1', issue: 'Broken auth' },
      { id: 'F-2', issue: 'Missing input validation' },
    ]);
    expect(decision.claimSpec.payload.immutability).toEqual(['test/verify/red-1.test.ts']);
  });

  it('red SKIPPED → review_fix inlines findings with empty immutability when no hashes (ungated path)', async () => {
    const claim = makeClaim({
      id: 10,
      payload: { phase: 'red', branch: 'fix/red2', findings: [{ id: 'F-3', issue: 'Unhandled error' }] },
    });
    const verification = makeVerification({ phase: 'red', outcome: 'SKIPPED', framework: 'none' });

    const decision = await applyVerifyTransition(claim, verification, { orgId: 'o1' }, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.claimSpec.payload.source_claim_id).toBe(10);
    expect(decision.claimSpec.payload.findings).toEqual([{ id: 'F-3', issue: 'Unhandled error' }]);
    expect(decision.claimSpec.payload.immutability).toEqual([]);
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
    expect(decision.claimSpec.payload.source_claim_id).toBe(1);
  });

  it('green FAIL review_fix points back to the red claim and carries verifier context', async () => {
    const claim = makeClaim({
      id: 12,
      payload: {
        phase: 'green',
        red_claim_id: 7,
        branch: 'fix/x',
        findings: [{ id: 'F-1', issue: 'Broken auth' }],
        red_record: {
          test_hashes: [
            { path: 'tests/verify/auth.red.test.js', sha256: 'abc' },
            { path: 'package-lock.json', sha256: 'def' },
          ],
        },
      },
    });
    const verification = makeVerification({ phase: 'green', outcome: 'FAIL' });
    countCompletedFixIterations.mockResolvedValue(5);
    const ctx = { orgId: 'o1' };

    const decision = await applyVerifyTransition(claim, verification, ctx, {
      getNextAttempt: nextChainAttempt,
      getCountFixIterations: countCompletedFixIterations,
    });

    expect(decision.action).toBe('create_claim');
    expect(decision.claimSpec.payload).toEqual(expect.objectContaining({
      source_claim_id: 7,
      source_green_claim_id: 12,
      branch: 'fix/x',
      findings: [{ id: 'F-1', issue: 'Broken auth' }],
      immutability: ['tests/verify/auth.red.test.js', 'package-lock.json'],
    }));
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

describe('verify redispatch exhaustion', () => {
  it('creates the ungated follow-up and resolves the verify check run', async () => {
    const claim = makeClaim({
      id: 77,
      attempt: 10,
      payload: { phase: 'red', branch: 'fix/x', verification: { skip_policy: 'allow_ungated' }, agent_id: 'agent-1' },
      check_run_external_id: 321,
    });

    const result = await handleVerifyRedispatchExhausted(claim, { orgId: 'o1' });

    expect(result.verification).toEqual(expect.objectContaining({
      phase: 'red',
      framework: 'none',
      outcome: 'FAIL',
      matrix: expect.objectContaining({
        requirements: [expect.objectContaining({ id: 'VERIFY-EXHAUSTED', status: 'FAIL' })],
      }),
    }));
    expect(createClaimWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        claimType: 'review_fix',
        payload: expect.objectContaining({ source_claim_id: 77, branch: 'fix/x' }),
      }),
      expect.any(Function),
    );
    expect(onClaimResolved).toHaveBeenCalledWith(
      { ctx: { provider: 'github', installation_id: 456 } },
      claim,
      expect.objectContaining({ conclusion: 'failure', output: expect.objectContaining({ title: 'Verification Matrix' }) }),
    );
  });
});

describe('sweepStrandedVerifyClaims', () => {
  it('replays transitions for completed verify claims with a result but no successor', async () => {
    const claimRow = { id: 42, org_id: 'o1', repo: 'owner/repo', pr_number: 5, attempt: 3, payload: { phase: 'green' }, head_sha: 'abc' };
    const resultRow = { phase: 'green', framework: 'vitest', outcome: 'PASS', matrix: null, test_hashes: null, artifact_sha: null, red_base_sha: null, green_sha: 'def' };
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [claimRow] })   // stranded-with-result query
        .mockResolvedValueOnce([resultRow])            // per-claim result fetch
        .mockResolvedValueOnce({ rows: [] }),          // stranded-without-result query
    };
    await sweepStrandedVerifyClaims(db);
    // green-PASS replay's observable effect: the re-review dispatch fires
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
  });

  it('does not replay terminal decisions that cannot create a successor', async () => {
    const claimRow = {
      id: 43,
      org_id: 'o1',
      repo: 'owner/repo',
      pr_number: 5,
      attempt: 3,
      payload: { phase: 'green', verification: { skip_policy: 'require' }, agent_id: 'agent-1' },
      head_sha: 'abc',
    };
    const resultRow = { phase: 'green', framework: 'vitest', outcome: 'SKIPPED', matrix: null, test_hashes: null, artifact_sha: null, red_base_sha: null, green_sha: 'def' };
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [claimRow] })
        .mockResolvedValueOnce([resultRow])
        .mockResolvedValueOnce({ rows: [] }),
    };

    await sweepStrandedVerifyClaims(db);

    expect(createClaimWithRetry).not.toHaveBeenCalled();
    expect(dispatchReview).not.toHaveBeenCalled();
    expect(notifyDispatch).not.toHaveBeenCalled();
  });

  it('logs + audits completed verify claims without a result row', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 77, org_id: 'o1', repo: 'owner/repo', pr_number: 6, attempt: 2 }] }),
    };
    await sweepStrandedVerifyClaims(db);
    expect(audit).toHaveBeenCalledWith('verify_result_missing', expect.objectContaining({
      data: expect.objectContaining({ claimId: 77 }),
    }));
  });
});

