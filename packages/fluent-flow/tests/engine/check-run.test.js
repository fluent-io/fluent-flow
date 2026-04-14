import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));

import {
  onClaimDispatched,
  onClaimStarted,
  onClaimResolved,
} from '../../src/engine/check-run.js';

function makeProviderClient() {
  return {
    createCheckRun: vi.fn().mockResolvedValue({ id: 42 }),
    updateCheckRun: vi.fn().mockResolvedValue(undefined),
  };
}

const baseClaim = {
  id: 1,
  repo: 'acme/myrepo',
  pr_number: 5,
  claim_type: 'review',
  check_run_external_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onClaimDispatched', () => {
  it('calls client.createCheckRun with status queued and stores the id', async () => {
    const client = makeProviderClient();
    const claim = { ...baseClaim, head_sha: 'abc123' };

    const result = await onClaimDispatched(client, claim);

    expect(client.createCheckRun).toHaveBeenCalledOnce();
    const [, input] = client.createCheckRun.mock.calls[0];
    expect(input).toMatchObject({ status: 'queued', head_sha: 'abc123' });
    expect(input.name).toMatch(/review/i);
    expect(result.check_run_external_id).toBe(42);
  });
});

describe('onClaimStarted', () => {
  it('calls client.updateCheckRun with status in_progress', async () => {
    const client = makeProviderClient();
    const claim = { ...baseClaim, check_run_external_id: 42 };

    await onClaimStarted(client, claim);

    expect(client.updateCheckRun).toHaveBeenCalledOnce();
    const [, , input] = client.updateCheckRun.mock.calls[0];
    expect(input).toMatchObject({ status: 'in_progress' });
  });

  it('is a no-op if no check_run_external_id', async () => {
    const client = makeProviderClient();
    await onClaimStarted(client, baseClaim);
    expect(client.updateCheckRun).not.toHaveBeenCalled();
  });
});

describe('onClaimResolved', () => {
  it('calls client.updateCheckRun with status completed and conclusion success', async () => {
    const client = makeProviderClient();
    const claim = { ...baseClaim, check_run_external_id: 42 };

    await onClaimResolved(client, claim, { conclusion: 'success' });

    expect(client.updateCheckRun).toHaveBeenCalledOnce();
    const [, , input] = client.updateCheckRun.mock.calls[0];
    expect(input).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('is a no-op if no check_run_external_id', async () => {
    const client = makeProviderClient();
    await onClaimResolved(client, baseClaim, { conclusion: 'success' });
    expect(client.updateCheckRun).not.toHaveBeenCalled();
  });
});
