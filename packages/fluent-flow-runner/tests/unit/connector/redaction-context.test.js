import { it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedactionContext } from '../../../src/connector/redaction-context.js';

const directories = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'ff-redaction-')); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('retains unique reporting credentials atomically and privately across restart without copying seed credentials', () => {
  const dir = temporary();
  chmodSync(dir, 0o755);
  const seed = join(temporary(), 'seed.json');
  writeFileSync(seed, JSON.stringify(['prior-private-credential']), { mode: 0o600 });
  const context = createRedactionContext({ dir, secretsFile: seed });
  context.rememberReportingCredential('new-private-credential');
  context.rememberReportingCredential('new-private-credential');
  expect(createRedactionContext({ dir, secretsFile: seed }).secrets).toEqual(['new-private-credential', 'prior-private-credential']);
  expect(JSON.parse(readFileSync(join(dir, 'redaction-context.json'), 'utf8'))).toEqual(['new-private-credential']);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'redaction-context.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(['redaction-context.json']);
});

it('refuses public, symlinked and malformed context files without including their contents in errors', () => {
  const dir = temporary();
  const target = join(dir, 'seed.json');
  writeFileSync(target, '["private-test-value"]', { mode: 0o644 });
  const open = (secretsFile) => {
    let error;
    try { createRedactionContext({ dir: join(dir, 'state'), secretsFile }); } catch (caught) { error = caught; }
    expect(error?.message).toMatch(/private regular file/);
    expect(error.message.includes('private-test-value')).toBe(false);
  };
  open(target);
  chmodSync(target, 0o600);
  const link = join(dir, 'seed-link.json');
  symlinkSync(target, link);
  open(link);
  writeFileSync(target, '{private-test-value');
  open(target);
  writeFileSync(join(dir, 'state', 'redaction-context.json'), '["private-test-value"]', { mode: 0o644 });
  expect(() => createRedactionContext({ dir: join(dir, 'state') })).toThrow(/private regular file/);
});
