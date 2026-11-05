import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

it('exposes npm run runner with help before requiring a database or daemon', async () => {
  let result;
  try {
    result = { code: 0, ...await promisify(execFile)('npm', ['run', 'runner', '--', '--help'], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      env: { ...process.env, DATABASE_URL: 'postgres://unavailable.invalid/not_a_demo' },
      timeout: 15_000,
    }) };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('npm run runner');
  expect(result.stdout).toContain('--profile');
});
