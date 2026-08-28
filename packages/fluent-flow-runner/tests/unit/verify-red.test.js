import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runVerifyClaim } from '../../src/verify.js';
import { WorktreeRefUnavailableError } from '../../src/worktree.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeWork(overrides = {}) {
  return {
    claim_id: 41,
    claim_type: 'verify',
    repo: 'fluent-io/fluent-flow',
    pr_number: 22,
    branch: 'feature/verify',
    agentType: 'claude-code',
    phase: 'red',
    red_base_sha: 'a'.repeat(40),
    verification: {
      framework: 'auto',
      authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 },
      flake: { retries: 2, blocking: false },
      timeouts_min: { red: 15, green: 30 },
    },
    findings: [],
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

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupRepo(root) {
  mkdirSync(join(root, 'packages', 'app', 'tests', 'helpers'), { recursive: true });
  writeJson(join(root, 'packages', 'app', 'package.json'), { name: 'app', type: 'module' });
  writeFileSync(join(root, 'packages', 'app', 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'packages', 'app', 'vitest.config.js'), 'export default {};\n');
  writeFileSync(join(root, 'packages', 'app', 'tests', 'helpers', 'setup.js'), 'export const setup = true;\n');
}

function makeManifest(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function makeVitestAdapter() {
  return {
    installCommand: vi.fn(() => ['npm', 'ci']),
    testCommand: vi.fn(({ files }) => ['vitest', '--run', ...(files ?? [])]),
    parseResults: vi.fn((json) => json.results),
  };
}

function makeExecuteForRed({
  worktreePath,
  manifestFactory,
  redRuns = [],
  statusOutput,
  artifactSha = '1'.repeat(40),
  gitExitCodes = {},
  installResults = [{ exitCode: 0, stdout: '' }],
}) {
  let authorIndex = 0;
  let redIndex = 0;
  let installIndex = 0;

  return vi.fn(async (cmd, commandCwd) => {
    if (cmd.bin === 'claude') {
      const attempt = manifestFactory(authorIndex++);
      const specPath = join(worktreePath, '.fluent-flow', 'verify', 'PR-22', 'red-41', 'spec.md');
      mkdirSync(dirname(specPath), { recursive: true });
      writeFileSync(specPath, '# Spec\n');
      writeJson(join(worktreePath, '.fluent-flow', 'verify', 'PR-22', 'red-41', 'manifest.json'), attempt.manifest);
      for (const file of attempt.createdFiles ?? []) {
        const abs = join(worktreePath, file);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `// ${file}\n`);
      }
      return { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) };
    }
    if (cmd.bin === 'npm' || cmd.bin === 'pnpm' || cmd.bin === 'yarn' || cmd.bin === 'python') {
      return installResults[installIndex++] ?? installResults.at(-1);
    }
    if (cmd.bin === 'vitest' || cmd.bin === 'jest') {
      const result = redRuns[redIndex++] ?? { results: [] };
      if (result.timedOut) {
        return { exitCode: result.exitCode ?? 124, stdout: result.stdout ?? '', timedOut: true };
      }
      return { exitCode: result.exitCode ?? 1, stdout: JSON.stringify(result) };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'status') {
      const defaultStatus = cmd.args.includes('--untracked-files=all')
        ? [
            '?? .fluent-flow/verify/PR-22/red-41/spec.md',
            '?? .fluent-flow/verify/PR-22/red-41/manifest.json',
            '?? packages/app/tests/verify/login.red.test.js',
          ].join('\n')
        : '?? .fluent-flow/\n?? packages/app/tests/verify/';
      return { exitCode: 0, stdout: statusOutput ?? defaultStatus };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'commit') {
      return { exitCode: gitExitCodes.commit ?? 0, stdout: '' };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'push') {
      return { exitCode: gitExitCodes.push ?? 0, stdout: '' };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'rev-parse') {
      return { exitCode: gitExitCodes.revParse ?? 0, stdout: `${artifactSha}\n` };
    }
    if (cmd.bin === 'git' && cmd.args[0] === 'add') {
      return { exitCode: gitExitCodes.add ?? 0, stdout: '' };
    }
    throw new Error(`Unexpected command: ${cmd.bin} ${(cmd.args ?? []).join(' ')}`);
  });
}

