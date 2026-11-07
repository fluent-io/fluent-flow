import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertedClaims = [];
const transaction = {
  order: [],
  stagedClaims: [],
  committedClaims: [],
  linkCopies: [],
  parentLinked: false,
  rootClaimId: null,
  failLink: false,
};
const transactionClient = {
  query: vi.fn(async (text, params) => {
    const sql = String(text);
    if (/^BEGIN$/i.test(sql)) {
      transaction.order.push('BEGIN');
      return { rows: [] };
    }
    if (/INSERT\s+INTO\s+collab_claim_executions/i.test(sql)) {
      transaction.order.push('COPY_LINK');
      if (transaction.failLink) throw new Error('injected link copy failure');
      if (transaction.parentLinked) {
        transaction.linkCopies.push({
          parentClaimId: params.find((value) => value === SPEC_CLAIM.id),
          childClaimId: params.find((value) => value !== SPEC_CLAIM.id),
          rootClaimId: transaction.rootClaimId,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql)) {
      transaction.order.push('COMMIT');
      transaction.committedClaims.push(...transaction.stagedClaims);
      transaction.stagedClaims.length = 0;
      return { rows: [] };
    }
    if (/^ROLLBACK$/i.test(sql)) {
      transaction.order.push('ROLLBACK');
      transaction.stagedClaims.length = 0;
      transaction.linkCopies.length = 0;
      return { rows: [] };
    }
    return { rows: [] };
  }),
  release: vi.fn(),
};
const transactionPool = { connect: vi.fn(async () => transactionClient) };

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
  const insertPendingClaim = vi.fn(async (claim, executor) => {
    insertedClaims.push(claim);
    const row = {
      id: 100 + insertedClaims.length,
      org_id: claim.orgId,
      repo: claim.repo,
      pr_number: claim.prNumber,
      attempt: claim.attempt,
      session_id: null,
      claim_type: claim.claimType,
      status: 'pending',
      payload: claim.payload,
      head_sha: claim.headSha ?? null,
    };
    if (executor === transactionClient) transaction.stagedClaims.push(row);
    else transaction.committedClaims.push(row);
    return row;
  });

  return {
    db: { insert },
    schema: real.schema,
    insertPendingClaim,
    getPool: vi.fn(() => transactionPool),
  };
});

vi.mock('../../src/agents/claim-manager.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    assertClaimOwner: vi.fn(),
    withClaimOwner: vi.fn(),
    completeClaim: vi.fn(),
    failClaim: vi.fn(),
    getClaimByAttempt: vi.fn(),
    getClaimById: vi.fn(),
    completeClaimById: vi.fn(),
    failClaimById: vi.fn(),
    cancelClaimById: vi.fn(),
    extendClaim: vi.fn(),
    redispatchClaim: vi.fn(),
  };
});

import { insertPendingClaim } from '@fluent-flow/db';
import logger from '../../src/logger.js';
import { assertClaimOwner, completeClaimById } from '../../src/agents/claim-manager.js';
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
  return { body: { session_id: 3, ...body }, tokenInfo: { org_id: 'org-1', agent_id: 'agent-1' } };
}

const REVIEW_CLAIM = {
  id: 41,
  org_id: 'org-1',
  repo: 'acme/widgets',
  pr_number: 17,
  attempt: 3,
  session_id: 3,
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
  session_id: 3,
  claim_type: 'spec',
  payload: { auto_chain: true },
  head_sha: 'spec-head-sha',
  status: 'completed',
};

beforeEach(() => {
  vi.clearAllMocks();
  assertClaimOwner.mockResolvedValue({ id: 41, org_id: 'org-1', session_id: 3, status: 'claimed' });
  insertedClaims.length = 0;
  transaction.order.length = 0;
  transaction.stagedClaims.length = 0;
  transaction.committedClaims.length = 0;
  transaction.linkCopies.length = 0;
  transaction.parentLinked = false;
  transaction.rootClaimId = null;
  transaction.failLink = false;
});

