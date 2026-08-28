import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runVerifyClaim } from '../../src/verify.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupRepo(root) {
  mkdirSync(join(root, 'packages', 'app', 'tests', 'helpers'), { recursive: true });
  mkdirSync(join(root, 'packages', 'app', 'tests', 'verify'), { recursive: true });
  mkdirSync(join(root, 'packages', 'app', 'tests', 'integration'), { recursive: true });
  writeFileSync(join(root, 'packages', 'app', 'package.json'), '{"name":"app","type":"module"}\n');
  writeFileSync(join(root, 'packages', 'app', 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'packages', 'app', 'vitest.config.js'), 'export default {};\n');
  writeFileSync(join(root, 'packages', 'app', 'tests', 'helpers', 'setup.js'), 'export const setup = true;\n');
  writeFileSync(join(root, 'packages', 'app', 'tests', 'verify', 'login.red.test.js'), 'it("login", () => {});\n');
}

function hashFile(root, rel) {
  const contents = readFileSync(join(root, rel));
  return createHash('sha256').update(contents).digest('hex');
}

function makeWork(overrides = {}) {
  return {
    claim_id: 51,
    claim_type: 'verify',
    repo: 'fluent-io/fluent-flow',
    pr_number: 22,
    branch: 'feature/verify',
    head_sha: 'b'.repeat(40),
    green_sha: 'b'.repeat(40),
    agentType: 'claude-code',
    phase: 'green',
    verification: {
      framework: 'auto',
      authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 },
      flake: { retries: 1, blocking: false },
      timeouts_min: { red: 15, green: 30 },
    },
    red_record: null,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    work: makeWork(),
    log: makeLogger(),
    execute: vi.fn(),
    client: { heartbeat: vi.fn() },
    sessionId: 1,
    cwd: '/repo',
    resolveCommand: vi.fn(),
    ...overrides,
  };
}

function makeAdapter() {
  return {
    installCommand: vi.fn(() => ['npm', 'ci']),
    testCommand: vi.fn(({ files }) => ['vitest', '--run', ...(files ?? [])]),
    parseResults: vi.fn((json) => json.results),
  };
}

function buildRedRecord(root, overrides = {}) {
  const manifest = overrides.manifest ?? {
    pr_number: 22,
    requirements: [{
      requirement: {
        id: 'REQ-1',
        form: 'when',
        text: 'When login is invalid, the request fails.',
        source_finding_id: 'F-1',
      },
      tests: ['packages/app/tests/verify/login.red.test.js'],
      dependency_files: ['packages/app/tests/helpers/setup.js'],
      framework: 'vitest',
    }],
  };
  const base = {
    phase: 'red',
    framework: 'vitest',
    outcome: 'PASS',
    manifest,
    test_hashes: [
      { path: 'packages/app/tests/verify/login.red.test.js', sha256: hashFile(root, 'packages/app/tests/verify/login.red.test.js') },
      { path: 'packages/app/tests/helpers/setup.js', sha256: hashFile(root, 'packages/app/tests/helpers/setup.js') },
      { path: 'packages/app/package.json', sha256: hashFile(root, 'packages/app/package.json') },
      { path: 'packages/app/package-lock.json', sha256: hashFile(root, 'packages/app/package-lock.json') },
      { path: 'packages/app/vitest.config.js', sha256: hashFile(root, 'packages/app/vitest.config.js') },
    ],
    artifact_sha: '1'.repeat(40),
    red_base_sha: 'a'.repeat(40),
    matrix: {
      requirements: [{ id: 'REQ-1', source_finding_id: 'F-1', status: 'PASS' }],
      suite: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 },
      schema_version: 1,
    },
  };
  return { ...base, ...overrides, manifest };
}

