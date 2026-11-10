import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promptSizeViolation, resolvePrompt } from './prompts.js';
import { assertSafeRelPath, containsRealPath, sha256File } from './verify-paths.js';
import { detectFramework as detectFrameworkDefault, adapters as adapterRegistryDefault } from './verify-adapters/index.js';
import { prepareWorktree as prepareWorktreeDefault, WorktreeRefUnavailableError } from './worktree.js';

const DEFAULT_CONFIG = {
  authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 },
  flake: { retries: 2, blocking: false },
  timeouts_min: { red: 15, green: 30 },
};

const BOUNDS = {
  timeouts_min: { red: [1, 1440], green: [1, 1440] },
  authoring: { retries: [0, 10], max_requirements: [1, 100], red_reproductions: [1, 10] },
  flake: { retries: [0, 10] },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const EARS_FORMS = new Set(['when', 'while', 'if', 'where', 'ubiquitous']);
const FRAMEWORK_CONFIG_FILES = {
  vitest: ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.ts'],
  jest: ['jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.ts'],
  node: [],
};
const LOCKFILE_BY_PM = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
};

function boundedGroup(group, claimed, defaults) {
  const source = isPlainObject(claimed) ? claimed : {};
  const result = { ...defaults, ...source };
  for (const [name, [min, max]] of Object.entries(BOUNDS[group])) {
    const value = source[name];
    result[name] = typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.trunc(value)))
      : defaults[name];
  }
  return result;
}

export function normalizeWork(work) {
  const payload = work?.payload && typeof work.payload === 'object' ? work.payload : {};
  const merged = { ...payload, ...work };
  const claimed = isPlainObject(merged.verification) ? merged.verification : {};
  const verification = {
    ...DEFAULT_CONFIG,
    ...claimed,
    authoring: boundedGroup('authoring', claimed.authoring, DEFAULT_CONFIG.authoring),
    flake: boundedGroup('flake', claimed.flake, DEFAULT_CONFIG.flake),
    timeouts_min: boundedGroup('timeouts_min', claimed.timeouts_min, DEFAULT_CONFIG.timeouts_min),
  };
  return { ...merged, verification };
}

function commandFromArgv(argv) {
  const [bin, ...args] = argv;
  return { bin, args };
}

async function executeArgv(execute, argv, cwd, timeoutMs) {
  return execute(commandFromArgv(argv), cwd, timeoutMs);
}

function commandFailureSignature(result) {
  return JSON.stringify({
    exitCode: result?.exitCode ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
  });
}

async function runInstallWithClassification(context, argv, cwd, timeoutMs) {
  const first = await executeArgv(context.execute, argv, cwd, timeoutMs);
  if (first.exitCode === 0) return { ok: true };

  const second = await executeArgv(context.execute, argv, cwd, timeoutMs);
  if (second.exitCode !== 0 && commandFailureSignature(second) === commandFailureSignature(first)) {
    return { ok: false, kind: 'terminal' };
  }
  return { ok: false, kind: 'transient' };
}

async function runSuiteWithTimeoutClassification(context, argv, cwd, timeoutMs) {
  const first = await executeArgv(context.execute, argv, cwd, timeoutMs);
  if (!first.timedOut) return { ok: true, result: first };

  const second = await executeArgv(context.execute, argv, cwd, timeoutMs);
  if (second.timedOut) return { ok: false, kind: 'terminal' };
  return { ok: true, result: second };
}

function parseReporterOutput(stdout) {
  try {
    return { ok: true, value: JSON.parse(stdout || '{}') };
  } catch {
    return { ok: false, failureKind: 'terminal' };
  }
}

function customVerificationCommand(verification) {
  return Array.isArray(verification?.command) && verification.command.length > 0
    ? verification.command
    : null;
}

function configuredInstallCommand(verification) {
  return Array.isArray(verification?.install_command) && verification.install_command.length > 0
    ? verification.install_command
    : null;
}

function installCommandFor(adapter, detected, verification) {
  return configuredInstallCommand(verification) ?? adapter.installCommand(detected.root, detected.packageManager);
}

function resolveFramework(worktreePath, { verification, requestedFramework, detectFramework, adapters }) {
  const framework = requestedFramework ?? verification?.framework ?? 'auto';
  if (framework === 'custom') {
    if (!customVerificationCommand(verification)) return null;
    return { id: 'custom', packageManager: 'custom', root: worktreePath };
  }
  if (!framework || framework === 'auto' || framework === 'none') {
    return detectFramework(worktreePath);
  }

  const adapter = adapters.get(framework);
  if (!adapter) return null;
  if (typeof adapter.detect === 'function') {
    const detected = adapter.detect(worktreePath);
    return detected ? { ...detected, id: framework } : null;
  }
  const detected = detectFramework(worktreePath);
  return detected ? { ...detected, id: framework } : null;
}

function artifactBaseRel(data) {
  const prNumber = data.prNumber ?? data.pr_number;
  const claimId = data.claim_id ?? data.claimId;
  return `.fluent-flow/verify/PR-${prNumber}/red-${claimId}`;
}

