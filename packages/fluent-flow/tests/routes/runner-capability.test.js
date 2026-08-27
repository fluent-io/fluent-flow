import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/agents/session-manager.js', () => ({
  touchSession: vi.fn().mockResolvedValue(true),
  registerSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
  completeClaimById: vi.fn(),
  failClaimById: vi.fn(),
  getClaimById: vi.fn(),
  getClaimByAttempt: vi.fn(),
  createClaim: vi.fn(),
  redispatchClaim: vi.fn(),
  nextChainAttempt: vi.fn(),
  countCompletedFixIterations: vi.fn(),
  createClaimWithRetry: vi.fn(),
}));

vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  hasPending: vi.fn().mockReturnValue(false),
  dequeue: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock('../../src/engine/check-run.js', () => ({
  onClaimStarted: vi.fn(),
  onClaimResolved: vi.fn(),
  renderMatrixSummary: vi.fn(),
}));

vi.mock('../../src/providers/index.js', () => ({
  getProvider: vi.fn(() => ({ provider: 'github' })),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    db: { execute: vi.fn() },
  };
});

import { db } from '@fluent-flow/db';
import { sql } from 'drizzle-orm';
import { registerSession } from '../../src/agents/session-manager.js';
import { handleRegister, handlePoll } from '../../src/routes/runner.js';
import { onClaimStarted } from '../../src/engine/check-run.js';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

const TOKEN_INFO = { org_id: 'o1', agent_id: 'a1' };

const VERIFY_CLAIM = {
  id: 11,
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'verify',
  status: 'claimed',
  payload: { message: 'verify this' },
  installation_id: 99,
};

const REVIEW_CLAIM = {
  id: 12,
  repo: 'o/r',
  pr_number: 5,
  attempt: 3,
  claim_type: 'review_fix',
  status: 'claimed',
  payload: { message: 'fix this' },
  installation_id: 99,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleRegister — supported claim types', () => {
  it('preserves supported_claim_types in session meta while keeping other meta', async () => {
    registerSession.mockResolvedValueOnce({ id: 7, status: 'online' });
    const res = makeRes();

    await handleRegister({
      body: {
        meta: {
          supported_claim_types: ['review', 'review_fix'],
          runner_version: '1.2.3',
        },
      },
      tokenInfo: TOKEN_INFO,
    }, res);

    expect(registerSession).toHaveBeenCalledWith('o1', 'a1', {
      supported_claim_types: ['review', 'review_fix'],
      runner_version: '1.2.3',
    });
    expect(res.body).toEqual({ ok: true, session_id: 7, status: 'online' });
  });
});

describe('handlePoll — capability negotiation', () => {
  it('supports review/review_fix runners and skips pending verify claims', async () => {
    db.execute
      .mockResolvedValueOnce({ rows: [{ agent_type: 'claude-code' }] })
      .mockResolvedValueOnce({ rows: [{ session_meta: { supported_claim_types: ['review', 'review_fix'] } }] })
      .mockResolvedValueOnce({ rows: [REVIEW_CLAIM] });

    const res = makeRes();
    await handlePoll({
      body: { session_id: 3 },
      tokenInfo: TOKEN_INFO,
      on: vi.fn(),
    }, res);

    expect(res.body.work).toMatchObject({
      claim_id: 12,
      claim_type: 'review_fix',
      repo: 'o/r',
      pr_number: 5,
      attempt: 3,
    });
    expect(onClaimStarted).toHaveBeenCalledTimes(1);
    expect(onClaimStarted).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ id: 12 }));
    const claimQuery = db.execute.mock.calls[2][0];
    const claimQueryJson = JSON.stringify(claimQuery);
    expect(claimQueryJson).toContain('claim_type = ANY');
    expect(claimQueryJson).toContain('review');
    expect(claimQueryJson).toContain('review_fix');
    expect(claimQueryJson).not.toContain('verify');
  });

  it('legacy runners without supported_claim_types do not claim verify work', async () => {
    db.execute
      .mockResolvedValueOnce({ rows: [{ agent_type: 'claude-code' }] })
      .mockResolvedValueOnce({ rows: [{ session_meta: {} }] })
      .mockResolvedValueOnce({ rows: [REVIEW_CLAIM] });

    const res = makeRes();
    await handlePoll({
      body: { session_id: 3 },
      tokenInfo: TOKEN_INFO,
      on: vi.fn(),
    }, res);

    expect(res.body.work.claim_id).toBe(12);
    expect(res.body.work.claim_type).toBe('review_fix');
    const claimQuery = db.execute.mock.calls[2][0];
    const claimTypes = claimQuery.queryChunks.find(Array.isArray);
    expect(JSON.stringify(claimQuery)).toContain('claim_type = ANY');
    expect(claimTypes).toEqual(expect.arrayContaining(['review', 'review_fix']));
    expect(claimTypes).not.toContain('verify');
  });
});
