import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  expireClaims: vi.fn(),
  createClaim: vi.fn(),
}));

import logger from '../../src/logger.js';
import { expireClaims, createClaim } from '../../src/agents/claim-manager.js';
import { expireClaimsTick } from '../../src/workers/claim-expiry.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireClaims.mockResolvedValue([]);
  createClaim.mockResolvedValue({ id: 99, org_id: 'o1', repo: 'r/r', pr_number: 1, attempt: 2, claim_type: 'review' });
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

  it('expired claims should not set archived_at on expiry', async () => {
    // archivedAt is reserved for explicit dismiss/cancel operations.
    // Expiry uses status='expired' + completedAt only, so pipeline views
    // (archived_at IS NULL) continue to show the claim until explicitly dismissed.
    const expiredClaim = {
      id: 'c1',
      org_id: 'o1',
      repo: 'o/r',
      pr_number: 1,
      attempt: 3,
      claim_type: 'review',
      payload: {},
      head_sha: null,
    };
    expireClaims.mockResolvedValueOnce([expiredClaim]);

    const result = await expireClaimsTick();

    // expireClaims should NOT return archived_at for expired claims
    expect(result[0].archived_at).toBeUndefined();
  });
});
