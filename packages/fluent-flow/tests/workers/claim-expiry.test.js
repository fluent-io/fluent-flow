import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/claim-manager.js', () => ({
  expireClaims: vi.fn(),
}));

import logger from '../../src/logger.js';
import { expireClaims } from '../../src/agents/claim-manager.js';
import { expireClaimsTick } from '../../src/workers/claim-expiry.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireClaims.mockResolvedValue([]);
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
      { id: 'c1', org_id: 'o1', agent_id: 'a1' },
      { id: 'c2', org_id: 'o1', agent_id: 'a2' },
    ]);

    const result = await expireClaimsTick();

    expect(result).toEqual([
      { id: 'c1', org_id: 'o1', agent_id: 'a1' },
      { id: 'c2', org_id: 'o1', agent_id: 'a2' },
    ]);
  });
});
