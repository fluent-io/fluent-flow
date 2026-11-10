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
import { handleRegister } from '../../src/routes/agent-server.js';

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

describe('agent server capability registration', () => {
  it('preserves supported claim types with the agent server metadata', async () => {
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

  it('accepts the metadata the agent server sends', async () => {
    registerSession.mockResolvedValue({ id: 8, status: 'online' });
    const meta = {
      runtime: 'agent-server',
      instance_id: '0b2f6a5c-1111-4222-8333-444455556666',
      slot_id: 1,
      capacity: 2,
      version: '0.2.0',
      provider: 'claude-code',
      deployment: 'hosted',
      hostname: 'agent-1',
      os: 'linux',
      supported_claim_types: ['spec', 'build', 'review', 'review_fix', 'test_verify', 'verify'],
    };
    const res = response();

    await handleRegister({ body: { meta }, tokenInfo: { org_id: 'o1', agent_id: 'a1' } }, res);

    expect(registerSession).toHaveBeenCalledWith('o1', 'a1', meta);
    expect(res.statusCode).toBe(200);
  });

  it('accepts a missing meta object as empty metadata', async () => {
    registerSession.mockResolvedValue({ id: 9, status: 'online' });
    const res = response();

    await handleRegister({ body: {}, tokenInfo: { org_id: 'o1', agent_id: 'a1' } }, res);

    expect(registerSession).toHaveBeenCalledWith('o1', 'a1', {});
    expect(res.statusCode).toBe(200);
  });

  it('accepts a legacy cwd within its limit and small unknown keys', async () => {
    registerSession.mockResolvedValue({ id: 10, status: 'online' });
    const res = response();

    await handleRegister({
      body: { meta: { cwd: 'c'.repeat(1024), extra: { nested: true } } },
      tokenInfo: { org_id: 'o1', agent_id: 'a1' },
    }, res);

    expect(res.statusCode).toBe(200);
  });

  describe('metadata validation', () => {
    const tooLongText = 'x'.repeat(257);

    it.each([
      ['null meta', null],
      ['an array', []],
      ['a string', 'runtime'],
      ['a number', 7],
      ['an oversized runtime', { runtime: tooLongText }],
      ['an oversized instance id', { instance_id: tooLongText }],
      ['an oversized hostname', { hostname: tooLongText }],
      ['an oversized os', { os: tooLongText }],
      ['an oversized version', { version: tooLongText }],
      ['an oversized provider', { provider: tooLongText }],
      ['an oversized deployment', { deployment: tooLongText }],
      ['a non-string runtime', { runtime: 7 }],
      ['a negative slot', { slot_id: -1 }],
      ['a slot above 1023', { slot_id: 1024 }],
      ['a fractional slot', { slot_id: 1.5 }],
      ['a string slot', { slot_id: '1' }],
      ['zero capacity', { capacity: 0 }],
      ['capacity above 16', { capacity: 17 }],
      ['fractional capacity', { capacity: 2.5 }],
      ['more than 32 claim types', { supported_claim_types: Array.from({ length: 33 }, (_, index) => `t${index}`) }],
      ['an oversized claim type', { supported_claim_types: ['y'.repeat(65)] }],
      ['a non-string claim type', { supported_claim_types: [1] }],
      ['claim types that are not an array', { supported_claim_types: 'verify' }],
      ['an oversized cwd', { cwd: 'c'.repeat(1025) }],
      ['a non-string cwd', { cwd: { path: '/' } }],
      ['unknown keys over 4096 bytes', { extra: 'z'.repeat(4100) }],
      ['many unknown keys over 4096 bytes in total', Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key${index}`, 'v'.repeat(100)]))],
    ])('rejects %s with 400 and does not register', async (_label, meta) => {
      const res = response();

      await handleRegister({ body: { meta }, tokenInfo: { org_id: 'o1', agent_id: 'a1' } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid session metadata' });
      expect(registerSession).not.toHaveBeenCalled();
    });

    it.each([
      ['slot 0', { slot_id: 0 }],
      ['slot 1023', { slot_id: 1023 }],
      ['capacity 1', { capacity: 1 }],
      ['capacity 16', { capacity: 16 }],
      ['256-char strings', { runtime: 'r'.repeat(256), hostname: 'h'.repeat(256) }],
      ['32 claim types of 64 chars', { supported_claim_types: Array.from({ length: 32 }, () => 't'.repeat(64)) }],
    ])('accepts %s', async (_label, meta) => {
      registerSession.mockResolvedValue({ id: 11, status: 'online' });
      const res = response();

      await handleRegister({ body: { meta }, tokenInfo: { org_id: 'o1', agent_id: 'a1' } }, res);

      expect(res.statusCode).toBe(200);
      expect(registerSession).toHaveBeenCalledWith('o1', 'a1', meta);
    });
  });
});
