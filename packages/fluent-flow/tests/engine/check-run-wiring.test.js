import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/db/outbound-queue.js', () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 99, kind: 'create_check_run' }),
}));
vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('tok'),
}));
vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
}));

import { enqueue } from '../../src/db/outbound-queue.js';
import { query } from '../../src/db/client.js';
import { getProvider } from '../../src/providers/index.js';
import { onClaimDispatched, onClaimResolved } from '../../src/engine/check-run.js';

const repo = { installation_id: 42, provider: 'github' };
const claim = {
  id: 1,
  repo: 'acme/demo',
  pr_number: 5,
  claim_type: 'review',
  head_sha: 'abc123',
  check_run_external_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ id: 99 });
  query.mockResolvedValue({ rows: [] });
});

describe('onClaimDispatched integrates with queued provider', () => {
  it('enqueues a create_check_run action through the provider', async () => {
    const client = getProvider(repo);
    const result = await onClaimDispatched(client, claim);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        installation_id: 42,
        kind: 'create_check_run',
        payload: expect.objectContaining({
          head_sha: 'abc123',
          status: 'queued',
        }),
      })
    );

    // Should store the queue row id on the claim
    expect(result.check_run_external_id).toBe(99);
  });
});

describe('onClaimResolved integrates with queued provider', () => {
  it('enqueues an update_check_run action through the provider', async () => {
    const claimWithId = { ...claim, check_run_external_id: 99 };
    const client = getProvider(repo);
    await onClaimResolved(client, claimWithId, { conclusion: 'success' });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'update_check_run',
        payload: expect.objectContaining({
          status: 'completed',
          conclusion: 'success',
        }),
      })
    );
  });
});