function artifactPaths(worktreeRoot, data) {
  const baseRel = artifactBaseRel(data);
  return {
    baseRel,
    specRel: `${baseRel}/spec.md`,
    manifestRel: `${baseRel}/manifest.json`,
    specPath: join(worktreeRoot, baseRel, 'spec.md'),
    manifestPath: join(worktreeRoot, baseRel, 'manifest.json'),
  };
}

function manifestPublishedPaths(manifest, packagePrefix) {
  return uniquePaths(manifest?.requirements?.flatMap((entry) => [
    ...(entry.tests ?? []),
    ...(entry.dependency_files ?? []).filter((path) => pathInsideTestScope(path, packagePrefix)),
  ]) ?? []);
}

function priorRecordPublishedPaths(record, validation) {
  try {
    if (!record || record.phase !== 'red') return [];
    const hashes = record.test_hashes ?? record.testHashes;
    if (!Array.isArray(hashes)) return [];
    validateManifest(record.manifest, validation);
    const packagePrefix = packageRelativePrefix(validation.worktreeRoot, validation.packageRoot);
    const declaredPaths = new Set(manifestPublishedPaths(record.manifest, packagePrefix));
    return uniquePaths(
      hashes
        .map((entry) => (typeof entry?.path === 'string' ? assertSafeRelPath(entry.path) : ''))
        .filter((path) => path && declaredPaths.has(path)),
    );
  } catch {
    return [];
  }
}

function collectPriorRedFiles(records, validation) {
  const priorFiles = [];
  for (const record of records ?? []) {
    priorFiles.push(...priorRecordPublishedPaths(record, validation));
  }
  return uniquePaths(priorFiles);
}

function buildSkippedVerification({ phase, redBaseSha, greenSha, reason }) {
  return {
    phase,
    framework: 'none',
    outcome: 'SKIPPED',
    matrix: null,
    ...(redBaseSha && { red_base_sha: redBaseSha }),
    ...(greenSha && { green_sha: greenSha }),
    ...(reason ? { reason } : {}),
  };
}

function buildMatrix(requirements = [], suite = {}) {
  return {
    requirements,
    suite: {
      total: suite.total ?? 0,
      passed: suite.passed ?? 0,
      failed: suite.failed ?? 0,
      flaky: suite.flaky ?? 0,
      skipped: suite.skipped ?? 0,
    },
    schema_version: 1,
  };
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

class UnsafeVerificationPathError extends Error {}

function normalizeResultFile(worktreeRoot, file) {
  if (typeof file !== 'string' || file.length === 0) return '';
  if (isAbsolute(file) && containsRealPath(worktreeRoot, file)) {
    return relative(worktreeRoot, file).split(sep).join('/');
  }
  return file.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function normalizeRows(worktreeRoot, rows) {
  return (rows ?? []).map((row) => ({
    ...row,
    file: normalizeResultFile(worktreeRoot, row.file ?? ''),
  }));
}

function countStatuses(rows) {
  const suite = { total: rows.length, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const row of rows) {
    if (row.status === 'pass') suite.passed++;
    else if (row.status === 'skip') suite.skipped++;
    else suite.failed++;
  }
  return suite;
}

function validateManifest(manifest, {
  expectedPrNumber,
  findings,
  frameworkId,
  packageManager,
  packageRoot,
  worktreeRoot,
}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest missing or invalid');
  }
  if (manifest.pr_number !== expectedPrNumber) {
    throw new Error('Manifest PR number does not match the claim');
  }
  if (!Array.isArray(manifest.requirements) || manifest.requirements.length === 0) {
    throw new Error('Manifest must contain at least one requirement');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'command') || Object.prototype.hasOwnProperty.call(manifest, 'commands')) {
    throw new Error('Manifest may not contain commands');
  }

  const packagePrefix = packageRelativePrefix(worktreeRoot, packageRoot);
  const mandatoryFiles = new Set(getMandatoryFiles({
    frameworkId,
    packageManager,
    packageRoot,
    worktreeRoot,
  }));
  const blockingFindingIds = new Set(
    (findings ?? [])
      .filter((finding) => finding && finding.blocking !== false && typeof finding.id === 'string')
      .map((finding) => finding.id),
  );
  const mappedBlockingIds = new Set();

  for (const entry of manifest.requirements) {
    if (Object.prototype.hasOwnProperty.call(entry, 'command') || Object.prototype.hasOwnProperty.call(entry, 'commands')) {
      throw new Error('Requirement entry may not contain commands');
    }
    const req = entry.requirement ?? {};
    if (!/^REQ-\d+$/.test(req.id ?? '')) throw new Error('Requirement ids must match REQ-<n>');
    if (!EARS_FORMS.has(req.form)) throw new Error('Requirement form must be a supported EARS form');
    if (typeof req.text !== 'string' || req.text.trim() === '') throw new Error('Requirement text is required');
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) throw new Error('Each requirement must declare tests');
    for (const testPath of entry.tests) {
      const rel = assertSafeRelPath(testPath);
      assertManifestPathScope(rel, { kind: 'test', packagePrefix, mandatoryFiles });
    }
    for (const depPath of entry.dependency_files ?? []) {
      const rel = assertSafeRelPath(depPath);
      assertManifestPathScope(rel, { kind: 'dependency', packagePrefix, mandatoryFiles });
    }
    if (entry.framework !== frameworkId) {
      throw new Error('Manifest framework must match the detected adapter');
    }
    if (blockingFindingIds.has(req.source_finding_id)) {
      mappedBlockingIds.add(req.source_finding_id);
    }
  }

  const missingBlockingFindingIds = [...blockingFindingIds].filter((id) => !mappedBlockingIds.has(id));
  return { missingBlockingFindingIds };
}

