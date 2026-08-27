import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('@fluent-flow/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
  schema: { agentClaims: {} },
}));

vi.mock('../../src/providers/enqueue.js', () => ({
  enqueueProviderAction: vi.fn().mockResolvedValue({ id: 1234 }),
}));

vi.mock('../../src/providers/github/rest.js', () => ({
  createCheckRunDirect: vi.fn(),
}));

import { onClaimDispatched, renderMatrixSummary } from '../../src/engine/check-run.js';
import { db } from '@fluent-flow/db';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Task 7 check-run plumbing', () => {
  it('dispatching a verify claim creates the check run synchronously and stores the GitHub id', async () => {
    const client = {
      createCheckRun: vi.fn().mockResolvedValue({ id: 111 }),
      createCheckRunSync: vi.fn().mockResolvedValue({ id: 222 }),
      updateCheckRun: vi.fn(),
    };
    const claim = { id: 9, repo: 'acme/demo', head_sha: 'abc', claim_type: 'verify' };

    const result = await onClaimDispatched(client, claim);

    expect(client.createCheckRunSync).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'demo' },
      expect.objectContaining({ name: 'Fluent Flow — verify', head_sha: 'abc', status: 'queued' }),
      expect.objectContaining({ claim_id: 9 }),
    );
    expect(client.createCheckRun).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
    expect(result.check_run_external_id).toBe(222);
  });

  it('non-verify dispatch still uses queued createCheckRun', async () => {
    const client = {
      createCheckRun: vi.fn().mockResolvedValue({ id: 333 }),
      createCheckRunSync: vi.fn(),
      updateCheckRun: vi.fn(),
    };
    const claim = { id: 10, repo: 'acme/demo', head_sha: 'abc', claim_type: 'review' };

    await onClaimDispatched(client, claim);

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    expect(client.createCheckRunSync).not.toHaveBeenCalled();
  });

  it('renderMatrixSummary sanitizes output and caps annotations', () => {
    const verification = {
      matrix: {
        requirements: Array.from({ length: 55 }, (_, i) => ({
          id: `REQ-${i + 1}`,
          status: 'FAIL',
          title: `\u001b[31mWHEN cart empty ${i}\u001b[0m x-access-token:abc123@github.com`,
          file: `tests/req-${i + 1}.test.js`,
          message: `\u0007bad ${'x'.repeat(220)}`,
        })),
        suite: { total: 55, passed: 10, failed: 40, flaky: 0, skipped: 5 },
      },
      outcome: 'FAIL',
    };

    const output = renderMatrixSummary(verification);

    expect(output).toMatchObject({
      title: expect.any(String),
      summary: expect.any(String),
      annotations: expect.any(Array),
    });
    expect(output.summary).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(output.summary).not.toMatch(/[\x00-\x1f]/);
    expect(output.summary).toContain('x-access-token:***@');
    expect(output.annotations).toHaveLength(50);
    expect(output.annotations[0].path).toBe('tests/req-1.test.js');
    expect(output.annotations.every((a) => !a.path.startsWith('/') && !a.path.includes('..'))).toBe(true);
    expect(output.annotations.every((a) => a.message.length <= 200)).toBe(true);
    expect(output.annotations.every((a) => a.annotation_level === 'failure')).toBe(true);
  });

  it('renderMatrixSummary preserves suite totals and outcome notes while capping individual lines', () => {
    const verification = {
      outcome: 'SKIPPED',
      matrix: {
        requirements: [{
          id: 'REQ-9',
          status: 'FAIL',
          title: `\u001b[32m${'long title '.repeat(20)}\u001b[0m`,
          file: '/abs/path/to/tests/req-9.test.js',
          message: `\u001b[31m${'m'.repeat(400)}\u001b[0m`,
        }],
        suite: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 1 },
      },
    };

    const output = renderMatrixSummary(verification);

    expect(output.summary).toContain('REQ-9');
    expect(output.summary).toContain('Suite totals: 0 passed, 1 failed, 1 skipped, 0 flaky of 1.');
    expect(output.summary).toContain('SKIPPED: verification was skipped.');
    expect(output.summary).not.toContain('\u001b[');
    expect(output.annotations).toHaveLength(0);
  });

});
