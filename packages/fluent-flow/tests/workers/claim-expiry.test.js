import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  expireClaims: vi.fn(),
  redispatchClaim: vi.fn(),
}));

vi.mock('../../src/engine/verify-transitions.js', () => ({
  sweepStrandedVerifyClaims: vi.fn(),
  handleVerifyRedispatchExhausted: vi.fn(),
}));

import logger from '../../src/logger.js';
import { expireClaims, redispatchClaim } from '../../src/agents/claim-manager.js';
import { expireClaimsTick } from '../../src/workers/claim-expiry.js';
import { handleVerifyRedispatchExhausted } from '../../src/engine/verify-transitions.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireClaims.mockResolvedValue([]);
  redispatchClaim.mockResolvedValue({ id: 99, attempt: 4 });
});

describe('expireClaimsTick', () => {
  it('calls expireClaims() once', async () => {
    await expireClaimsTick();
    expect(expireClaims).toHaveBeenCalledTimes(1);
  });

  it('swallows errors and logs them so the loop keeps running', async () => {
    expireClaims.mockRejectedValueOnce(new Error('db down'));

    await expect(expireClaimsTick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('expireClaimsTick'),
        error: 'db down',
      }),
    );
  });

  it('propagates the rows returned by expireClaims for observability', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 1, claim_type: 'review', payload: {}, head_sha: null },
    ]);

    const result = await expireClaimsTick();

    expect(result).toEqual([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 1, claim_type: 'review', payload: {}, head_sha: null },
    ]);
  });

  it('re-dispatches each expired claim via the shared redispatchClaim helper', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'abc123' },
    ]);

    await expireClaimsTick();

    expect(redispatchClaim).toHaveBeenCalledTimes(1);
    expect(redispatchClaim).toHaveBeenCalledWith(
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'abc123' },
    );
  });

  it('logs a warning when redispatchClaim declines (conflict or max attempts)', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 10, claim_type: 'review', payload: {}, head_sha: null },
    ]);
    redispatchClaim.mockResolvedValueOnce(null);

    await expireClaimsTick();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('Failed to re-dispatch expired claim') }),
    );
  });

  it('handles exhausted verify expirations instead of warning-only dead ends', async () => {
    const claim = {
      id: 'c1',
      org_id: 'o1',
      repo: 'o/r',
      pr_number: 1,
      attempt: 10,
      claim_type: 'verify',
      payload: { phase: 'red', branch: 'fix/x' },
      head_sha: 'abc123',
    };
    expireClaims.mockResolvedValueOnce([claim]);
    redispatchClaim.mockResolvedValueOnce(null);

    await expireClaimsTick();

    expect(handleVerifyRedispatchExhausted).toHaveBeenCalledWith(claim, { orgId: 'o1' });
  });
});
