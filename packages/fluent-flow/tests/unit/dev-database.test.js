import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '../../../..');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ running = false, missingCluster = false, startFails = false, external = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ff-dev-startup-'));
  roots.push(root);
  for (const dir of ['scripts', 'packages/fluent-flow', '.local', 'node_modules/.bin']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), readFileSync(join(repo, 'package.json')));
  if (existsSync(join(repo, 'scripts/dev-database.mjs'))) {
    copyFileSync(join(repo, 'scripts/dev-database.mjs'), join(root, 'scripts/dev-database.mjs'));
  }
  writeFileSync(join(root, 'packages/fluent-flow/.env.local'),
    `DATABASE_URL=postgres://ffuser@${external ? 'db.example.test:5432/custom' : '127.0.0.1:55432/ff_demo'}\n`);
  if (!missingCluster) {
    mkdirSync(join(root, '.local/postgres-data'));
    writeFileSync(join(root, '.local/postgres-data/PG_VERSION'), '99\n');
  }
  if (running) writeFileSync(join(root, '.local/ready'), 'existing server');
  if (startFails) writeFileSync(join(root, '.local/start-fails'), '');
  if (!external) writeFileSync(join(root, '.local/needs-database'), '');
  writeFileSync(join(root, '.local/ff-demo-users.json'), 'credential-file-must-stay-unchanged');
  writeFileSync(join(root, 'node_modules/.bin/pg_ctl'), `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('pg_ctl (PostgreSQL) 99.0');process.exit(0);}
if(!fs.existsSync('.local/needs-database')) process.exit(32);
if(args.includes('status')) process.exit(fs.existsSync('.local/ready')?0:3);
if(args.includes('start') && args.includes('-w')) {
  if(fs.existsSync('.local/start-fails')||fs.existsSync('.local/ready')) process.exit(33);
  fs.writeFileSync('.local/ready','started server');process.exit(0);
}
process.exit(34);
`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/.bin/pg_isready'), `#!/usr/bin/env node
import fs from 'node:fs';
process.exit(fs.existsSync('.local/ready')&&!fs.existsSync('.local/not-ready')?0:1);
`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/.bin/turbo'), `#!/usr/bin/env node
import fs from 'node:fs';
if(fs.existsSync('.local/needs-database')&&!fs.existsSync('.local/ready')) {
  console.error('API and dashboard were launched before the database was ready');process.exit(17);
}
fs.writeFileSync('.local/apps-started','');
`, { mode: 0o755 });
  return root;
}

async function dev(root, overrides = {}) {
  const env = { ...process.env, ...overrides, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` };
  if (!Object.hasOwn(overrides, 'DATABASE_URL')) delete env.DATABASE_URL;
  try {
    return { code: 0, ...await run('npm', ['run', 'dev'], { cwd: root, env, timeout: 15_000 }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('root npm run dev database startup', () => {
  it('starts the stopped project database before launching either app', async () => {
    const root = fixture();
    const result = await dev(root);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(root, '.local/ready'), 'utf8')).toBe('started server');
    expect(existsSync(join(root, '.local/apps-started'))).toBe(true);
    expect(readFileSync(join(root, '.local/ff-demo-users.json'), 'utf8')).toBe('credential-file-must-stay-unchanged');
  });

  it('reuses an already running database without starting a second server', async () => {
    const root = fixture({ running: true });
    const result = await dev(root);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(root, '.local/ready'), 'utf8')).toBe('existing server');
    expect(existsSync(join(root, '.local/apps-started'))).toBe(true);
  });

  it('stops before launching apps when PostgreSQL cannot start', async () => {
    const root = fixture({ startFails: true });
    const result = await dev(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Could not start the local demo database');
    expect(existsSync(join(root, '.local/apps-started'))).toBe(false);
  });

  it('does not launch apps when a running server is not accepting connections', async () => {
    const root = fixture({ running: true });
    writeFileSync(join(root, '.local/not-ready'), '');
    const result = await dev(root);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(root, '.local/apps-started'))).toBe(false);
  });

  it('does not recreate missing database storage or credentials', async () => {
    const root = fixture({ missingCluster: true });
    const result = await dev(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('has not been initialized');
    expect(existsSync(join(root, '.local/postgres-data'))).toBe(false);
    expect(readFileSync(join(root, '.local/ff-demo-users.json'), 'utf8')).toBe('credential-file-must-stay-unchanged');
    expect(existsSync(join(root, '.local/apps-started'))).toBe(false);
  });

  it('leaves separately configured databases under their existing management', async () => {
    const root = fixture({ external: true });
    const result = await dev(root);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(root, '.local/ready'))).toBe(false);
    expect(existsSync(join(root, '.local/apps-started'))).toBe(true);
  });

  it('honors an exported database URL ahead of the workspace env file', async () => {
    const root = fixture();
    rmSync(join(root, '.local/needs-database'));
    const result = await dev(root, { DATABASE_URL: 'postgres://user:private-value@db.example.test/other' });
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(root, '.local/ready'))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('private-value');
  });
});
