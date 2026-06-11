import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  expireClaims: vi.fn(),
  createClaim: vi.fn(),
}));

const mockInstallationCtxForRepo = vi.fn();
vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: (...a) => mockInstallationCtxForRepo(...a),
}));

const mockGetProvider = vi.fn();
vi.mock('../../src/providers/index.js', () => ({
  getProvider: (...a) => mockGetProvider(...a),
}));

const mockOnClaimDispatched = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/engine/check-run.js', () => ({
  onClaimDispatched: (...a) => mockOnClaimDispatched(...a),
}));

import logger from '../../src/logger.js';
import { expireClaims, createClaim } from '../../src/agents/claim-manager.js';
import { expireClaimsTick } from '../../src/workers/claim-expiry.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireClaims.mockResolvedValue([]);
  createClaim.mockResolvedValue({ id: 99, org_id: 'o1', repo: 'r/r', pr_number: 1, attempt: 2, claim_type: 'review' });
  mockInstallationCtxForRepo.mockResolvedValue({ installation_id: 555 });
  mockGetProvider.mockReturnValue({});
  mockOnClaimDispatched.mockResolvedValue(undefined);
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
      { id: 'c1', org_id: 'o1', agent_id: 'a1', repo: 'o/r', pr_number: 1, attempt: 1, claim_type: 'review', payload: {}, head_sha: null },
      { id: 'c2', org_id: 'o1', agent_id: 'a2', repo: 'o/r', pr_number: 2, attempt: 1, claim_type: 'review_fix', payload: {}, head_sha: null },
    ]);

    const result = await expireClaimsTick();

    expect(result).toEqual([
      { id: 'c1', org_id: 'o1', agent_id: 'a1', repo: 'o/r', pr_number: 1, attempt: 1, claim_type: 'review', payload: {}, head_sha: null },
      { id: 'c2', org_id: 'o1', agent_id: 'a2', repo: 'o/r', pr_number: 2, attempt: 1, claim_type: 'review_fix', payload: {}, head_sha: null },
    ]);
  });

  it('re-dispatches expired claims at attempt + 1', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: { branch: 'fix/x' }, head_sha: 'abc123' },
    ]);

    await expireClaimsTick();

    expect(createClaim).toHaveBeenCalledTimes(1);
    expect(createClaim).toHaveBeenCalledWith({
      orgId: 'o1',
      repo: 'o/r',
      prNumber: 1,
      attempt: 4,
      claimType: 'review',
      payload: { branch: 'fix/x' },
      headSha: 'abc123',
    });
  });

  it('skips re-dispatch when max retry attempts (10) exceeded', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 10, claim_type: 'review', payload: {}, head_sha: null },
    ]);

    await expireClaimsTick();

    expect(createClaim).not.toHaveBeenCalled();
  });

  it('emits onClaimDispatched for the re-dispatched claim when head_sha is present', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: {}, head_sha: 'abc123' },
    ]);
    createClaim.mockResolvedValueOnce({
      id: 'new-1',
      org_id: 'o1',
      repo: 'o/r',
      pr_number: 1,
      attempt: 4,
      claim_type: 'review',
      payload: {},
      head_sha: 'abc123',
    });

    await expireClaimsTick();

    expect(mockInstallationCtxForRepo).toHaveBeenCalledWith('o', 'r');
    expect(mockGetProvider).toHaveBeenCalledWith({ installation_id: 555 });
    expect(mockOnClaimDispatched).toHaveBeenCalledTimes(1);
    const [, claimArg] = mockOnClaimDispatched.mock.calls[0];
    expect(claimArg.id).toBe('new-1');
    expect(claimArg.head_sha).toBe('abc123');
    expect(claimArg.installation_id).toBe(555);
  });

  it('does not call onClaimDispatched when re-dispatched claim has no head_sha', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: {}, head_sha: null },
    ]);
    createClaim.mockResolvedValueOnce({
      id: 'new-1',
      org_id: 'o1',
      repo: 'o/r',
      pr_number: 1,
      attempt: 4,
      claim_type: 'review',
      payload: {},
      head_sha: null,
    });

    await expireClaimsTick();

    expect(mockOnClaimDispatched).not.toHaveBeenCalled();
  });

  it('skips onClaimDispatched when installation context is missing for the repo', async () => {
    expireClaims.mockResolvedValueOnce([
      { id: 'c1', org_id: 'o1', repo: 'o/r', pr_number: 1, attempt: 3, claim_type: 'review', payload: {}, head_sha: 'abc123' },
    ]);
    createClaim.mockResolvedValueOnce({
      id: 'new-1',
      org_id: 'o1',
      repo: 'o/r',
      pr_number: 1,
      attempt: 4,
      claim_type: 'review',
      payload: {},
      head_sha: 'abc123',
    });
    mockInstallationCtxForRepo.mockResolvedValueOnce(undefined);

    await expireClaimsTick();

    expect(mockOnClaimDispatched).not.toHaveBeenCalled();
  });
});
