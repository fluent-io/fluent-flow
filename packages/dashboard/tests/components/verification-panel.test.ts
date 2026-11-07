import { describe, it, expect } from 'vitest';
import { getVerificationCardModel } from '../../src/components/pipelines/verification-panel-model';

const fortyA = 'a'.repeat(40);
const fortyB = 'b'.repeat(40);
const fortyC = 'c'.repeat(40);

describe('verification panel model', () => {
  it('normalizes requirement matrix rows, flakes, artifacts, and pinned hashes', () => {
    const model = getVerificationCardModel({
      id: 42,
      org_id: 'fluent-io',
      repo: 'fluent-io/fluent-flow',
      pr_number: 28,
      attempt: 4,
      session_id: 11,
      claim_type: 'verify',
      status: 'completed',
      payload: { phase: 'green' },
      claimed_at: null,
      completed_at: null,
      expires_at: null,
      created_at: new Date('2026-08-27T10:00:00Z'),
      agent_id: 'runner-1',
      session_meta: null,
      verification_result: {
        id: 99,
        org_id: 'fluent-io',
        claim_id: 42,
        repo: 'fluent-io/fluent-flow',
        pr_number: 28,
        phase: 'green',
        framework: 'vitest',
        outcome: 'PASS',
        matrix: {
          suite: { total: 12, passed: 11, failed: 1, flaky: 1, skipped: 0 },
          requirements: [
            {
              source_finding_id: 'F1',
              requirement: { id: 'REQ-1' },
              tests: [{ path: 'packages/app/tests/verify/login.red.test.js' }],
              status: 'pass',
              red: { status: 'fail' },
              green: { status: 'pass', flaky: true },
            },
          ],
          warnings: [{ path: 'packages/app/tests/legacy.test.js', status: 'skipped', reason: 'legacy skip' }],
          artifact: { red: fortyA, green: fortyB },
        },
        manifest: {},
        test_hashes: [{ path: 'packages/app/tests/verify/login.red.test.js', sha256: fortyC }],
        artifact_sha: fortyA,
        red_base_sha: fortyB,
        green_sha: fortyC,
        created_at: '2026-08-27T10:06:00.000Z',
      },
    });

    expect(model.phase).toBe('green');
    expect(model.suite).toEqual({ total: 12, passed: 11, failed: 1, flaky: 1, skipped: 0 });
    expect(model.requirements).toEqual([
      {
        finding: 'F1',
        requirement: 'REQ-1',
        tests: ['packages/app/tests/verify/login.red.test.js'],
        status: 'PASS',
        redStatus: 'FAIL',
        greenStatus: 'PASS',
        flaky: true,
      },
    ]);
    expect(model.flakes).toEqual([
      {
        label: 'REQ-1',
        detail: 'PASS',
        message: 'packages/app/tests/verify/login.red.test.js',
      },
    ]);
    expect(model.warnings).toEqual([
      {
        label: 'packages/app/tests/legacy.test.js',
        detail: 'SKIPPED',
        message: 'legacy skip',
      },
    ]);
    expect(model.artifacts.map((row) => row.label)).toEqual([
      'Artifact SHA',
      'Red base SHA',
      'Green SHA',
      'Red artifact',
      'Green artifact',
    ]);
    expect(model.hashes).toEqual([
      { label: 'packages/app/tests/verify/login.red.test.js', sha: fortyC },
    ]);
  });

  it('uses payload phase and red-shaped matrices without crashing when no result exists yet', () => {
    const model = getVerificationCardModel({
      id: 43,
      org_id: 'fluent-io',
      repo: 'fluent-io/fluent-flow',
      pr_number: 28,
      attempt: 4,
      session_id: null,
      claim_type: 'verify',
      status: 'pending',
      payload: { phase: 'red' },
      claimed_at: null,
      completed_at: null,
      expires_at: null,
      created_at: new Date('2026-08-27T10:00:00Z'),
      agent_id: null,
      session_meta: null,
      verification_result: null,
    });

    expect(model.phase).toBe('red');
    expect(model.requirements).toEqual([]);
    expect(model.artifacts).toEqual([]);
    expect(model.hashes).toEqual([]);
  });
});
