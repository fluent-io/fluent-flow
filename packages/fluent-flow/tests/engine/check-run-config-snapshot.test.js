import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/db/repo-configs.js', () => ({
  resolveRepoConfig: vi.fn(),
}));

import { resolveRepoConfig } from '../../src/db/repo-configs.js';
import { onClaimResolved } from '../../src/engine/check-run.js';

const mockConfig = {
  default_agent: 'getonit',
  claim_types: ['review', 'review_fix'],
  review_model: 'claude-opus-4-6',
  paused: false,
};

function makeClient() {
  return {
    updateCheckRun: vi.fn().mockResolvedValue(undefined),
  };
}

const claim = {
  id: 1,
  repo: 'acme/demo',
  pr_number: 5,
  claim_type: 'review',
  check_run_external_id: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveRepoConfig.mockResolvedValue(mockConfig);
});

describe('onClaimResolved config snapshot in output.text', () => {
  it('includes a fenced code block with config fields in output.text', async () => {
    const client = makeClient();
    await onClaimResolved(client, claim, { conclusion: 'success' });

    expect(client.updateCheckRun).toHaveBeenCalledOnce();
    const [, , input] = client.updateCheckRun.mock.calls[0];

    expect(input.output).toBeDefined();
    expect(input.output.text).toContain('default_agent');
    expect(input.output.text).toContain('getonit');
    expect(input.output.text).toContain('claim_types');
    expect(input.output.text).toContain('review_model');
    expect(input.output.text).toContain('claude-opus-4-6');
    // Should be in a fenced code block
    expect(input.output.text).toMatch(/```/);
  });

  it('resolves config for the claim repo', async () => {
    const client = makeClient();
    await onClaimResolved(client, claim, { conclusion: 'failure' });

    expect(resolveRepoConfig).toHaveBeenCalledWith('acme/demo');
  });

  it('still completes even if resolveRepoConfig fails', async () => {
    resolveRepoConfig.mockRejectedValue(new Error('db down'));
    const client = makeClient();
    await onClaimResolved(client, claim, { conclusion: 'failure' });

    // Should still call updateCheckRun, just without output.text
    expect(client.updateCheckRun).toHaveBeenCalledOnce();
  });
});
