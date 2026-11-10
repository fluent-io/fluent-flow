import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const PLAIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function requireVersion(value, label) {
  if (typeof value !== 'string' || !PLAIN_VERSION.test(value) || semver.valid(value) === null) {
    throw new Error(`${label} must be a plain semantic version, got ${JSON.stringify(value)}`);
  }
  return value;
}

function highestStable(versions) {
  let highest = null;
  for (const version of versions) {
    if (semver.prerelease(version) !== null) continue;
    if (highest === null || semver.gt(version, highest)) highest = version;
  }
  return highest;
}

export function computeReleasePolicy({ version, publishedVersions = [], distTags = {} }) {
  requireVersion(version, 'Release version');
  if (!Array.isArray(publishedVersions)) throw new Error('Published versions must be an array');
  for (const published of publishedVersions) requireVersion(published, 'Published version');
  const latest = distTags?.latest;
  if (latest !== undefined) requireVersion(latest, 'The latest dist-tag');

  const prerelease = semver.prerelease(version) !== null;
  if (prerelease) return { prerelease: true, promote_latest: false };

  const highest = highestStable([...publishedVersions, ...(latest === undefined ? [] : [latest])]);
  return { prerelease: false, promote_latest: highest === null || semver.gte(version, highest) };
}

export function readPublishedState({ packageName, run = spawnSync }) {
  const result = run('npm', ['view', packageName, 'versions', 'dist-tags', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (/E404/.test(result.stderr ?? '')) return { publishedVersions: [], distTags: {} };
    throw new Error(`Unable to read the published versions of ${packageName}`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Unable to read the published versions of ${packageName}`);
  }
  const versions = document?.versions;
  return {
    publishedVersions: typeof versions === 'string' ? [versions] : versions ?? [],
    distTags: document?.['dist-tags'] ?? {},
  };
}

function runCli() {
  const packageName = process.env.PACKAGE_NAME;
  const version = process.env.PACKAGE_VERSION;
  try {
    if (!packageName) throw new Error('PACKAGE_NAME is required');
    if (!version) throw new Error('PACKAGE_VERSION is required');
    const { publishedVersions, distTags } = readPublishedState({ packageName });
    const policy = computeReleasePolicy({ version, publishedVersions, distTags });
    console.log(
      `Version ${version}: prerelease=${policy.prerelease}, npm latest='${distTags.latest ?? ''}', promote_latest=${policy.promote_latest}`,
    );
    const lines = `prerelease=${policy.prerelease}\npromote_latest=${policy.promote_latest}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    else process.stdout.write(lines);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && fileURLToPath(import.meta.url) === entryPath) runCli();
