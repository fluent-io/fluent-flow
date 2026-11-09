import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeWork, runVerifyClaim } from '../../src/verify.js';

const PROMPT_LIMIT_BYTES = 131072;

function verification(overrides = {}) {
  return normalizeWork({ verification: overrides }).verification;
}

function baseWork(overrides = {}) {
  return {
    claim_id: 41,
    claim_type: 'verify',
    repo: 'fluent-io/fluent-flow',
    pr_number: 22,
    branch: 'feature/verify',
    agentType: 'claude-code',
    phase: 'red',
    red_base_sha: 'a'.repeat(40),
    findings: [],
    ...overrides,
  };
}

describe('claim-supplied verification bounds', () => {
  it('keeps in-range values unchanged', () => {
    const result = verification({
      timeouts_min: { red: 20, green: 45 },
      authoring: { retries: 3, max_requirements: 40, red_reproductions: 4 },
      flake: { retries: 5 },
    });

    expect(result.timeouts_min).toEqual({ red: 20, green: 45 });
    expect(result.authoring).toEqual({ retries: 3, max_requirements: 40, red_reproductions: 4 });
    expect(result.flake.retries).toBe(5);
  });

  it.each([
    [{ timeouts_min: { red: 0, green: 0 } }, 'timeouts_min', { red: 1, green: 1 }],
    [{ timeouts_min: { red: -5, green: -1 } }, 'timeouts_min', { red: 1, green: 1 }],
    [{ timeouts_min: { red: 100000, green: 1e12 } }, 'timeouts_min', { red: 1440, green: 1440 }],
    [{ authoring: { retries: -1, max_requirements: 0, red_reproductions: 0 } }, 'authoring', { retries: 0, max_requirements: 1, red_reproductions: 1 }],
    [{ authoring: { retries: 1e9, max_requirements: 1e6, red_reproductions: 500 } }, 'authoring', { retries: 10, max_requirements: 100, red_reproductions: 10 }],
  ])('clamps out-of-range %j without throwing', (claimed, key, expected) => {
    expect(verification(claimed)[key]).toMatchObject(expected);
  });

  it.each([[-3, 0], [99, 10], [1e9, 10]])('clamps flake retries %s to %s', (claimed, expected) => {
    expect(verification({ flake: { retries: claimed } }).flake.retries).toBe(expected);
  });

  it.each(['5', null, Number.NaN, Number.POSITIVE_INFINITY, {}, [], true])(
    'falls back to defaults for the non-number %j',
    (claimed) => {
      const result = verification({
        timeouts_min: { red: claimed, green: claimed },
        authoring: { retries: claimed, max_requirements: claimed, red_reproductions: claimed },
        flake: { retries: claimed },
      });

      expect(result.timeouts_min).toEqual({ red: 15, green: 30 });
      expect(result.authoring).toEqual({ retries: 2, max_requirements: 25, red_reproductions: 2 });
      expect(result.flake.retries).toBe(2);
    },
  );

  it('truncates fractional values toward the integer bound', () => {
    expect(verification({ authoring: { retries: 2.9 } }).authoring.retries).toBe(2);
  });

  it('ignores non-object groups instead of spreading them', () => {
    const result = verification({ timeouts_min: 'abc', authoring: 7, flake: ['x'] });

    expect(result.timeouts_min).toEqual({ red: 15, green: 30 });
    expect(result.authoring).toEqual({ retries: 2, max_requirements: 25, red_reproductions: 2 });
    expect(result.flake.retries).toBe(2);
  });

  it('bounds the authoring attempts a claim can demand', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-verify-bounds-'));
    mkdirSync(join(worktreePath, 'packages', 'app'), { recursive: true });
    const author = vi.fn(async () => {
      const dir = join(worktreePath, '.fluent-flow', 'verify', 'PR-22', 'red-41');
      mkdirSync(dirname(join(dir, 'manifest.json')), { recursive: true });
      writeFileSync(join(dir, 'spec.md'), '# Spec\n');
      writeFileSync(join(dir, 'manifest.json'), '{\n');
    });
    const adapter = {
      installCommand: vi.fn(() => ['npm', 'ci']),
      testCommand: vi.fn(() => ['vitest']),
      parseResults: vi.fn(() => []),
    };

    await runVerifyClaim({
      work: baseWork({ verification: { authoring: { retries: 1e9 } } }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      execute: vi.fn(async () => ({ exitCode: 0, stdout: '' })),
      author,
      cwd: '/repo',
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(worktreePath, 'packages', 'app') })),
      adapters: new Map([['vitest', adapter]]),
    });

    expect(author).toHaveBeenCalledTimes(11);
  });
});

describe('verify authoring prompt cap', () => {
  function oversizedWork(overrides = {}) {
    return baseWork({ pr_body: 'x'.repeat(PROMPT_LIMIT_BYTES + 1), ...overrides });
  }

  it('fails terminally before a worktree exists when the authoring prompt exceeds 131072 bytes', async () => {
    const prepareWorktree = vi.fn();
    const author = vi.fn();
    const onPromptTooLarge = vi.fn();

    const result = await runVerifyClaim({
      work: oversizedWork(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      execute: vi.fn(),
      author,
      cwd: '/repo',
      prepareWorktree,
      onPromptTooLarge,
    });

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(prepareWorktree).not.toHaveBeenCalled();
    expect(author).not.toHaveBeenCalled();
    expect(onPromptTooLarge).toHaveBeenCalledTimes(1);
    expect(onPromptTooLarge).toHaveBeenCalledWith({
      promptBytes: expect.any(Number),
      limitBytes: PROMPT_LIMIT_BYTES,
    });
    expect(onPromptTooLarge.mock.calls[0][0].promptBytes).toBeGreaterThan(PROMPT_LIMIT_BYTES);
  });

  it('measures UTF-8 bytes rather than characters', async () => {
    const prepareWorktree = vi.fn();

    const result = await runVerifyClaim({
      work: baseWork({ pr_body: 'é'.repeat(PROMPT_LIMIT_BYTES / 2 + 1) }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      execute: vi.fn(),
      author: vi.fn(),
      cwd: '/repo',
      prepareWorktree,
    });

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(prepareWorktree).not.toHaveBeenCalled();
  });
});
