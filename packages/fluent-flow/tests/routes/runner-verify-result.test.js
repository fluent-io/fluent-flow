import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  getClaimById: vi.fn(),
  completeClaimById: vi.fn(),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withTransaction: vi.fn((fn) => fn({})),
    insertVerificationResult: vi.fn(),
  };
});

vi.mock('../../src/engine/verify-transitions.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, applyVerifyTransitionWithEffects: vi.fn() };
});

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimStarted: vi.fn(),
  onClaimResolved: vi.fn(),
  renderMatrixSummary: vi.fn(() => ({ title: 'Verification Matrix', summary: 'ok', annotations: [] })),
}));

import { handleClaimResult } from '../../src/routes/runner.js';
import { getClaimById, completeClaimById } from '../../src/agents/claim-manager.js';
import { applyVerifyTransitionWithEffects } from '../../src/engine/verify-transitions.js';
import { onClaimResolved } from '../../src/engine/check-run.js';
import { withTransaction, insertVerificationResult } from '@fluent-flow/db';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

const REQ = (body) => ({ 
  body, 
  tokenInfo: { org_id: 'o1', agent_id: 'a1' } 
});

const VERIFY_CLAIM = {
  id: 7,
  org_id: 'o1',
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'verify',
  status: 'pending',
  payload: { phase: 'red' },
  head_sha: 'abc123',
  check_run_external_id: 321,
};

const TX = { tx: true };

beforeEach(() => {
  vi.clearAllMocks();
  getClaimById.mockResolvedValue(VERIFY_CLAIM);
  completeClaimById.mockResolvedValue(VERIFY_CLAIM);
  applyVerifyTransitionWithEffects.mockResolvedValue({ action: 'create_claim' });
  vi.mocked(withTransaction).mockImplementation(async (fn) => fn(TX));
});

describe('handleClaimResult — verify branch', () => {
  it('verify result with verification data applies transition', async () => {
    const res = makeRes();
    const verification = {
      manifest: {
        pr_number: 5,
        requirements: [{
          requirement: {
            id: 'REQ-1',
            form: 'when',
            text: 'When invalid login is submitted, the request fails.',
            source_finding_id: 'F1',
          },
          tests: ['test/verify/req1.test.ts'],
          dependency_files: [],
          framework: 'vitest',
        }],
      },
      phase: 'red',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: {
        requirements: [],
        suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
        schema_version: 1,
      },
      test_hashes: [{ path: 'test/verify/req1.test.ts', sha256: 'abcd' }],
      artifact_sha: '1234567890abcdef1234567890abcdef12345678',
      red_base_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      green_sha: null,
    };

    await handleClaimResult(
      REQ({ 
        status: 'completed', 
        repo: 'o/r', 
        pr_number: 5, 
        attempt: 2, 
        claim_id: 7,
        verification 
      }),
      res,
    );

    // Completion and result persistence must share one transaction so a
    // crash/error cannot leave a completed verify claim without its red record.
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(completeClaimById).toHaveBeenCalledWith('o1', 7, TX);
    expect(insertVerificationResult).toHaveBeenCalledWith({
      orgId: 'o1',
      claimId: 7,
      repo: 'o/r',
      prNumber: 5,
      phase: 'red',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: {
        requirements: [],
        suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
        schema_version: 1,
      },
      manifest: {
        pr_number: 5,
        requirements: [{
          requirement: {
            id: 'REQ-1',
            form: 'when',
            text: 'When invalid login is submitted, the request fails.',
            source_finding_id: 'F1',
          },
          tests: ['test/verify/req1.test.ts'],
          dependency_files: [],
          framework: 'vitest',
        }],
      },
      testHashes: [{ path: 'test/verify/req1.test.ts', sha256: 'abcd' }],
      artifactSha: '1234567890abcdef1234567890abcdef12345678',
      redBaseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      greenSha: null,
    }, TX);
    expect(applyVerifyTransitionWithEffects).toHaveBeenCalledWith(
      VERIFY_CLAIM,
      verification,
      { orgId: 'o1' },
    );
    expect(onClaimResolved).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ check_run_external_id: 321 }),
      expect.objectContaining({ conclusion: 'success', output: expect.objectContaining({ title: 'Verification Matrix' }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.claim_id).toBe(7);
  });

  it('non-verify claim type skips verification path', async () => {
    const reviewClaim = { ...VERIFY_CLAIM, claim_type: 'review' };
    getClaimById.mockResolvedValue(reviewClaim);
    const res = makeRes();

    await handleClaimResult(
      REQ({ 
        status: 'completed', 
        repo: 'o/r', 
        pr_number: 5, 
        attempt: 2, 
        claim_id: 7,
      }),
      res,
    );

    expect(applyVerifyTransitionWithEffects).not.toHaveBeenCalled();
    expect(insertVerificationResult).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('verify result without verification object skips path', async () => {
    getClaimById.mockResolvedValue(VERIFY_CLAIM);
    const res = makeRes();

    await handleClaimResult(
      REQ({ 
        status: 'completed', 
        repo: 'o/r', 
        pr_number: 5, 
        attempt: 2, 
        claim_id: 7,
      }),
      res,
    );

    expect(applyVerifyTransitionWithEffects).not.toHaveBeenCalled();
    expect(insertVerificationResult).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('redelivery on an already-resolved verify claim re-derives the transition (spec §6.4)', async () => {
    completeClaimById.mockResolvedValueOnce(null);
    getClaimById.mockResolvedValueOnce({ ...VERIFY_CLAIM, status: 'completed' });
    const res = makeRes();

    await handleClaimResult(
      REQ({
        status: 'completed',
        repo: 'o/r',
        pr_number: 5,
        attempt: 2,
        claim_id: 7,
        verification: {
          phase: 'green', framework: 'vitest', outcome: 'PASS',
          matrix: null,
        },
      }),
      res,
    );

    expect(applyVerifyTransitionWithEffects).toHaveBeenCalledWith(
      { ...VERIFY_CLAIM, status: 'completed' },
      expect.objectContaining({ phase: 'green', outcome: 'PASS' }),
      expect.objectContaining({ orgId: 'o1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toBe('already_resolved');
  });
});
