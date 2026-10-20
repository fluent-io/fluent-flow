import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactReader } from '../../../src/connector/artifacts.js';

/**
 * REAL-filesystem artifact reader regressions. The symlink-alias case was
 * demonstrated live (innocent name → in-root .env returned content): these
 * tests pin the refusal.
 */

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