function evaluateRedRows(manifest, rows) {
  const requirements = [];
  let invalidReason = null;

  for (const entry of manifest.requirements) {
    const relevant = rows.filter((row) => entry.tests.includes(row.file));
    const observedFiles = new Set(relevant.map((row) => row.file));
    const missingFiles = entry.tests.filter((file) => !observedFiles.has(file));
    const hasSuiteError = relevant.some((row) => row.status === 'suite-error');
    const hasAssertionFail = relevant.some((row) => row.status === 'assertion-fail');
    const hasSkip = relevant.some((row) => row.status === 'skip');
    const status = hasAssertionFail && !hasSuiteError && missingFiles.length === 0 ? 'PASS' : 'FAIL';
    const detail = {
      id: entry.requirement.id,
      source_finding_id: entry.requirement.source_finding_id,
      status,
      tests: entry.tests,
      red: {
        status,
        outcomes: relevant.map((row) => ({
          file: row.file,
          name: row.name,
          status: row.status,
          message: row.message,
        })),
      },
    };
    requirements.push(detail);

    if (hasSuiteError) invalidReason = invalidReason ?? 'suite-error';
    else if (missingFiles.length > 0 || hasSkip) invalidReason = invalidReason ?? 'missing';
    else if (!hasAssertionFail) invalidReason = invalidReason ?? 'pass-at-base';
  }

  return {
    valid: invalidReason == null,
    invalidReason,
    requirements,
    suite: countStatuses(rows),
  };
}

function evaluateGreenRows(manifest, rows) {
  const byRequirement = new Map();
  for (const entry of manifest.requirements) {
    const relevant = rows.filter((row) => entry.tests.includes(row.file));
    const observedFiles = new Set(relevant.map((row) => row.file));
    const missingFiles = entry.tests.filter((file) => !observedFiles.has(file));
    const hasPass = relevant.some((row) => row.status === 'pass');
    const hasFailure = relevant.some((row) => row.status === 'assertion-fail' || row.status === 'suite-error');
    const hasSkip = relevant.some((row) => row.status === 'skip');
    const missing = missingFiles.length > 0;
    byRequirement.set(entry.requirement.id, {
      id: entry.requirement.id,
      source_finding_id: entry.requirement.source_finding_id,
      tests: entry.tests,
      relevant,
      passed: hasPass && !hasFailure && !hasSkip && !missing,
      failed: hasFailure,
      skipped: hasSkip,
      missing,
    });
  }
  return {
    rows,
    suite: countStatuses(rows),
    byRequirement,
  };
}

function repoRelativeFromRoot(worktreeRoot, file) {
  const safe = assertSafeRelPath(file);
  const abs = resolve(worktreeRoot, safe);
  if (!containsRealPath(worktreeRoot, abs)) {
    throw new Error(`Path escapes worktree: ${file}`);
  }
  return { rel: safe, abs };
}

function destinationPathFromRoot(worktreeRoot, file) {
  const safe = assertSafeRelPath(file);
  const abs = resolve(worktreeRoot, safe);
  const rel = relative(resolve(worktreeRoot), abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafeVerificationPathError(`Path escapes worktree: ${file}`);
  }
  return { rel: safe, abs };
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function getMandatoryFiles({ frameworkId, packageManager, packageRoot, worktreeRoot }) {
  const rootRel = relative(worktreeRoot, packageRoot).split(sep).join('/');
  const out = [rootRel ? `${rootRel}/package.json` : 'package.json'];
  const lockfile = LOCKFILE_BY_PM[packageManager];
  if (lockfile && existsSync(join(packageRoot, lockfile))) {
    out.push(rootRel ? `${rootRel}/${lockfile}` : lockfile);
  }
  for (const file of FRAMEWORK_CONFIG_FILES[frameworkId] ?? []) {
    if (existsSync(join(packageRoot, file))) {
      out.push(rootRel ? `${rootRel}/${file}` : file);
    }
  }
  return out;
}

function packageRelativePrefix(worktreeRoot, packageRoot) {
  const rel = relative(resolve(worktreeRoot), resolve(packageRoot));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Detected package root escapes worktree');
  }
  const normalized = rel.split(sep).join('/');
  return normalized ? `${normalized}/` : '';
}

function pathWithinPackage(relPath, packagePrefix) {
  return packagePrefix === '' || relPath.startsWith(packagePrefix);
}

