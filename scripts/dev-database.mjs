import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function control(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 25_000 });
  if (result.error) {
    throw new Error('PostgreSQL control tools are unavailable. Install the version matching .local/postgres-data/PG_VERSION and put its bin directory on PATH.');
  }
  return result;
}

function ensureDatabase() {
  const envFile = join(root, 'packages/fluent-flow/.env.local');
  let configured = process.env.DATABASE_URL;
  if (configured === undefined && existsSync(envFile)) {
    try {
      configured = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL;
    } catch {
      throw new Error('Could not read local database configuration. Check packages/fluent-flow/.env.local.');
    }
  }
  if (!configured) return;

  let database;
  try {
    database = new URL(configured);
  } catch {
    throw new Error('Invalid DATABASE_URL. Check your development environment.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/ff_demo') return;

  const data = join(root, '.local/postgres-data');
  const versionFile = join(data, 'PG_VERSION');
  if (!existsSync(versionFile)) {
    throw new Error('The local demo database has not been initialized. See the local setup notes before running npm run dev.');
  }
  const version = readFileSync(versionFile, 'utf8').trim();
  if (!/^\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid local PostgreSQL version marker. Existing data was left unchanged.');

  const systemBin = `/usr/lib/postgresql/${version}/bin`;
  const pgCtl = existsSync(join(systemBin, 'pg_ctl')) ? join(systemBin, 'pg_ctl') : 'pg_ctl';
  const pgReady = pgCtl === 'pg_ctl' ? 'pg_isready' : join(systemBin, 'pg_isready');
  const installed = control(pgCtl, ['--version']);
  const installedVersion = installed.stdout.match(/PostgreSQL\)\s+([\d.]+)/)?.[1];
  if (installed.status !== 0 || !installedVersion ||
      !(installedVersion === version || installedVersion.startsWith(`${version}.`))) {
    throw new Error(`PostgreSQL ${version} tools are required for the existing local database. Existing data was left unchanged.`);
  }

  const status = control(pgCtl, ['-D', data, 'status']);
  if (status.status === 3) {
    console.log('Starting the local demo database…');
    const started = control(pgCtl, ['-D', data, '-l', join(root, '.local/postgres.log'), '-w', '-t', '20', 'start']);
    if (started.status !== 0) throw new Error('Could not start the local demo database. See .local/postgres.log.');
  } else if (status.status !== 0) {
    throw new Error('Could not inspect the local demo database. Existing data was left unchanged.');
  }

  const ready = control(pgReady, ['-h', '127.0.0.1', '-p', '55432', '-d', 'ff_demo', '-U', decodeURIComponent(database.username || 'ffuser'), '-t', '5']);
  if (ready.status !== 0) throw new Error('The local demo database is not accepting connections. See .local/postgres.log.');
  console.log('Local demo database is ready.');
}

try {
  ensureDatabase();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
