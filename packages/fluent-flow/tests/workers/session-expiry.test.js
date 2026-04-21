import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/session-manager.js', () => ({
  expireSessions: vi.fn(),
}));

import logger from '../../src/logger.js';
import { expireSessions } from '../../src/agents/session-manager.js';
import { expireSessionsTick } from '../../src/workers/session-expiry.js';

beforeEach(() => {
  vi.clearAllMocks();
  expireSessions.mockResolvedValue([]);
});

describe('expireSessionsTick', () => {
  it('calls expireSessions() once', async () => {
    await expireSessionsTick();
    expect(expireSessions).toHaveBeenCalledTimes(1);
  });

  it('swallows errors and logs them so the loop keeps running', async () => {
    expireSessions.mockRejectedValueOnce(new Error('db down'));

    await expect(expireSessionsTick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('expireSessionsTick'),
        error: 'db down',
      }),
    );
  });

  it('propagates the rows returned by expireSessions for observability', async () => {
    expireSessions.mockResolvedValueOnce([
      { id: 's1', org_id: 'o1', agent_id: 'a1' },
      { id: 's2', org_id: 'o1', agent_id: 'a2' },
    ]);

    const result = await expireSessionsTick();

    expect(result).toEqual([
      { id: 's1', org_id: 'o1', agent_id: 'a1' },
      { id: 's2', org_id: 'o1', agent_id: 'a2' },
    ]);
  });
});
