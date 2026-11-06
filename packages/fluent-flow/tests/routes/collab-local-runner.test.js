import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { resolveCollabTestDatabaseUrl, resetCollabSchema } from '../helpers/collab-db.js';
import { createConnectorClient } from '../../../fluent-flow-runner/src/connector/connector-client.js';
import { createConnectorRuntime } from '../../../fluent-flow-runner/src/connector/runtime.js';
import { fakePaseoSdk } from '../../../fluent-flow-runner/tests/unit/connector/helpers/fake-paseo.js';

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '../../../..');
const database = resolveCollabTestDatabaseUrl();
const secret = 'local-runner-fixture-secret-01234567890123456789';
process.env.DATABASE_URL = database;
process.env.FF_COLLAB_AUTH_SECRET = secret;
process.env.LOG_LEVEL = 'silent';
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');
const profile = { id: 'local-coder', name: 'Coder', provider: 'omp', model: 'ai3/qwen38-flash', modeId: 'full', thinkingOptionId: 'minimal' };
const paseo = { config: { get: async () => ({ config: { agentProfiles: [profile] } }) } };
let server, url, root;
let dropProfileReads = 0;
let dropEnrollmentResponses = 0;
let polls = 0;
const preparedRunners = [];
const extraRoots = [];

beforeAll(async () => {
  const app = createApp();
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/connector/v1/poll')) polls++;
    if (req.method === 'GET' && req.url === '/api/collab/v1/me' && dropProfileReads > 0) {
      dropProfileReads--; req.socket.destroy(); return;
    }
    if (req.method === 'POST' && req.url === '/api/collab/v1/hosts' && dropEnrollmentResponses > 0) {
      dropEnrollmentResponses--;
      res.end = () => { req.socket.destroy(); return res; };
    }
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await db.closePool(); await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  await db.closePool();
  dropProfileReads = 0;
  dropEnrollmentResponses = 0;
  polls = 0;
  process.env.DATABASE_URL = database;
  await resetCollabSchema(database);
  root = mkdtempSync(join(tmpdir(), 'ff-local-runner-'));
  mkdirSync(join(root, '.local'), { mode: 0o700 });
  mkdirSync(join(root, 'packages/fluent-flow'), { recursive: true });
  mkdirSync(join(root, 'packages/dashboard'), { recursive: true });
  writeFileSync(join(root, 'packages/fluent-flow/.env.local'), `DATABASE_URL=${database}\nFF_LOCAL_RUNNER_DATABASE=${new URL(database).pathname.slice(1)}\nFF_COLLAB_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'packages/dashboard/.env.local'), `FF_COLLAB_API_URL=${url}\n`, { mode: 0o600 });
  const seed = `import {pathToFileURL} from 'node:url';
    const [file,index,...args]=process.argv.slice(1);
    process.argv=[process.execPath,file,...args];
    await import(pathToFileURL(file).href);
    await (await import(pathToFileURL(index).href)).pool.end();`;
  await run(process.execPath, ['--input-type=module', '-e', seed, join(repo, 'packages/db/scripts/collab-fixture.mjs'), join(repo, 'packages/db/dist/index.js'), '--database', database, '--output', join(root, '.local/ff-demo-users.json')], { timeout: 7000 });
});
afterEach(async () => {
  for (const prepared of preparedRunners.splice(0)) await prepared.release();
  rmSync(root, { recursive: true, force: true });
  for (const extra of extraRoots.splice(0)) rmSync(extra, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function prepare(options = {}) {
  const { prepareLocalRunner } = await import('../../../../scripts/dev-runner-setup.mjs');
  const prepared = await prepareLocalRunner({ root, paseo, ...options });
  preparedRunners.push(prepared);
  return prepared;
}
async function register(prepared) {
  return createConnectorClient({ serverUrl: url, token: prepared.config.token }).register({
    instanceId: prepared.config.instanceId, protocolVersion: 1, sdkVersion: '0.12.0',
    capabilities: {}, catalog: { repositories: [{ key: 'demo' }], profiles: [profile] },
  });
}

it('prepares an enrolled private runner and disposable Git repo, then makes Project A1 executable', async () => {
  const prepared = await prepare();
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
  expect(prepared.profile.id).toBe('local-coder');
  expect(prepared.config.repositories.demo).toBe(join(root, '.local/runner/demo'));
  expect((await run('git', ['-C', prepared.config.repositories.demo, 'status', '--porcelain'])).stdout).toBe('');
  expect(statSync(prepared.config.tokenFile).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, '.local/runner')).mode & 0o777).toBe(0o700);
  expect(readFileSync(prepared.config.tokenFile, 'utf8').trim()).toBe(prepared.config.token);
  await register(prepared);
  await prepared.configureProject();
  const project = (await db.query("SELECT execution_defaults FROM collab_projects WHERE name='Project A1'")).rows[0];
  expect(project.execution_defaults.profileId).toBe('local-coder');
  expect(project.execution_defaults.mappingId).toEqual(expect.any(String));
  expect((await db.query('SELECT count(*)::int AS n FROM collab_runs')).rows[0].n).toBe(0);
});

it('reuses enrollment, mapping and saved passwords without overwriting repository edits or project instructions', async () => {
  const prepared = await prepare();
  await register(prepared); await prepared.configureProject();
  const passwords = readFileSync(join(root, '.local/ff-demo-users.json'), 'utf8');
  writeFileSync(join(prepared.config.repositories.demo, 'notes.txt'), 'human notes');
  const project = (await db.query("SELECT id,version,execution_defaults FROM collab_projects WHERE name='Project A1'")).rows[0];
  await db.query("UPDATE collab_projects SET execution_defaults=jsonb_set(execution_defaults,'{instructions}','\"Human instructions\"') WHERE id=$1", [project.id]);
  await prepared.release();
  const again = await prepare(); await register(again); await again.configureProject();
  expect(again.config.token).toBe(prepared.config.token);
  expect(again.config.instanceId).toBe(prepared.config.instanceId);
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
  expect((await db.query('SELECT count(*)::int AS n FROM collab_project_host_mappings')).rows[0].n).toBe(1);
  expect(readFileSync(join(prepared.config.repositories.demo, 'notes.txt'), 'utf8')).toBe('human notes');
  expect(readFileSync(join(root, '.local/ff-demo-users.json'), 'utf8')).toBe(passwords);
  expect((await db.query('SELECT execution_defaults FROM collab_projects WHERE id=$1', [project.id])).rows[0].execution_defaults.instructions).toBe('Human instructions');
});

it('rejects an unknown profile before enrolling a host', async () => {
  await expect(prepare({ profileId: 'missing' })).rejects.toThrow('profile');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(1);
});

it('rejects unavailable saved credentials without resetting or enrolling', async () => {
  const file = join(root, '.local/ff-demo-users.json');
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  for (const principal of fixture.principals) {
    if (principal.email === 'fixture-owner-a@example.test') principal.password = 'not-the-saved-password';
  }
  writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
  await expect(prepare()).rejects.toThrow('credentials');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(1);
});

it('waits through a transient API restart before enrolling the runner', async () => {
  dropProfileReads = 1;
  const prepared = await prepare();
  expect(prepared.config.repositories.demo).toBe(join(root, '.local/runner/demo'));
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
});

it('rejects a nonlocal control plane before sending credentials or enrolling', async () => {
  writeFileSync(join(root, 'packages/dashboard/.env.local'), 'FF_COLLAB_API_URL=https://example.com\n');
  await expect(prepare()).rejects.toThrow('loopback');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(1);
});

it('rejects production mode before authenticating or enrolling', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  await expect(prepare()).rejects.toThrow('production');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(1);
});

it('rejects a different local ff_* database without an explicit matching opt-in', async () => {
  const unrelated = new URL(database); unrelated.pathname = '/ff_prod';
  vi.stubEnv('DATABASE_URL', unrelated.href);
  await expect(prepare()).rejects.toThrow('ff_demo');
  vi.stubEnv('DATABASE_URL', database);
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(1);
});

it('does not silently replace a revoked enrollment', async () => {
  const prepared = await prepare();
  await db.query('UPDATE collab_hosts SET revoked_at=now() WHERE token_hash=encode(sha256($1::bytea),\'hex\')', [prepared.config.token]);
  await prepared.release();
  await expect(prepare()).rejects.toThrow('revoked');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
});

it('rejects a concurrent local runner before creating a second enrollment', async () => {
  await prepare();
  await expect(prepare()).rejects.toThrow('already running');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
});

it('rejects a concurrent runner from another worktree targeting the same project', async () => {
  await prepare();
  const secondRoot = mkdtempSync(join(tmpdir(), 'ff-local-runner-other-'));
  extraRoots.push(secondRoot);
  mkdirSync(join(secondRoot, '.local'), { mode: 0o700 });
  mkdirSync(join(secondRoot, 'packages/fluent-flow'), { recursive: true });
  mkdirSync(join(secondRoot, 'packages/dashboard'), { recursive: true });
  for (const file of ['.local/ff-demo-users.json', 'packages/fluent-flow/.env.local', 'packages/dashboard/.env.local']) {
    writeFileSync(join(secondRoot, file), readFileSync(join(root, file)), { mode: 0o600 });
  }
  await expect(prepare({ root: secondRoot })).rejects.toThrow('already running');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
});

it('preserves unrelated execution defaults even when their mapping uses the same host', async () => {
  const prepared = await prepare();
  await register(prepared); await prepared.configureProject();
  const project = (await db.query("SELECT id,execution_defaults FROM collab_projects WHERE name='Project A1'")).rows[0];
  const mappingId = project.execution_defaults.mappingId;
  await db.query("UPDATE collab_project_host_mappings SET repository_key='unrelated' WHERE id=$1", [mappingId]);
  await prepared.release();
  const again = await prepare({ profileId: profile.id });
  await register(again);
  await expect(again.configureProject()).rejects.toThrow('other execution defaults');
  expect((await db.query('SELECT execution_defaults FROM collab_projects WHERE id=$1', [project.id])).rows[0].execution_defaults).toEqual(project.execution_defaults);
  expect((await db.query('SELECT count(*)::int AS n FROM collab_project_host_mappings')).rows[0].n).toBe(1);
});

it('does not enroll again after an enrollment commits but its one-time response is lost', async () => {
  dropEnrollmentResponses = 1;
  await expect(prepare()).rejects.toThrow('unavailable');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
  await expect(prepare()).rejects.toThrow('enrollment');
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
  expect(statSync(join(root, '.local/runner/enrollment-pending.json')).mode & 0o777).toBe(0o600);
});

it('recovers an enrollment marker when its valid private state was already saved', async () => {
  const prepared = await prepare();
  await prepared.release();
  const marker = join(root, '.local/runner/enrollment-pending.json');
  writeFileSync(marker, '{}', { mode: 0o600 });
  const again = await prepare();
  expect(again.config.token).toBe(prepared.config.token);
  expect(existsSync(marker)).toBe(false);
  expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
});

it.each(['SIGINT', 'SIGTERM'])('serves the real connector before readiness and cleans up on %s', async signal => {
  const { serveLocalRunner } = await import('../../../../scripts/dev-runner-setup.mjs');
  const prepared = await prepare();
  const sdk = fakePaseoSdk();
  sdk.config = paseo.config;
  sdk.close = vi.fn(async () => {});
  const runtime = await createConnectorRuntime({
    config: { ...prepared.config, paseo: {} }, paseo: sdk, stopAgent: async () => {},
  });
  const signals = new EventEmitter();
  let ready = false;
  const serving = serveLocalRunner({ runtime, prepared, signals, log: message => {
    if (message.startsWith('Local demo runner is ready')) ready = true;
  } });
  try {
    await vi.waitFor(() => { expect(ready).toBe(true); expect(polls).toBeGreaterThan(0); });
    expect(runtime.loop.session.connectorSessionId).toEqual(expect.any(String));
    const defaults = (await db.query("SELECT execution_defaults FROM collab_projects WHERE name='Project A1'")).rows[0].execution_defaults;
    expect(defaults.profileId).toBe(profile.id);
    expect(sdk.state.sends).toEqual([]);
    signals.emit(signal);
    await serving;
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(sdk.close).toHaveBeenCalledOnce();
    const again = await prepare();
    expect(again.config.instanceId).toBe(prepared.config.instanceId);
    expect((await db.query('SELECT count(*)::int AS n FROM collab_hosts')).rows[0].n).toBe(2);
  } finally {
    signals.emit(signal);
    await serving;
  }
});

it('does not overwrite an unexpected pre-existing demo directory', async () => {
  mkdirSync(join(root, '.local/runner/demo'), { recursive: true });
  writeFileSync(join(root, '.local/runner/demo/README.md'), 'do not overwrite');
  await expect(prepare()).rejects.toThrow('repository');
  expect(readFileSync(join(root, '.local/runner/demo/README.md'), 'utf8')).toBe('do not overwrite');
  expect(existsSync(join(root, '.local/runner/demo/.git'))).toBe(false);
});
