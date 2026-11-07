import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  assertClaimOwner: vi.fn(),
  assertClaimReporter: vi.fn(),
  cancelClaimById: vi.fn(),
  completeClaimById: vi.fn(),
  createFollowOnClaim: vi.fn(),
  extendClaim: vi.fn(),
  failClaimById: vi.fn(),
  getClaimById: vi.fn(),
  redispatchClaim: vi.fn(),
  withClaimOwner: vi.fn(),
}));

import { registerSession } from '../../src/agents/session-manager.js';
import { handleRegister } from '../../src/routes/runner.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runner capability registration', () => {
  it('preserves supported claim types with the runner metadata', async () => {
    registerSession.mockResolvedValue({ id: 7, status: 'online' });
    const res = response();

    await handleRegister({
      body: {
        meta: {
          supported_claim_types: ['review', 'review_fix', 'verify'],
          runner_version: '1.2.3',
        },
      },
      tokenInfo: { org_id: 'o1', agent_id: 'a1' },
    }, res);

    expect(registerSession).toHaveBeenCalledWith('o1', 'a1', {
      supported_claim_types: ['review', 'review_fix', 'verify'],
      runner_version: '1.2.3',
    });
    expect(res.body).toEqual({ ok: true, session_id: 7, status: 'online' });
  });
});