describe('runVerifyClaim red phase', () => {
  it('returns completed SKIPPED when the base ref is unavailable', async () => {
    const prepareWorktree = vi.fn().mockRejectedValue(
      new WorktreeRefUnavailableError('deadbeef', 'missing ref'),
    );

    const result = await runVerifyClaim(makeContext({
      prepareWorktree,
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: {
        phase: 'red',
        framework: 'none',
        outcome: 'SKIPPED',
        matrix: null,
        red_base_sha: 'a'.repeat(40),
      },
    });
  });

  it('returns completed SKIPPED when no supported framework is detected', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const cleanup = vi.fn().mockResolvedValue();
    const prepareWorktree = vi.fn().mockResolvedValue({ worktreePath, cleanup });
    const detectFramework = vi.fn().mockReturnValue(null);

    const result = await runVerifyClaim(makeContext({
      prepareWorktree,
      detectFramework,
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: {
        phase: 'red',
        framework: 'none',
        outcome: 'SKIPPED',
        matrix: null,
        red_base_sha: 'a'.repeat(40),
      },
    });
    expect(cleanup).toHaveBeenCalled();
  });

  it('classifies repeated identical install failures as terminal', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    setupRepo(redWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      installResults: [
        { exitCode: 1, stdout: 'lockfile is malformed' },
        { exitCode: 1, stdout: 'lockfile is malformed' },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn().mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(execute.mock.calls.filter(([cmd]) => cmd.bin === 'npm')).toHaveLength(2);
  });

  it('classifies repeated red suite timeouts as terminal', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    setupRepo(redWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { exitCode: 124, stdout: '', timedOut: true },
        { exitCode: 124, stdout: '', timedOut: true },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn().mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({
        findings: [{ id: 'F-1', blocking: true }],
        verification: {
          ...makeWork().verification,
          authoring: { ...makeWork().verification.authoring, retries: 0, red_reproductions: 2 },
        },
      }),
    }));

    expect(result).toEqual({ status: 'failed', failure_kind: 'terminal' });
    expect(execute.mock.calls.filter(([cmd]) => cmd.bin === 'vitest')).toHaveLength(2);
  });

  it('honors an explicitly configured framework instead of auto detection order', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const manifest = makeManifest({
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
    });
    const jestAdapter = {
      ...makeVitestAdapter(),
      detect: vi.fn(() => ({ id: 'jest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      testCommand: vi.fn(({ files }) => ['jest', '--json', ...(files ?? [])]),
    };
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest,
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });
    const autoDetect = vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') }));

    const result = await runVerifyClaim(makeContext({
      execute,
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      detectFramework: autoDetect,
      adapters: new Map([['jest', jestAdapter]]),
      work: makeWork({
        verification: { ...makeWork().verification, framework: 'jest' },
        findings: [{ id: 'F-1', blocking: true }],
      }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.framework).toBe('jest');
    expect(autoDetect).not.toHaveBeenCalled();
    expect(jestAdapter.detect).toHaveBeenCalledWith(redWorktree);
    expect(jestAdapter.testCommand).toHaveBeenCalledTimes(2);
  });

  it('skips custom red verification without invoking authoring or auto detection', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const cleanup = vi.fn().mockResolvedValue();
    const execute = vi.fn();
    const resolveCommand = vi.fn(() => ({ bin: 'claude', args: ['author'] }));
    const detectFramework = vi.fn(() => null);

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand,
      detectFramework,
      prepareWorktree: vi.fn().mockResolvedValue({ worktreePath, cleanup }),
      work: makeWork({
        verification: {
          ...makeWork().verification,
          framework: 'custom',
          command: ['pytest', '-q'],
          install_command: ['python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
        },
      }),
    }));

    expect(result.verification).toEqual(expect.objectContaining({
      phase: 'red',
      framework: 'custom',
      outcome: 'SKIPPED',
      matrix: null,
      red_base_sha: 'a'.repeat(40),
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(resolveCommand).not.toHaveBeenCalled();
    expect(detectFramework).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it('runs the happy red path with authored manifest, reproduced assertion failures, hashes, and artifact sha', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);

    const manifest = makeManifest();
    const adapter = makeVitestAdapter();
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest,
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });
    const prepareWorktree = vi.fn()
      .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
      .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() });
    const resolveCommand = vi.fn(() => ({ bin: 'claude', args: ['author'] }));
    const detectFramework = vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') }));
    const adapters = new Map([['vitest', adapter]]);

    const result = await runVerifyClaim(makeContext({
      execute,
      prepareWorktree,
      resolveCommand,
      detectFramework,
      adapters,
      work: makeWork({ findings: [{ id: 'F-1', blocking: true, severity: 'high' }] }),
    }));

    expect(result.status).toBe('completed');
    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.framework).toBe('vitest');
    expect(result.verification.manifest).toEqual(manifest);
    expect(result.verification.red_base_sha).toBe('a'.repeat(40));
    expect(result.verification.artifact_sha).toBe('1'.repeat(40));
    expect(result.verification.test_hashes.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'packages/app/tests/verify/login.red.test.js',
      'packages/app/tests/helpers/setup.js',
      'packages/app/package.json',
      'packages/app/package-lock.json',
      'packages/app/vitest.config.js',
    ]));
    expect(result.verification.matrix.requirements).toEqual([
      expect.objectContaining({
        id: 'REQ-1',
        source_finding_id: 'F-1',
        status: 'PASS',
      }),
    ]);
    expect(adapter.installCommand).toHaveBeenCalledWith(join(redWorktree, 'packages', 'app'), 'npm');
    expect(adapter.testCommand).toHaveBeenCalledTimes(2);
  });

  it('retries authoring when a requirement passes at the base commit', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const adapter = makeVitestAdapter();
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'pass', message: '' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });
    const resolveCommand = vi.fn(() => ({ bin: 'claude', args: ['author'] }));
    const prepareWorktree = vi.fn()
      .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
      .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand,
      prepareWorktree,
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', adapter]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(resolveCommand).toHaveBeenCalledTimes(2);
  });

  it('retries authoring when a red run returns suite errors', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'setup', status: 'suite-error', message: 'SyntaxError' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });
    const resolveCommand = vi.fn(() => ({ bin: 'claude', args: ['author'] }));

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand,
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(resolveCommand).toHaveBeenCalledTimes(2);
  });

  it('fails completed when a blocking finding is not mapped to any requirement', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    setupRepo(redWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest({
          requirements: [{
            requirement: {
              id: 'REQ-1',
              form: 'when',
              text: 'When login is invalid, the request fails.',
            },
            tests: ['packages/app/tests/verify/login.red.test.js'],
            dependency_files: [],
            framework: 'vitest',
          }],
        }),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn().mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'red',
        framework: 'vitest',
        outcome: 'FAIL',
      }),
    });
  });

  it('rejects out-of-scope modifications during the added-files-only assertion', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
      statusOutput: 'M  src/app.js\nA  packages/app/tests/verify/login.red.test.js',
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('FAIL');
  });

  it('rejects modifications to existing test files that were not prior red artifacts', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
      statusOutput: 'M  packages/app/tests/verify/login.red.test.js',
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('FAIL');
  });

  it('reconciles a prior crashed red manifest by deleting superseded test files', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const priorManifest = makeManifest({
      requirements: [{
        requirement: {
          id: 'REQ-1',
          form: 'when',
          text: 'When login is invalid, the request fails.',
          source_finding_id: 'F-1',
        },
        tests: ['packages/app/tests/verify/old.red.test.js'],
        dependency_files: [],
        framework: 'vitest',
      }],
    });
    mkdirSync(dirname(join(pushWorktree, 'packages', 'app', 'tests', 'verify', 'old.red.test.js')), { recursive: true });
    writeFileSync(join(pushWorktree, 'packages', 'app', 'tests', 'verify', 'old.red.test.js'), '// old\n');

    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
      statusOutput: [
        'M  .fluent-flow/verify/PR-22/red-41/spec.md',
        'M  .fluent-flow/verify/PR-22/red-41/manifest.json',
        'D  packages/app/tests/verify/old.red.test.js',
        'A  packages/app/tests/verify/login.red.test.js',
      ].join('\n'),
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({
        findings: [{ id: 'F-1', blocking: true }],
        prior_red_records: [{
          phase: 'red',
          framework: 'vitest',
          manifest: priorManifest,
          test_hashes: [{ path: 'packages/app/tests/verify/old.red.test.js', sha256: 'old' }],
        }],
      }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(existsSync(join(pushWorktree, 'packages', 'app', 'tests', 'verify', 'old.red.test.js'))).toBe(false);
    expect(readFileSync(join(pushWorktree, 'packages', 'app', 'tests', 'verify', 'login.red.test.js'), 'utf8')).toContain('login.red.test.js');
  });

  it('does not trust sibling manifests to delete non-test files on the PR branch', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    mkdirSync(join(pushWorktree, 'src'), { recursive: true });
    mkdirSync(join(pushWorktree, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(pushWorktree, 'src', 'app.js'), 'export const app = true;\n');
    writeFileSync(join(pushWorktree, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    writeJson(join(pushWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-40', 'manifest.json'), makeManifest({
      requirements: [{
        requirement: {
          id: 'REQ-1',
          form: 'when',
          text: 'When login is invalid, the request fails.',
          source_finding_id: 'F-1',
        },
        tests: ['src/app.js', '.github/workflows/ci.yml'],
        dependency_files: [],
        framework: 'vitest',
      }],
    }));

    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(existsSync(join(pushWorktree, 'src', 'app.js'))).toBe(true);
    expect(existsSync(join(pushWorktree, '.github', 'workflows', 'ci.yml'))).toBe(true);
  });

  it('does not trust sibling manifests to delete existing in-scope tests', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    mkdirSync(join(pushWorktree, 'packages', 'app', 'tests', 'unit'), { recursive: true });
    writeFileSync(join(pushWorktree, 'packages', 'app', 'tests', 'unit', 'auth.test.js'), 'it("auth", () => {});\n');
    writeJson(join(pushWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-40', 'manifest.json'), makeManifest({
      requirements: [{
        requirement: {
          id: 'REQ-1',
          form: 'when',
          text: 'When login is invalid, the request fails.',
          source_finding_id: 'F-1',
        },
        tests: ['packages/app/tests/unit/auth.test.js'],
        dependency_files: [],
        framework: 'vitest',
      }],
    }));

    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('PASS');
    expect(existsSync(join(pushWorktree, 'packages', 'app', 'tests', 'unit', 'auth.test.js'))).toBe(true);
  });

  it('skips unreadable sibling manifests instead of wedging red publication', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const malformedManifestPath = join(pushWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-40', 'manifest.json');
    mkdirSync(dirname(malformedManifestPath), { recursive: true });
    writeFileSync(malformedManifestPath, '{\n');

    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result.verification.outcome).toBe('PASS');
  });

  it('uses a [skip ci] commit message for red artifacts', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
    });

    await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    const commitCall = execute.mock.calls.find(([cmd]) => cmd.bin === 'git' && cmd.args[0] === 'commit');
    expect(commitCall[0].args.join(' ')).toContain('[skip ci]');
  });

  it('fails the claim transiently when local git publication setup exits non-zero', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
      gitExitCodes: { add: 1 },
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result).toEqual({ status: 'failed', failure_kind: 'transient' });
  });

  it('skips red verification when the red artifact push cannot publish to the PR branch', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    const pushWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-push-'));
    setupRepo(redWorktree);
    setupRepo(pushWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest(),
        createdFiles: ['packages/app/tests/verify/login.red.test.js'],
      }),
      redRuns: [
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
        { results: [{ file: 'packages/app/tests/verify/login.red.test.js', name: 'REQ-1', status: 'assertion-fail', message: 'expected failure' }] },
      ],
      gitExitCodes: { push: 1 },
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn()
        .mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() })
        .mockResolvedValueOnce({ worktreePath: pushWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'red',
        framework: 'vitest',
        outcome: 'SKIPPED',
        red_base_sha: 'a'.repeat(40),
      }),
    });
  });

  it('retries malformed manifests and fails deterministically when authoring never produces a valid manifest', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    setupRepo(redWorktree);
    const execute = vi.fn(async (cmd) => {
      if (cmd.bin === 'claude') {
        const manifestPath = join(redWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-41', 'manifest.json');
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(join(redWorktree, '.fluent-flow', 'verify', 'PR-22', 'red-41', 'spec.md'), '# Spec\n');
        writeFileSync(manifestPath, '{\n');
        return { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) };
      }
      throw new Error(`Unexpected command: ${cmd.bin}`);
    });
    const resolveCommand = vi.fn(() => ({ bin: 'claude', args: ['author'] }));

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand,
      prepareWorktree: vi.fn().mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(resolveCommand).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'red',
        framework: 'vitest',
        outcome: 'FAIL',
      }),
    });
  });

  it('fails deterministically when manifest test paths escape the allowed test scopes', async () => {
    const redWorktree = mkdtempSync(join(tmpdir(), 'ff-verify-red-'));
    setupRepo(redWorktree);
    const execute = makeExecuteForRed({
      worktreePath: redWorktree,
      manifestFactory: () => ({
        manifest: makeManifest({
          requirements: [{
            requirement: {
              id: 'REQ-1',
              form: 'when',
              text: 'When login is invalid, the request fails.',
              source_finding_id: 'F-1',
            },
            tests: ['packages/app/src/leak.js'],
            dependency_files: [],
            framework: 'vitest',
          }],
        }),
        createdFiles: ['packages/app/src/leak.js'],
      }),
    });

    const result = await runVerifyClaim(makeContext({
      execute,
      resolveCommand: vi.fn(() => ({ bin: 'claude', args: ['author'] })),
      prepareWorktree: vi.fn().mockResolvedValueOnce({ worktreePath: redWorktree, cleanup: vi.fn().mockResolvedValue() }),
      detectFramework: vi.fn(() => ({ id: 'vitest', packageManager: 'npm', root: join(redWorktree, 'packages', 'app') })),
      adapters: new Map([['vitest', makeVitestAdapter()]]),
      work: makeWork({ findings: [{ id: 'F-1', blocking: true }] }),
    }));

    expect(result).toEqual({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'red',
        framework: 'vitest',
        outcome: 'FAIL',
      }),
    });
  });
});