function makeExecuteForGreen({ pinnedRuns = [], fullRuns = [], diffOutput = '', gitExitCode = 0, catFileExitCode = 0, installResults = [{ exitCode: 0, stdout: '' }] }) {
  let pinnedIndex = 0;
  let fullIndex = 0;
  let installIndex = 0;
  return vi.fn(async (cmd) => {
    if (cmd.bin === 'npm' || cmd.bin === 'pnpm' || cmd.bin === 'yarn' || cmd.bin === 'python') return installResults[installIndex++] ?? installResults.at(-1);
    if (cmd.bin === 'git' && cmd.args[0] === 'cat-file') {
      return { exitCode: catFileExitCode, stdout: '' };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'diff') {
      return { exitCode: gitExitCode, stdout: diffOutput };
    }
    if (cmd.bin === 'vitest' || cmd.bin === 'jest') {
      const isPinned = cmd.args.some((arg) => arg.includes('login.red.test.js'));
      const payload = isPinned
        ? (pinnedRuns[pinnedIndex] ?? pinnedRuns.at(-1) ?? { results: [] })
        : (fullRuns[fullIndex] ?? fullRuns.at(-1) ?? { results: [] });
      if (isPinned) pinnedIndex++;
      else fullIndex++;
      if (payload.timedOut) {
        return { exitCode: payload.exitCode ?? 124, stdout: payload.stdout ?? '', timedOut: true };
      }
      return { exitCode: payload.exitCode ?? 0, stdout: JSON.stringify(payload) };
    }
    throw new Error(`Unexpected command: ${cmd.bin}`);
  });
}

