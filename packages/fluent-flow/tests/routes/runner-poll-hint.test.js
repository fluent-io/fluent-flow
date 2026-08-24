import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

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
}));

vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  hasPending: vi.fn(),
  dequeue: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();
  return {
    db: { execute: vi.fn() },
    schema: real.schema,
  };
});

import { db } from '@fluent-flow/db';
import { sql } from 'drizzle-orm';
import { hasPending, dequeue } from '../../src/notifications/transports/long-poll.js';
import { handlePoll } from '../../src/routes/runner.js';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

const REQ = { body: { session_id: 3 }, tokenInfo: { org_id: 'o1', agent_id: 'a1' }, on: vi.fn() };

const DB_CLAIM = {
  id: 7,
  repo: 'o/r',
  pr_number: 5,
  attempt: 2,
  claim_type: 'review_fix',
  status: 'claimed',
  payload: { message: 'fix it', branch: 'fix/x' },
};

beforeEach(() => {
  vi.clearAllMocks();
  // db.execute call order in handlePoll: (1) agent_type SELECT, (2) claimPendingWork UPDATE.
  db.execute.mockImplementation(async () => ({ rows: [{ agent_type: 'claude-code' }] }));
});

describe('handlePoll — long-poll hints are wake-up signals only', () => {
  it('drains a queued hint and answers with the DB claim row, never the hint payload', async () => {
    hasPending.mockReturnValueOnce(true);
    dequeue.mockReturnValueOnce({ agentId: 'a1', event: 'review', repo: 'o/r', prNumber: 5, session_id: 3 });

    db.execute
      .mockResolvedValueOnce({ rows: [{ agent_type: 'claude-code' }] })   // agent type lookup
      .mockResolvedValueOnce({ rows: [DB_CLAIM] });                        // claimPendingWork

    const res = makeRes();
    await handlePoll({ ...REQ, on: vi.fn() }, res, { pollTimeoutMs: 0 });

    expect(dequeue).toHaveBeenCalledTimes(1);
    expect(res.body.work).toMatchObject({
      claim_id: 7,
      repo: 'o/r',
      pr_number: 5,
      attempt: 2,
      claim_type: 'review_fix',
      agentType: 'claude-code',
      message: 'fix it',
    });
    // The response must be a reportable DB claim — the hint payload had no
    // attempt/claim_type and would have been unreportable by the runner.
    expect(res.body.work.attempt).toBe(2);
  });

  it('falls through to work:null when a hint wakes the runner but nothing is claimable', async () => {
    hasPending.mockReturnValueOnce(true);
    dequeue.mockReturnValueOnce({ agentId: 'a1', event: 'review' });

    db.execute
      .mockResolvedValueOnce({ rows: [{ agent_type: 'claude-code' }] })
      .mockResolvedValueOnce({ rows: [] }); // no claimable work

    const res = makeRes();
    await handlePoll({ ...REQ, on: vi.fn() }, res, { pollTimeoutMs: 0 });

    expect(res.body).toEqual({ work: null });
  });
});
