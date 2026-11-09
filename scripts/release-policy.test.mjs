import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeReleasePolicy, readPublishedState } from './release-policy.mjs';

const script = fileURLToPath(new URL('./release-policy.mjs', import.meta.url));

test('the first release is promoted to latest when nothing is published', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.0.0', publishedVersions: [], distTags: {} }),
    { prerelease: false, promote_latest: true },
  );
});

test('an E404-equivalent empty history promotes a stable release and keeps a prerelease off latest', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '0.1.0', publishedVersions: undefined, distTags: undefined }),
    { prerelease: false, promote_latest: true },
  );
  assert.deepEqual(
    computeReleasePolicy({ version: '0.1.0-rc.1', publishedVersions: undefined, distTags: undefined }),
    { prerelease: true, promote_latest: false },
  );
});

test('a prerelease never moves latest even when it is the highest version', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '2.0.0-beta.1', publishedVersions: ['1.4.0'], distTags: { latest: '1.4.0' } }),
    { prerelease: true, promote_latest: false },
  );
});

test('a higher stable release is promoted', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.5.0', publishedVersions: ['1.3.0', '1.4.0'], distTags: { latest: '1.4.0' } }),
    { prerelease: false, promote_latest: true },
  );
});

test('a lower stable release (legacy backport) is not promoted', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.3.1', publishedVersions: ['1.3.0', '1.4.0'], distTags: { latest: '1.4.0' } }),
    { prerelease: false, promote_latest: false },
  );
});

test('re-running the release of the current latest version stays promoted', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.4.0', publishedVersions: ['1.3.0', '1.4.0'], distTags: { latest: '1.4.0' } }),
    { prerelease: false, promote_latest: true },
  );
});

test('a stable version above the latest tag but below a published stable version is not promoted', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.4.0', publishedVersions: ['1.4.0', '1.6.0'], distTags: { latest: '1.3.0' } }),
    { prerelease: false, promote_latest: false },
  );
});

test('published prereleases do not raise the stable bar', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.4.0', publishedVersions: ['1.3.0', '2.0.0-rc.1'], distTags: { latest: '1.3.0', next: '2.0.0-rc.1' } }),
    { prerelease: false, promote_latest: true },
  );
});

test('prerelease ordering inside the same core version is respected', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.4.0', publishedVersions: ['1.4.0-rc.1'], distTags: { latest: '1.3.9' } }),
    { prerelease: false, promote_latest: true },
  );
});

test('build metadata does not make a version a prerelease', () => {
  assert.deepEqual(
    computeReleasePolicy({ version: '1.4.0+build.7', publishedVersions: [], distTags: {} }),
    { prerelease: false, promote_latest: true },
  );
});

test('rejects an invalid version', () => {
  for (const version of ['', 'v1.0.0', '1.0', 'latest', undefined, null, 4]) {
    assert.throws(() => computeReleasePolicy({ version, publishedVersions: [], distTags: {} }), /version/i);
  }
});

test('rejects malformed registry data', () => {
  assert.throws(() => computeReleasePolicy({ version: '1.0.0', publishedVersions: ['not-a-version'], distTags: {} }), /published/i);
  assert.throws(() => computeReleasePolicy({ version: '1.0.0', publishedVersions: [], distTags: { latest: 'bogus' } }), /latest/i);
  assert.throws(() => computeReleasePolicy({ version: '1.0.0', publishedVersions: 'nope', distTags: {} }), /published/i);
});

function runnerResult(overrides) {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

test('readPublishedState parses the npm registry document', () => {
  const state = readPublishedState({
    packageName: '@fluent-flow/agent-server',
    run: (command, args) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['view', '@fluent-flow/agent-server', 'versions', 'dist-tags', '--json']);
      return runnerResult({ stdout: JSON.stringify({ versions: ['1.0.0', '1.1.0'], 'dist-tags': { latest: '1.1.0' } }) });
    },
  });

  assert.deepEqual(state, { publishedVersions: ['1.0.0', '1.1.0'], distTags: { latest: '1.1.0' } });
});

test('readPublishedState accepts a single version published as a plain string', () => {
  const state = readPublishedState({
    packageName: 'pkg',
    run: () => runnerResult({ stdout: JSON.stringify({ versions: '1.0.0', 'dist-tags': { latest: '1.0.0' } }) }),
  });

  assert.deepEqual(state.publishedVersions, ['1.0.0']);
});

test('readPublishedState treats an E404 as an empty history', () => {
  const state = readPublishedState({
    packageName: 'pkg',
    run: () => runnerResult({ status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' }),
  });

  assert.deepEqual(state, { publishedVersions: [], distTags: {} });
});

test('readPublishedState fails on any other registry error', () => {
  assert.throws(
    () => readPublishedState({ packageName: 'pkg', run: () => runnerResult({ status: 1, stderr: 'npm error code ETIMEDOUT' }) }),
    /Unable to read/,
  );
  assert.throws(
    () => readPublishedState({ packageName: 'pkg', run: () => runnerResult({ stdout: 'not json' }) }),
    /Unable to read/,
  );
});

function runCli({ npmScript, env }) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-release-policy-'));
  try {
    const npm = join(directory, 'npm');
    writeFileSync(npm, `#!/bin/sh\n${npmScript}\n`);
    chmodSync(npm, 0o755);
    const output = join(directory, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: output, ...env },
      encoding: 'utf8',
    });
    return { ...result, outputs: readFileSync(output, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the CLI writes workflow outputs for a promoted stable release', () => {
  const result = runCli({
    npmScript: `echo '{"versions":["1.0.0"],"dist-tags":{"latest":"1.0.0"}}'`,
    env: { PACKAGE_NAME: 'pkg', PACKAGE_VERSION: '1.1.0' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, 'prerelease=false\npromote_latest=true\n');
  assert.match(result.stdout, /1\.1\.0/);
});

test('the CLI treats an unpublished package as an empty history', () => {
  const result = runCli({
    npmScript: `echo 'npm error code E404' >&2; exit 1`,
    env: { PACKAGE_NAME: 'pkg', PACKAGE_VERSION: '1.0.0-rc.1' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, 'prerelease=true\npromote_latest=false\n');
});

test('the CLI fails and writes no outputs when the registry cannot be read', () => {
  const result = runCli({
    npmScript: `echo 'npm error code ETIMEDOUT' >&2; exit 1`,
    env: { PACKAGE_NAME: 'pkg', PACKAGE_VERSION: '1.0.0' },
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.outputs, '');
  assert.match(result.stderr + result.stdout, /::error::/);
});

test('the CLI requires the package name and version', () => {
  const result = runCli({ npmScript: 'exit 0', env: { PACKAGE_VERSION: '1.0.0' } });

  assert.notEqual(result.status, 0);
  assert.equal(result.outputs, '');
});