function pathInsideTestScope(relPath, packagePrefix) {
  if (!pathWithinPackage(relPath, packagePrefix)) return false;
  const withinPackage = packagePrefix ? relPath.slice(packagePrefix.length) : relPath;
  return withinPackage.split('/').some((part) => part === 'test' || part === 'tests' || part === '__tests__');
}

function isMandatoryAdapterPath(relPath, { frameworkId, packageManager, packagePrefix }) {
  if (!pathWithinPackage(relPath, packagePrefix)) return false;
  const withinPackage = packagePrefix ? relPath.slice(packagePrefix.length) : relPath;
  if (withinPackage.includes('/')) return false;
  return withinPackage === 'package.json'
    || Object.values(LOCKFILE_BY_PM).includes(withinPackage)
    || (FRAMEWORK_CONFIG_FILES[frameworkId] ?? []).includes(withinPackage);
}

function assertManifestPathScope(relPath, { kind, packagePrefix, mandatoryFiles }) {
  if (kind === 'test') {
    if (!pathInsideTestScope(relPath, packagePrefix)) {
      throw new Error('Manifest test paths must stay under detected package test directories');
    }
    return;
  }
  if (!pathInsideTestScope(relPath, packagePrefix) && !mandatoryFiles.has(relPath)) {
    throw new Error('Manifest dependency_files must stay under detected package test directories or mandatory adapter files');
  }
}

function isProtectedAdditionPath(relPath, { frameworkId, packageManager, packagePrefix }) {
  return pathInsideTestScope(relPath, packagePrefix)
    || isMandatoryAdapterPath(relPath, { frameworkId, packageManager, packagePrefix });
}

function isAllowedRedArtifactStatus(entry, { specRel, manifestRel, nextFiles, priorFiles }) {
  if (entry.path === specRel || entry.path === manifestRel) {
    return ['A', 'M', '??'].includes(entry.status);
  }

  const isNextFile = nextFiles.includes(entry.path);
  const isPriorFile = priorFiles.includes(entry.path);
  if (isNextFile && isPriorFile) {
    return ['A', 'M', '??'].includes(entry.status);
  }
  if (isNextFile) {
    return ['A', '??'].includes(entry.status);
  }
  if (isPriorFile) {
    return entry.status === 'D';
  }
  return false;
}

function parseGitStatus(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith('?? ')) {
        return { status: '??', path: line.slice(3).trim().replaceAll('\\', '/') };
      }

      const nameStatus = line.match(/^([A-Z])\d*\s+(.+)$/);
      if (nameStatus) {
        const status = nameStatus[1];
        const parts = nameStatus[2].split(/\s+/);
        const path = (status === 'R' || status === 'C')
          ? parts[parts.length - 1]
          : nameStatus[2];
        return { status, path: path.trim().replaceAll('\\', '/') };
      }

      return {
        status: line.slice(0, 2).trim(),
        path: line.slice(3).trim().replaceAll('\\', '/'),
      };
    });
}

function assertSafeDestinationParent(worktreeRoot, target) {
  const root = resolve(worktreeRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new UnsafeVerificationPathError('Verification worktree root is not a directory');
  }
  const parent = dirname(target);
  const rel = relative(root, parent);
  const parts = rel ? rel.split(sep) : [];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UnsafeVerificationPathError('Verification artifact parent is not a directory');
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      mkdirSync(current);
    }
  }
  if (!containsRealPath(root, realpathSync(parent))) {
    throw new UnsafeVerificationPathError('Verification artifact parent escapes worktree');
  }
}

