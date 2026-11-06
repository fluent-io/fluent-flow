import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertedClaims = [];

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: vi.fn(),
}));

vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  dequeue: vi.fn(),
  hasPending: vi.fn(),
}));

vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  installationCtxForRepo: vi.fn(),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => {
  const real = await importOriginal();
  const returning = vi.fn().mockImplementation(async () => [{
    id: 100 + insertedClaims.length,
    ...insertedClaims.at(-1),
  }]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockImplementation((claim) => {
    insertedClaims.push(claim);
    return { onConflictDoNothing };
  });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { insert },
    schema: real.schema,
  };
});

vi.mock('../../src/agents/claim-manager.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    completeClaim: vi.fn(),
    failClaim: vi.fn(),
    getClaimByAttempt: vi.fn(),
    getClaimById: vi.fn(),
    completeClaimById: vi.fn(),
    failClaimById: vi.fn(),
    extendClaim: vi.fn(),
    redispatchClaim: vi.fn(),
  };
});

import { completeClaimById } from '../../src/agents/claim-manager.js';
import { handleClaimResult } from '../../src/routes/runner.js';

function makeResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

function makeRequest(body) {
  return { body, tokenInfo: { org_id: 'org-1', agent_id: 'agent-1' } };
}

const REVIEW_CLAIM = {
  id: 41,
  org_id: 'org-1',
  repo: 'acme/widgets',
  pr_number: 17,
  attempt: 3,
  claim_type: 'review',
  payload: { branch: 'feature/widgets' },
  head_sha: 'review-head-sha',
  status: 'completed',
};

const SPEC_CLAIM = {
  id: 52,
  org_id: 'org-1',
  repo: 'acme/widgets',
  pr_number: 17,
  attempt: 6,
  claim_type: 'spec',
  payload: { auto_chain: true },
  head_sha: 'spec-head-sha',
  status: 'completed',
};

beforeEach(() => {
  vi.clearAllMocks();
  insertedClaims.length = 0;
});

describe('handleClaimResult auto-chain head SHA persistence', () => {
  it('persists the completed review head SHA on the next review_fix claim', async () => {
    completeClaimById.mockResolvedValueOnce(REVIEW_CLAIM);
    const response = makeResponse();

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        repo: 'untrusted/request-repo',
        pr_number: 999,
        attempt: 90,
        claim_id: REVIEW_CLAIM.id,
        verdict: 'fail',
      }),
      response,
    );

    expect(insertedClaims).toEqual([
      expect.objectContaining({
        orgId: 'org-1',
        repo: 'acme/widgets',
        prNumber: 17,
        attempt: 4,
        claimType: 'review_fix',
        headSha: 'review-head-sha',
      }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, claim_id: 41, status: 'completed' });
  });

  it('persists the completed spec head SHA on the next build claim', async () => {
    completeClaimById.mockResolvedValueOnce(SPEC_CLAIM);
    const response = makeResponse();

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        repo: 'untrusted/request-repo',
        pr_number: 999,
        attempt: 90,
        claim_id: SPEC_CLAIM.id,
      }),
      response,
    );

    expect(insertedClaims).toEqual([
      expect.objectContaining({
        orgId: 'org-1',
        repo: 'acme/widgets',
        prNumber: 17,
        attempt: 7,
        claimType: 'build',
        headSha: 'spec-head-sha',
      }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, claim_id: 52, status: 'completed' });
  });
});
