import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  expireClaims: vi.fn(),
  redispatchClaim: vi.fn(),
}));

const providerClient = { createCheckRun: vi.fn() };

vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: vi.fn(),
}));

vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimDispatched: vi.fn(),
}));

vi.mock('../../src/engine/verify-transitions.js', () => ({
  sweepStrandedVerifyClaims: vi.fn(),
}));

vi.mock('@fluent-flow/db', () => ({
  db: { execute: vi.fn() },
}));

import logger from '../../src/logger.js';
import { expireClaims, redispatchClaim } from '../../src/agents/claim-manager.js';
import { installationCtxForRepo } from '../../src/config/loader.js';
import { getProvider } from '../../src/providers/index.js';
import { onClaimDispatched } from '../../src/engine/check-run.js';
import { sweepStrandedVerifyClaims } from '../../src/engine/verify-transitions.js';
import { expireClaimsTick } from '../../src/workers/claim-expiry.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireClaims.mockResolvedValue([]);
  sweepStrandedVerifyClaims.mockResolvedValue(undefined);
  redispatchClaim.mockResolvedValue({ id: 99, attempt: 4 });
  installationCtxForRepo.mockResolvedValue({ installation_id: 42 });
  getProvider.mockReturnValue(providerClient);
});

describe('expireClaimsTick', () => {
  it.each(['idle','host_lost','no_capacity'])('does not redispatch a chat ended for %s', async (end_reason) => {
    expireClaims.mockResolvedValueOnce([{id:7,claim_type:'chat',status:'cancelled',end_reason,repo:null}]);
    await expireClaimsTick();
    expect(redispatchClaim).not.toHaveBeenCalled();
    expect(installationCtxForRepo).not.toHaveBeenCalled();
  });

  it('calls expireClaims() once', async () => {
    await expireClaimsTick();
    expect(expireClaims).toHaveBeenCalledTimes(1);
  });

  it('recovers stranded verification transitions when no claims expire', async () => {
    await expireClaimsTick();
    expect(sweepStrandedVerifyClaims).toHaveBeenCalledTimes(1);
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

  it('does not redispatch until atomic interaction cancellation in expireClaims has completed', async () => {
    const order = [];
    const expiredClaim = { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: {}, head_sha: null };
    expireClaims.mockImplementationOnce(async () => {
      order.push('interactions-cancelled');
      return [expiredClaim];
    });
    redispatchClaim.mockImplementationOnce(async () => {
      order.push('redispatched');
      return { ...expiredClaim, id: 'c2', attempt: 4 };
    });

    await expireClaimsTick();

    expect(order).toEqual(['interactions-cancelled', 'redispatched']);
  });

  it('emits a Check Run for the replacement claim using its head SHA and installation', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'replacement-sha' },
    ]);
    redispatchClaim.mockResolvedValueOnce(
      { id: 'c2', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 4, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'replacement-sha' },
    );

    await expireClaimsTick();

    expect(installationCtxForRepo).toHaveBeenCalledWith('owner', 'repo');
    expect(getProvider).toHaveBeenCalledWith({ installation_id: 42 });
    expect(onClaimDispatched).toHaveBeenCalledWith(
      providerClient,
      { id: 'c2', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 4, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'replacement-sha', installation_id: 42 },
    );
  });

  it('does not resolve installation context or emit a Check Run when the replacement claim has no head SHA', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'expired-sha' },
    ]);
    redispatchClaim.mockResolvedValueOnce(
      { id: 'c2', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 4, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: null },
    );

    await expireClaimsTick();

    expect(installationCtxForRepo).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    expect(onClaimDispatched).not.toHaveBeenCalled();
  });

  it('does not create a provider or emit a Check Run when installation context is absent', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'replacement-sha' },
    ]);
    redispatchClaim.mockResolvedValueOnce(
      { id: 'c2', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 4, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'replacement-sha' },
    );
    installationCtxForRepo.mockResolvedValueOnce(undefined);

    await expireClaimsTick();

    expect(installationCtxForRepo).toHaveBeenCalledWith('owner', 'repo');
    expect(getProvider).not.toHaveBeenCalled();
    expect(onClaimDispatched).not.toHaveBeenCalled();
  });

  it('continues emitting Check Runs for later claims when an earlier redispatch fails', async () => {
    const firstExpiredClaim = { id: 'c1', org_id: 'o1', repo: 'owner/repo', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/first' }, head_sha: 'first-sha' };
    const secondExpiredClaim = { id: 'c2', org_id: 'o1', repo: 'owner/repo', pr_number: 2, attempt: 3, claim_type: 'review', payload: { branch: 'fix/second' }, head_sha: 'second-sha' };
    const replacementClaim = { id: 'c3', org_id: 'o1', repo: 'owner/repo', pr_number: 2, attempt: 4, claim_type: 'review', payload: { branch: 'fix/second' }, head_sha: 'second-sha' };
    expireClaims.mockResolvedValueOnce([firstExpiredClaim, secondExpiredClaim]);
    redispatchClaim
      .mockRejectedValueOnce(new Error('first redispatch failed'))
      .mockResolvedValueOnce(replacementClaim);

    await expireClaimsTick();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'Error re-dispatching expired claim',
        error: 'first redispatch failed',
        claimId: 'c1',
      }),
    );
    expect(redispatchClaim).toHaveBeenCalledTimes(2);
    expect(redispatchClaim).toHaveBeenNthCalledWith(2, secondExpiredClaim);
    expect(onClaimDispatched).toHaveBeenCalledWith(
      providerClient,
      { ...replacementClaim, installation_id: 42 },
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
});