function safeRemoveArtifact(worktreeRoot, relPath) {
  const target = destinationPathFromRoot(worktreeRoot, relPath).abs;
  assertSafeDestinationParent(worktreeRoot, target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UnsafeVerificationPathError('Verification artifact is not a regular file');
    }
    rmSync(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function copyArtifact(sourceRoot, targetRoot, relPath) {
  const source = repoRelativeFromRoot(sourceRoot, relPath).abs;
  const target = destinationPathFromRoot(targetRoot, relPath).abs;
  assertSafeDestinationParent(targetRoot, target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UnsafeVerificationPathError('Verification artifact is not a regular file');
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, readFileSync(source));
  } finally {
    closeSync(fd);
  }
}

async function withPreparedWorktree(context, opts, fn) {
  const {
    work,
    cwd,
    environment,
    githubToken,
    prepareWorktree = prepareWorktreeDefault,
  } = context;
  const data = normalizeWork(work);
  const prepared = await prepareWorktree({
    workDir: cwd,
    repo: data.repo,
    branch: opts.branch,
    claimId: data.claim_id ?? data.claimId,
    name: opts.name,
    ref: opts.ref,
    environment,
    githubToken,
  });
  try {
    return await fn(prepared.worktreePath, data, prepared);
  } finally {
    await prepared.cleanup?.();
  }
}

async function runAuthoring(context, worktreePath, data, prompt) {
  if (typeof context.author !== 'function') {
    throw new Error('Verify claim requires an ACP authoring callback');
  }
  try {
    await context.author({ worktreePath, prompt, work: data });
    return { ok: true };
  } catch {
    return { ok: false, kind: 'transient' };
  }
}

async function runRedPhase(context) {
  const data = normalizeWork(context.work);
  const prompt = resolvePrompt({ claimType: 'verify', work: data });
  const violation = promptSizeViolation(prompt);
  if (violation) {
    context.onPromptTooLarge?.(violation);
    return { status: 'failed', failure_kind: 'terminal' };
  }
  try {
    return await withPreparedWorktree(context, { ref: data.red_base_sha, name: 'verify-red' }, async (worktreePath) => {
      const detectFramework = context.detectFramework ?? detectFrameworkDefault;
      const adapters = context.adapters ?? adapterRegistryDefault;
      const detected = resolveFramework(worktreePath, {
        verification: data.verification,
        detectFramework,
        adapters,
      });
      if (!detected) {
        return {
          status: 'completed',
          verification: buildSkippedVerification({
            phase: 'red',
            redBaseSha: data.red_base_sha,
          }),
        };
      }
      if (detected.id === 'custom') {
        return {
          status: 'completed',
          verification: {
            ...buildSkippedVerification({
              phase: 'red',
              redBaseSha: data.red_base_sha,
              reason: 'custom verification commands are suite-only and cannot prove red at the base commit',
            }),
            framework: 'custom',
          },
        };
      }

      const adapter = adapters.get(detected.id);
      if (!adapter) {
        return { status: 'failed', failure_kind: 'terminal' };
      }

      const { manifestPath, specRel, manifestRel } = artifactPaths(worktreePath, data);
      const redTimeoutMs = data.verification.timeouts_min.red * 60_000;
      const authorAttempts = data.verification.authoring.retries + 1;
      let lastManifest = null;
      let lastEvaluation = null;

      for (let attempt = 0; attempt < authorAttempts; attempt++) {
        const authored = await runAuthoring(context, worktreePath, data, prompt);
        if (!authored.ok) return { status: 'failed', failure_kind: authored.kind };

        let manifest = null;
        let validation;
        try {
          manifest = safeReadJson(manifestPath);
          validation = validateManifest(manifest, {
            expectedPrNumber: data.prNumber ?? data.pr_number,
            findings: data.findings ?? [],
            frameworkId: detected.id,
            packageManager: detected.packageManager,
            packageRoot: detected.root,
            worktreeRoot: worktreePath,
          });
        } catch {
          continue;
        }
        lastManifest = manifest;

        if (validation.missingBlockingFindingIds.length > 0) {
          return {
            status: 'completed',
            verification: {
              phase: 'red',
              framework: detected.id,
              outcome: 'FAIL',
              matrix: buildMatrix([], {}),
              manifest,
              red_base_sha: data.red_base_sha,
              unverified_findings: validation.missingBlockingFindingIds,
            },
          };
        }

        const proof = await withPreparedWorktree(context, { ref: data.red_base_sha, name: 'verify-push' }, async (pushWorktreePath) => {
          const pushRoot = resolve(pushWorktreePath, relative(worktreePath, detected.root));
          const proofDetected = { ...detected, root: pushRoot };
          const packagePrefix = packageRelativePrefix(pushWorktreePath, pushRoot);
          const priorFiles = collectPriorRedFiles(data.prior_red_records ?? data.priorRedRecords, {
            expectedPrNumber: data.prNumber ?? data.pr_number,
            findings: [],
            frameworkId: detected.id,
            packageManager: detected.packageManager,
            packageRoot: pushRoot,
            worktreeRoot: pushWorktreePath,
          });
          const nextTests = uniquePaths(manifest.requirements.flatMap((entry) => entry.tests));
          const nextFiles = manifestPublishedPaths(manifest, packagePrefix);
          for (const file of priorFiles) {
            if (!nextFiles.includes(file)) {
              safeRemoveArtifact(pushWorktreePath, file);
            }
          }

          copyArtifact(worktreePath, pushWorktreePath, specRel);
          copyArtifact(worktreePath, pushWorktreePath, manifestRel);
          for (const file of nextFiles) {
            copyArtifact(worktreePath, pushWorktreePath, file);
          }

          const install = await runInstallWithClassification(
            context,
            installCommandFor(adapter, proofDetected, data.verification),
            pushRoot,
            redTimeoutMs,
          );
          if (!install.ok) {
            return { result: { status: 'failed', failure_kind: install.kind } };
          }

          let evaluation = null;
          for (let runIndex = 0; runIndex < data.verification.authoring.red_reproductions; runIndex++) {
            const suiteRun = await runSuiteWithTimeoutClassification(
              context,
              adapter.testCommand({ files: nextTests, root: pushRoot, worktreeRoot: pushWorktreePath }),
              pushRoot,
              redTimeoutMs,
            );
            if (!suiteRun.ok) {
              return { result: { status: 'failed', failure_kind: suiteRun.kind } };
            }
            const parsed = parseReporterOutput(suiteRun.result.stdout);
            if (!parsed.ok) {
              return { result: { status: 'failed', failure_kind: parsed.failureKind } };
            }
            const rows = normalizeRows(pushWorktreePath, adapter.parseResults(parsed.value));
            evaluation = evaluateRedRows(manifest, rows);
            if (!evaluation.valid) {
              return { retry: true, evaluation };
            }
          }

          const statusResult = await executeArgv(context.execute, ['git', 'status', '--porcelain', '--untracked-files=all'], pushWorktreePath);
          if (statusResult.exitCode !== 0) {
            return { result: { status: 'failed', failure_kind: 'transient' }, evaluation };
          }
          const invalidStatus = parseGitStatus(statusResult.stdout).find((entry) => !isAllowedRedArtifactStatus(entry, {
            specRel,
            manifestRel,
            nextFiles,
            priorFiles,
          }));
          if (invalidStatus) {
            return {
              result: {
                status: 'completed',
                verification: {
                  phase: 'red',
                  framework: detected.id,
                  outcome: 'FAIL',
                  matrix: buildMatrix(evaluation?.requirements ?? [], evaluation?.suite ?? {}),
                  manifest,
                  red_base_sha: data.red_base_sha,
                },
              },
              evaluation,
            };
          }

          const gitAdd = await executeArgv(context.execute, ['git', 'add', '-A'], pushWorktreePath);
          if (gitAdd.exitCode !== 0) {
            return { result: { status: 'failed', failure_kind: 'transient' }, evaluation };
          }
          const gitCommit = await executeArgv(
            context.execute,
            ['git', 'commit', '-m', `test(verify): pin PR #${data.prNumber ?? data.pr_number} requirements (red) [skip ci]`],
            pushWorktreePath,
          );
          if (gitCommit.exitCode !== 0) {
            return { result: { status: 'failed', failure_kind: 'transient' }, evaluation };
          }
          const gitPush = await executeArgv(context.execute, ['git', 'push', 'origin', `HEAD:${data.branch}`], pushWorktreePath);
          if (gitPush.exitCode !== 0) {
            return { result: { status: 'failed', failure_kind: 'transient' }, evaluation };
          }
          const revParse = await executeArgv(context.execute, ['git', 'rev-parse', 'HEAD'], pushWorktreePath);
          if (revParse.exitCode !== 0 || revParse.stdout.trim() === '') {
            return { result: { status: 'failed', failure_kind: 'transient' }, evaluation };
          }
          const artifactSha = revParse.stdout.trim();

          const hashPaths = uniquePaths([
            ...nextTests,
            ...manifest.requirements.flatMap((entry) => entry.dependency_files ?? []),
            ...getMandatoryFiles({
              frameworkId: detected.id,
              packageManager: detected.packageManager,
              packageRoot: pushRoot,
              worktreeRoot: pushWorktreePath,
            }),
          ]);
          const testHashes = hashPaths.map((path) => ({
            path,
            sha256: sha256File(join(pushWorktreePath, assertSafeRelPath(path))),
          }));

          return {
            result: {
              status: 'completed',
              verification: {
                phase: 'red',
                framework: detected.id,
                outcome: 'PASS',
                matrix: buildMatrix(evaluation.requirements, evaluation.suite),
                manifest,
                test_hashes: testHashes,
                artifact_sha: artifactSha,
                red_base_sha: data.red_base_sha,
              },
            },
            evaluation,
          };
        });

        lastEvaluation = proof.evaluation ?? lastEvaluation;
        if (proof.retry) continue;
        return proof.result;
      }

      return {
        status: 'completed',
        verification: {
          phase: 'red',
          framework: detected.id,
          outcome: 'FAIL',
          matrix: buildMatrix(lastEvaluation?.requirements ?? [], lastEvaluation?.suite ?? {}),
          manifest: lastManifest ?? undefined,
          red_base_sha: data.red_base_sha,
        },
      };
    });
  } catch (err) {
    if (err instanceof WorktreeRefUnavailableError) {
      return {
        status: 'completed',
        verification: buildSkippedVerification({
          phase: 'red',
          redBaseSha: data.red_base_sha,
        }),
      };
    }
    if (err instanceof UnsafeVerificationPathError) {
      return { status: 'failed', failure_kind: 'terminal' };
    }
    throw err;
  }
}

function buildTamperedVerification({ data, redRecord, framework }) {
  return {
    phase: 'green',
    framework,
    outcome: 'TAMPERED',
    matrix: redRecord?.matrix ?? buildMatrix([], {}),
    red_base_sha: redRecord?.red_base_sha ?? data.red_base_sha,
    green_sha: data.green_sha ?? data.head_sha,
  };
}

async function runCustomGreenPhase(context, data, redRecord) {
  const suiteCommand = customVerificationCommand(data.verification);
  if (!suiteCommand) {
    return { status: 'failed', failure_kind: 'terminal' };
  }

  return withPreparedWorktree(context, { ref: data.green_sha ?? data.head_sha, name: 'verify-green' }, async (worktreePath) => {
    const greenTimeoutMs = data.verification.timeouts_min.green * 60_000;
    const installCommand = configuredInstallCommand(data.verification);
    if (installCommand) {
      const install = await runInstallWithClassification(context, installCommand, worktreePath, greenTimeoutMs);
      if (!install.ok) {
        return { status: 'failed', failure_kind: install.kind };
      }
    }

    const suiteRun = await runSuiteWithTimeoutClassification(context, suiteCommand, worktreePath, greenTimeoutMs);
    if (!suiteRun.ok) return { status: 'failed', failure_kind: suiteRun.kind };
    const suite = suiteRun.result;
    const passed = suite.exitCode === 0;
    return {
      status: 'completed',
      verification: {
        phase: 'green',
        framework: 'custom',
        outcome: passed ? 'PASS' : 'FAIL',
        matrix: buildMatrix([], {
          total: 1,
          passed: passed ? 1 : 0,
          failed: passed ? 0 : 1,
          flaky: 0,
          skipped: 0,
        }),
        red_base_sha: redRecord?.red_base_sha ?? data.red_base_sha,
        green_sha: data.green_sha ?? data.head_sha,
      },
    };
  });
}

async function runGreenPhase(context) {
  const data = normalizeWork(context.work);
  const redRecord = data.red_record;
  if (redRecord?.framework === 'custom' || data.verification.framework === 'custom') {
    return runCustomGreenPhase(context, data, redRecord);
  }

  if (!redRecord?.manifest || !Array.isArray(redRecord.test_hashes)) {
    return { status: 'failed', failure_kind: 'terminal' };
  }

  return withPreparedWorktree(context, { ref: data.green_sha ?? data.head_sha, name: 'verify-green' }, async (worktreePath) => {
    for (const entry of redRecord.test_hashes) {
      const rel = assertSafeRelPath(entry.path);
      const abs = join(worktreePath, rel);
      if (!existsSync(abs) || sha256File(abs) !== entry.sha256) {
        return {
          status: 'completed',
          verification: buildTamperedVerification({
            data,
            redRecord,
            framework: redRecord.framework ?? 'unknown',
          }),
        };
      }
    }

    const detectFramework = context.detectFramework ?? detectFrameworkDefault;
    const adapters = context.adapters ?? adapterRegistryDefault;
    const requestedFramework = redRecord.framework && redRecord.framework !== 'none'
      ? redRecord.framework
      : data.verification.framework;
    const detected = resolveFramework(worktreePath, {
      verification: data.verification,
      requestedFramework,
      detectFramework,
      adapters,
    });
    if (!detected) {
      return { status: 'failed', failure_kind: 'transient' };
    }
    const frameworkId = requestedFramework && requestedFramework !== 'auto' && requestedFramework !== 'none'
      ? requestedFramework
      : detected.id;
    const adapter = adapters.get(frameworkId);
    if (!adapter) {
      return { status: 'failed', failure_kind: 'terminal' };
    }

    const greenTimeoutMs = data.verification.timeouts_min.green * 60_000;
    if (redRecord.artifact_sha) {
      const reachable = await executeArgv(context.execute, ['git', 'cat-file', '-e', `${redRecord.artifact_sha}^{commit}`], worktreePath, greenTimeoutMs);
      if (reachable.exitCode !== 0) {
        return {
          status: 'completed',
          verification: buildTamperedVerification({
            data,
            redRecord,
            framework: frameworkId,
          }),
        };
      }
      const diff = await executeArgv(context.execute, ['git', 'diff', '--name-status', '--no-renames', redRecord.artifact_sha, 'HEAD'], worktreePath, greenTimeoutMs);
      if (diff.exitCode !== 0) return { status: 'failed', failure_kind: 'transient' };
      const packagePrefix = packageRelativePrefix(worktreePath, detected.root);
      const protectedAddition = parseGitStatus(diff.stdout).find(
        (entry) => ['A', 'M', 'R', 'C', 'D'].includes(entry.status) && isProtectedAdditionPath(entry.path, {
          frameworkId,
          packageManager: detected.packageManager,
          packagePrefix,
        }),
      );
      if (protectedAddition) {
        return {
          status: 'completed',
          verification: buildTamperedVerification({
            data,
            redRecord,
            framework: frameworkId,
          }),
        };
      }
    }

    const install = await runInstallWithClassification(
      context,
      installCommandFor(adapter, detected, data.verification),
      detected.root,
      greenTimeoutMs,
    );
    if (!install.ok) {
      return { status: 'failed', failure_kind: install.kind };
    }

    const manifest = redRecord.manifest;
    const pinnedFiles = uniquePaths(manifest.requirements.flatMap((entry) => entry.tests));
    const pinnedRuns = [];
    const runBudget = (data.verification.flake?.retries ?? 0) + 1;
    for (let attempt = 0; attempt < runBudget; attempt++) {
      const suiteRun = await runSuiteWithTimeoutClassification(
        context,
        adapter.testCommand({ files: pinnedFiles, root: detected.root, worktreeRoot: worktreePath }),
        detected.root,
        greenTimeoutMs,
      );
      if (!suiteRun.ok) return { status: 'failed', failure_kind: suiteRun.kind };
      const run = suiteRun.result;
      const parsed = parseReporterOutput(run.stdout);
      if (!parsed.ok) return { status: 'failed', failure_kind: parsed.failureKind };
      const rows = normalizeRows(worktreePath, adapter.parseResults(parsed.value));
      const evaluation = evaluateGreenRows(manifest, rows);
      pinnedRuns.push(evaluation);
      const allPassed = [...evaluation.byRequirement.values()].every((entry) => entry.passed);
      if (allPassed) break;
    }

    const finalPinned = pinnedRuns.at(-1) ?? evaluateGreenRows(manifest, []);
    const requirements = manifest.requirements.map((entry) => {
      const runStates = pinnedRuns.map((run) => run.byRequirement.get(entry.requirement.id) ?? {
        id: entry.requirement.id,
        tests: entry.tests,
        relevant: [],
        passed: false,
        failed: false,
        skipped: false,
        missing: true,
      });
      const finalState = runStates.at(-1);
      const flaky = runStates.some((state) => state.failed) && runStates.some((state) => state.passed);
      const red = (redRecord.matrix?.requirements ?? [])
        .find((req) => req.id === entry.requirement.id) ?? { status: 'MISSING' };
      const status = finalState.passed && !flaky && red.status === 'PASS' ? 'PASS' : 'FAIL';
      return {
        id: entry.requirement.id,
        source_finding_id: entry.requirement.source_finding_id,
        tests: entry.tests,
        status,
        red,
        green: {
          status,
          flaky,
          outcomes: finalState.relevant.map((row) => ({
            file: row.file,
            name: row.name,
            status: row.status,
            message: row.message,
          })),
        },
      };
    });

    const pinnedSet = new Set(pinnedFiles);
    const fullRuns = [];
    for (let attempt = 0; attempt < runBudget; attempt++) {
      const suiteRun = await runSuiteWithTimeoutClassification(
        context,
        adapter.testCommand({ files: null, root: detected.root, worktreeRoot: worktreePath }),
        detected.root,
        greenTimeoutMs,
      );
      if (!suiteRun.ok) return { status: 'failed', failure_kind: suiteRun.kind };
      const run = suiteRun.result;
      const parsed = parseReporterOutput(run.stdout);
      if (!parsed.ok) return { status: 'failed', failure_kind: parsed.failureKind };
      const rows = normalizeRows(worktreePath, adapter.parseResults(parsed.value));
      fullRuns.push(rows);
      if (rows.every((row) => row.status === 'pass')) break;
    }

    const finalFullRows = fullRuns.at(-1) ?? [];
    const warnings = finalFullRows
      .filter((row) => row.status !== 'pass' && !pinnedSet.has(row.file))
      .map((row) => ({
        file: row.file,
        status: row.status,
        message: row.message,
      }));
    const blockingFullFailures = finalFullRows.filter((row) => row.status !== 'pass' && pinnedSet.has(row.file));
    const hadPriorFullFailure = fullRuns.slice(0, -1).some((rows) => rows.some((row) => row.status !== 'pass'));
    const suite = countStatuses(finalFullRows);
    const persistentFullFailure = finalFullRows.some((row) => row.status !== 'pass');
    if (warnings.length > 0 && !(Boolean(data.verification.flake?.blocking) && persistentFullFailure)) {
      suite.failed = blockingFullFailures.length;
      suite.passed = finalFullRows.filter((row) => row.status === 'pass').length;
    }
    if (hadPriorFullFailure && finalFullRows.every((row) => row.status === 'pass')) {
      suite.flaky = Math.max(
        suite.flaky,
        new Set(fullRuns.slice(0, -1).flatMap((rows) => rows.filter((row) => row.status !== 'pass').map((row) => row.file))).size,
      );
    }

    const requirementFailure = requirements.some((req) => req.status === 'FAIL');
    const suiteBlockingFailure = blockingFullFailures.length > 0;
    const fullSuiteFlakeBlocking = Boolean(data.verification.flake?.blocking) &&
      (hadPriorFullFailure || persistentFullFailure);
    const outcome = requirementFailure || suiteBlockingFailure || fullSuiteFlakeBlocking ? 'FAIL' : 'PASS';

    return {
      status: 'completed',
      verification: {
        phase: 'green',
        framework: redRecord.framework ?? detected.id,
        outcome,
        matrix: {
          ...buildMatrix(requirements, suite),
          warnings,
          artifact: {
            red: redRecord.artifact_sha,
            green: data.green_sha ?? data.head_sha,
          },
        },
        red_base_sha: redRecord.red_base_sha ?? data.red_base_sha,
        green_sha: data.green_sha ?? data.head_sha,
      },
    };
  });
}

export async function runVerifyClaim(context) {
  const data = normalizeWork(context.work);
  if (data.phase === 'red') return runRedPhase(context);
  if (data.phase === 'green') return runGreenPhase(context);
  return { status: 'failed', failure_kind: 'terminal' };
}

export { adapterRegistryDefault as adapterRegistry };
