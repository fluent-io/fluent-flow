import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs, { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createArtifactReader } from '../../../src/connector/artifacts.js';


let tmp;
let roots;
let reader;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ff-art-'));
  const root = join(tmp, 'workspace');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'innocent.md'), '# fine');
  writeFileSync(join(root, 'report.json'), '{"ok":true}');
  writeFileSync(join(root, '.env'), 'SECRET_KEY=x');
  writeFileSync(join(root, 'sub', 'service.key'), 'PRIVATE');
  writeFileSync(join(root, 'page.html'), '<html></html>');
  symlinkSync(join(root, '.env'), join(root, 'innocent-link.md'));
  symlinkSync(join(tmp, 'outside.txt'), join(root, 'escape.md'));
  writeFileSync(join(tmp, 'outside.txt'), 'outside');
  roots = { 'test-repo': root };
  reader = createArtifactReader({ roots });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function raceArtifactPath(scenario) {
  const root = roots['test-repo'];
  const parent = join(root, 'race');
  const candidate = join(parent, 'report.txt');
  const outside = join(tmp, 'outside');
  const outsideFile = join(outside, 'report.txt');
  mkdirSync(parent);
  mkdirSync(outside);
  writeFileSync(candidate, 'safe workspace report');
  writeFileSync(outsideFile, 'SYNTHETIC_OUTSIDE_WORKSPACE_BYTES');
  const originalRealpath = fs.realpathSync;
  const originalRead = fs.readSync;
  let replaced = false;
  let readOutside = false;
  fs.realpathSync = function (path, ...args) {
    const result = originalRealpath(path, ...args);
    if (!replaced && path === candidate) {
      replaced = true;
      if (scenario === 'leaf') {
        renameSync(candidate, join(parent, 'original.txt'));
        symlinkSync(outsideFile, candidate);
      } else {
        renameSync(parent, join(root, 'original-race'));
        symlinkSync(outside, parent, 'dir');
      }
    }
    return result;
  };
  fs.readSync = function (fd, ...args) {
    if (originalRealpath(`/proc/self/fd/${fd}`).startsWith(`${outside}${sep}`)) readOutside = true;
    return originalRead(fd, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = reader.read({ repositoryKey: 'test-repo', reference: 'race/report.txt' });
    return { result, readOutside, replaced };
  } finally {
    fs.realpathSync = originalRealpath;
    fs.readSync = originalRead;
    syncBuiltinESMExports();
  }
}

describe('artifact reader against REAL filesystem', () => {
  it('reads a normal file with digest and media type', () => {
    const res = reader.read({ repositoryKey: 'test-repo', reference: 'innocent.md' });
    expect(res.status).toBe('available');
    expect(res.mediaType).toBe('text/plain');
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(res.contentBase64, 'base64').toString()).toBe('# fine');
  });

  it('REFUSES a symlink named innocently that resolves to an in-root .env', () => {
    const res = reader.read({ repositoryKey: 'test-repo', reference: 'innocent-link.md' });
    expect(res.status).toBe('unavailable');
    expect(res.reason).toBe('credential_file');
  });

  it('REFUSES a symlink that escapes the workspace root', () => {
    const res = reader.read({ repositoryKey: 'test-repo', reference: 'escape.md' });
    expect(res.status).toBe('unavailable');
    expect(res.reason).toBe('symlink_escape');
  });

  it.each(['leaf', 'parent'])('does not read outside the workspace after a %s replacement race', (scenario) => {
    const { result, readOutside, replaced } = raceArtifactPath(scenario);
    expect(replaced).toBe(true);
    expect(result.status).toBe('unavailable');
    expect(result.contentBase64).toBeUndefined();
    expect(readOutside).toBe(false);
  });

  it('rejects a FIFO promptly without blocking the connector process', () => {
    const fifo = join(roots['test-repo'], 'blocked.txt');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(created.status).toBe(0);
    const moduleUrl = new URL('../../../src/connector/artifacts.js', import.meta.url).href;
    const script = `
      import { createArtifactReader } from ${JSON.stringify(moduleUrl)};
      const reader = createArtifactReader({ roots: { 'test-repo': ${JSON.stringify(roots['test-repo'])} } });
      const result = reader.read({ repositoryKey: 'test-repo', reference: 'blocked.txt' });
      process.stdout.write(JSON.stringify({ result, responsive: true }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      result: { status: 'unavailable', reason: 'not_a_file' },
      responsive: true,
    });
  });

  it('REFUSES direct and nested secret names', () => {
    expect(reader.read({ repositoryKey: 'test-repo', reference: '.env' }).reason).toBe('credential_file');
    expect(reader.read({ repositoryKey: 'test-repo', reference: 'sub/service.key' }).reason).toBe('credential_file');
    expect(reader.read({ repositoryKey: 'test-repo', reference: 'sub/../.env' }).reason).toBe('credential_file');
  });

  it('REFUSES traversal and absolute references', () => {
    expect(reader.read({ repositoryKey: 'test-repo', reference: '../outside.txt' }).reason).toBe('outside_workspace');
    expect(reader.read({ repositoryKey: 'test-repo', reference: '/etc/hostname' }).reason).toBe('invalid_reference');
  });

  it('serves html as attachment media type, never inline html', () => {
    const res = reader.read({ repositoryKey: 'test-repo', reference: 'page.html' });
    expect(res.status).toBe('available');
    expect(res.mediaType).toBe('application/octet-stream');
  });

  it('rejects unknown workspaces and unsupported types', () => {
    expect(reader.read({ repositoryKey: 'nope', reference: 'x.md' }).reason).toBe('unknown_workspace');
    expect(reader.read({ repositoryKey: 'test-repo', reference: 'binary.bin' }).reason).toBe('unsupported_media_type');
  });
});