describe('handleClaimResult auto-chain head SHA persistence', () => {
  it('leaves review-fix creation to the review-result coordinator', async () => {
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

    expect(insertedClaims).toEqual([]);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, claim_id: 41, status: 'completed' });
  });

  it('preserves the completed spec head SHA while allocating the next build attempt', async () => {
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
        claimType: 'build',
        headSha: 'spec-head-sha',
      }),
    ]);
    expect(insertedClaims[0]).not.toHaveProperty('attempt');
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, claim_id: 52, status: 'completed' });
  });

  it('copies a linked spec execution to the build exactly once in the same transaction', async () => {
    transaction.parentLinked = true;
    transaction.rootClaimId = 700;
    completeClaimById.mockResolvedValueOnce(SPEC_CLAIM);

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        claim_id: SPEC_CLAIM.id,
        repo: SPEC_CLAIM.repo,
        pr_number: SPEC_CLAIM.pr_number,
        attempt: SPEC_CLAIM.attempt,
      }),
      makeResponse(),
    );

    expect(insertPendingClaim).toHaveBeenCalledOnce();
    expect(insertPendingClaim.mock.calls[0][1]).toBe(transactionClient);
    expect(transaction.linkCopies).toEqual([{
      parentClaimId: SPEC_CLAIM.id,
      childClaimId: expect.any(Number),
      rootClaimId: 700,
    }]);
    expect(transaction.order).toEqual(['BEGIN', 'COPY_LINK', 'COMMIT']);
    expect(transaction.committedClaims).toHaveLength(1);
    expect(transactionClient.release).toHaveBeenCalledOnce();
  });

  it('keeps an unlinked spec chain working without creating a link', async () => {
    completeClaimById.mockResolvedValueOnce(SPEC_CLAIM);

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        claim_id: SPEC_CLAIM.id,
        repo: SPEC_CLAIM.repo,
        pr_number: SPEC_CLAIM.pr_number,
        attempt: SPEC_CLAIM.attempt,
      }),
      makeResponse(),
    );

    expect(transaction.linkCopies).toEqual([]);
    expect(transaction.order).toEqual(['BEGIN', 'COPY_LINK', 'COMMIT']);
    expect(transaction.committedClaims).toHaveLength(1);
  });

  it('rolls back the build insert when copying its execution link fails', async () => {
    transaction.parentLinked = true;
    transaction.rootClaimId = 700;
    transaction.failLink = true;
    completeClaimById.mockResolvedValueOnce(SPEC_CLAIM);
    const response = makeResponse();

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        claim_id: SPEC_CLAIM.id,
        repo: SPEC_CLAIM.repo,
        pr_number: SPEC_CLAIM.pr_number,
        attempt: SPEC_CLAIM.attempt,
      }),
      response,
    );

    expect(transaction.order).toEqual(['BEGIN', 'COPY_LINK', 'ROLLBACK']);
    expect(transaction.committedClaims).toEqual([]);
    expect(transaction.stagedClaims).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Failed to create follow-on build claim',
      safeToContinue: true,
    }));
    expect(response.body).toEqual({ ok: true, claim_id: SPEC_CLAIM.id, status: 'completed' });
  });

  it('keeps review completion out of the follow-on claim transaction', async () => {
    completeClaimById.mockResolvedValueOnce(REVIEW_CLAIM);

    await handleClaimResult(
      makeRequest({
        status: 'completed',
        claim_id: REVIEW_CLAIM.id,
        repo: REVIEW_CLAIM.repo,
        pr_number: REVIEW_CLAIM.pr_number,
        attempt: REVIEW_CLAIM.attempt,
        verdict: 'fail',
      }),
      makeResponse(),
    );

    expect(insertPendingClaim).not.toHaveBeenCalled();
    expect(transactionPool.connect).not.toHaveBeenCalled();
    expect(transaction.linkCopies).toEqual([]);
    expect(transaction.committedClaims).toHaveLength(0);
  });
});
