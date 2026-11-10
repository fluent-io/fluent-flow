import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnrollmentQuery = vi.fn();
const mockTokenSelect = vi.fn();

vi.mock('../../../db/src/pool', () => ({
  getPool: () => ({ connect: vi.fn() }),
  query: (...args) => mockEnrollmentQuery(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  db: { select: (...args) => mockTokenSelect(...args) },
  schema: { agentTokens: {} },
  createToken: vi.fn(),
}));

import { createEnrollmentToken } from '../../../db/src/queries/tokens.ts';
import { validateToken } from '../../src/agents/token-manager.js';

describe('enrollment credential validation boundary', () => {
  beforeEach(() => {
    mockEnrollmentQuery.mockReset();
    mockTokenSelect.mockReset();
  });

  it('rejects an issued enrollment credential before a normal-token database lookup', async () => {
    mockEnrollmentQuery.mockResolvedValueOnce({ rows: [{ id: 301 }] });
    const enrollment = await createEnrollmentToken({
      orgId: 'fluent-io',
      agentId: 'portable-agent',
    });

    await expect(validateToken(enrollment.plaintext)).resolves.toBeNull();
    expect(mockTokenSelect).not.toHaveBeenCalled();
  });
});