describe('runVerifyClaim green phase', () => {
  it('returns TAMPERED when any red-record file hash mismatches or is missing', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);
    writeFileSync(join(greenWorktree, 'packages', 'app', 'package.json'), '{"name":"tampered"}\n');

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({}),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'green',
        framework: 'vitest',
        outcome: 'TAMPERED',
      }),
    });
  });

  it('returns TAMPERED for missing mandatory framework config before framework detection', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);
    rmSync(join(greenWorktree, 'packages', 'app', 'vitest.config.js'));
    const detectFramework = vi.fn(() => null);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({}),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework,
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
    expect(detectFramework).not.toHaveBeenCalled();
  });

  it('returns TAMPERED when green adds files inside protected test scopes', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({ diffOutput: 'A\tpackages/app/tests/verify/bypass.test.js' }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
  });

  it('returns TAMPERED when green adds mandatory adapter config files', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({ diffOutput: 'A\tpackages/app/vitest.config.mjs' }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
  });

  it('returns TAMPERED when green modifies unpinned files inside protected test scopes', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    writeFileSync(join(greenWorktree, 'packages', 'app', 'tests', 'helpers', 'unpinned.js'), 'export const ok = true;\n');
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({ diffOutput: 'M\tpackages/app/tests/helpers/unpinned.js' }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
  });

  it('returns TAMPERED when green renames files into protected test scopes', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({ diffOutput: 'R100\tpackages/app/src/old.js\tpackages/app/tests/verify/renamed.test.js' }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
  });

  it('returns TAMPERED instead of transient when the red artifact commit is unreachable', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({ catFileExitCode: 1 }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('TAMPERED');
  });

  it('classifies repeated identical green install failures as terminal', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);
    const execute = makeExecuteForGreen({
      installResults: [
        { exitCode: 1, stdout: 'lockfile is malformed' },
        { exitCode: 1, stdout: 'lockfile is malformed' },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute,
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(execute.mock.calls.filter(([cmd]) => cmd.bin === 'npm')).toHaveLength(2);
  });

  it('classifies repeated pinned suite timeouts as terminal', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);
    const execute = makeExecuteForGreen({
      pinnedRuns: [
        { exitCode: 124, stdout: '', timedOut: true },
        { exitCode: 124, stdout: '', timedOut: true },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute,
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(execute.mock.calls.filter(([cmd]) => cmd.bin === 'vitest')).toHaveLength(2);
  });

  it('runs custom green command with a degraded suite matrix', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const execute = vi.fn(async (cmd) => {
      if (cmd.bin === 'python') return { exitCode: 0, stdout: '' };
      if (cmd.bin === 'pytest') return { exitCode: 0, stdout: 'passed\n' };
      throw new Error(`Unexpected command: ${cmd.bin}`);
    });

    const result = await runVerifyClaim(makeContext({
      work: makeWork({
        verification: {
          ...makeWork().verification,
          framework: 'custom',
          command: ['pytest', '-q'],
          install_command: ['python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
        },
        red_record: {
          phase: 'red',
          framework: 'custom',
          outcome: 'SKIPPED',
          test_hashes: [],
          red_base_sha: 'a'.repeat(40),
        },
      }),
      execute,
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
    }));

    expect(execute).toHaveBeenNthCalledWith(
      1,
      { bin: 'python', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] },
      greenWorktree,
      30 * 60_000,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { bin: 'pytest', args: ['-q'] },
      greenWorktree,
      30 * 60_000,
    );
    expect(result).toEqual({
      status: 'completed',
      verification: {
        phase: 'green',
        framework: 'custom',
        outcome: 'PASS',
        matrix: {
          requirements: [],
          suite: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 },
          schema_version: 1,
        },
        red_base_sha: 'a'.repeat(40),
        green_sha: 'b'.repeat(40),
      },
    });
  });

  it('detects the package root with the red-record framework adapter', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree, {
      framework: 'jest',
      manifest: {
        pr_number: 22,
        requirements: [{
          requirement: {
            id: 'REQ-1',
            form: 'when',
            text: 'When login is invalid, the request fails.',
            source_finding_id: 'F-1',
          },
          tests: ['packages/app/tests/verify/login.red.test.js'],
          dependency_files: ['packages/app/tests/helpers/setup.js'],
          framework: 'jest',
        }],
      },
    });
    const jestAdapter = {
      ...makeAdapter(),
      detect: vi.fn(() => ({ id: 'jest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      testCommand: vi.fn(({ files }) => ['jest', '--json', ...(files ?? [])]),
    };
    const autoDetect = vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') }));

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: autoDetect,
      adapters: new Map([['jest', jestAdapter]]),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.framework).toBe('jest');
    expect(autoDetect).not.toHaveBeenCalled();
    expect(jestAdapter.detect).toHaveBeenCalledWith(greenWorktree);
  });

  it('uses payload.red_record as the source of truth and does not read branch verify artifacts', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    mkdirSync(join(greenWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-41'), { recursive: true });
    writeFileSync(join(greenWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-41', 'manifest.json'), '{\n');
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('PASS');
  });

  it('treats skipped or missing pinned tests as requirement failures', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'skip', message: '' }] }],
        fullRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('FAIL');
    expect(result.verification.matrix.requirements[0].status).toBe('FAIL');
  });

  it('keeps newly pinned test flakes blocking even when a retry passes', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [
          { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'flaky' }] },
          { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] },
        ],
        fullRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('FAIL');
    expect(result.verification.matrix.requirements[0].green.flaky).toBe(true);
  });

  it('treats a pre-existing full-suite flake as non-blocking when retries clear it and flake.blocking is false', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [
          { results: [{ file: 'packages/app/tests/integration/legacy.test.js', name: 'legacy', status: 'assertion-fail', message: 'flake' }] },
          { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] },
        ],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.matrix.suite.flaky).toBe(1);
  });

  it('treats a pre-existing full-suite flake as blocking when flake.blocking is true', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({
        red_record: redRecord,
        verification: { flake: { retries: 1, blocking: true } },
      }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [
          { results: [{ file: 'packages/app/tests/integration/legacy.test.js', name: 'legacy', status: 'assertion-fail', message: 'flake' }] },
          { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] },
        ],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('FAIL');
    expect(result.verification.matrix.suite.flaky).toBe(1);
  });

  it('downgrades orphan full-suite failures outside the manifest to warnings', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [{ results: [{ file: 'packages/app/tests/integration/orphan.test.js', name: 'orphan', status: 'assertion-fail', message: 'legacy fail' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.matrix.requirements[0].status).toBe('PASS');
    expect(result.verification.matrix.warnings).toEqual([
      expect.objectContaining({ file: 'packages/app/tests/integration/orphan.test.js' }),
    ]);
  });

  it('returns a PASS matrix with finding, requirement, test, red/green, suite totals, and artifact links', async () => {
    const greenWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-green-'));
    setupRepo(greenWorktree);
    const redRecord = buildRedRecord(greenWorktree);

    const result = await runVerifyClaim(makeContext({
      work: makeWork({ red_record: redRecord }),
      execute: makeExecuteForGreen({
        pinnedRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
        fullRuns: [{ results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] }],
      }),
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath: greenWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(greenWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeAdapter()]]),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.matrix).toEqual(expect.objectContaining({
      requirements: [
        expect.objectContaining({
          id: 'REQ-1',
          source_finding_id: 'F-1',
          status: 'PASS',
          tests: ['packages/app/tests/verify/login.red.test.js'],
          red: expect.any(Object),
          green: expect.objectContaining({ status: 'PASS' }),
        }),
      ],
      suite: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 },
      artifact: { red: '1'.repeat(40), green: 'b'.repeat(40) },
    }));
  });
});
