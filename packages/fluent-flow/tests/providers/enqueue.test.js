import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/db/outbound-queue.js', () => ({
  enqueue: vi.fn(),
}));
vi.mock('../../src/providers/github/rest.js', () => ({
  postComment: vi.fn(),
  getPR: vi.fn(),
  getLinkedPR: vi.fn(),
}));
vi.mock('../../src/providers/github/graphql.js', () => ({
  getRepoInfo: vi.fn(),
}));
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
}));
vi.mock('../../src/providers/github/check-run.js', () => ({
  createCheckRunDirect: vi.fn(),
  updateCheckRunDirect: vi.fn(),
}));

import { enqueue } from '../../src/db/outbound-queue.js';
import { getProvider } from '../../src/providers/index.js';

const mockEnqueueRow = { id: 1, client_ref: 'claim-1:comment:abc' };

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue(mockEnqueueRow);
  // Ensure fetch is not called in these tests
  global.fetch = vi.fn().mockRejectedValue(new Error('fetch should not be called'));
});

describe('getProvider write operations go through outbound queue', () => {
  const repo = { installation_id: 42, provider: 'github' };
  const repoArg = { owner: 'acme', repo: 'demo' };

  it('postComment enqueues with kind=comment and returns immediately', async () => {
    const client = getProvider(repo);
    const result = await client.postComment(repoArg, 5, 'hello world', { claim_id: 1 });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        installation_id: 42,
        kind: 'comment',
        payload: expect.objectContaining({ body: 'hello world' }),
        client_ref: expect.stringContaining('comment'),
      })
    );
    // Should return immediately — no fetch
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toEqual(mockEnqueueRow);
  });

  it('postReview enqueues with kind=review', async () => {
    const client = getProvider(repo);
    await client.postReview(repoArg, 5, { event: 'APPROVE', body: 'lgtm' }, { claim_id: 2 });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'review', installation_id: 42 })
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('createCheckRun enqueues with kind=create_check_run', async () => {
    const client = getProvider(repo);
    await client.createCheckRun(repoArg, { name: 'Fluent Flow', head_sha: 'abc', status: 'queued' }, { claim_id: 3 });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'create_check_run' })
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('updateCheckRun enqueues with kind=update_check_run', async () => {
    const client = getProvider(repo);
    await client.updateCheckRun(repoArg, 99, { status: 'completed', conclusion: 'success' }, { claim_id: 4 });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'update_check_run' })
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('getPR (read) does NOT enqueue — calls rest directly', async () => {
    const { getPR } = await import('../../src/providers/github/rest.js');
    getPR.mockResolvedValue({ number: 5 });

    const client = getProvider(repo);
    await client.getPR(repoArg, 5);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
