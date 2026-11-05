import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as db from '@fluent-flow/db';

const git = promisify(execFile);
export class LocalRunnerError extends Error {}

function readEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}
function privateFile(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
function saveState(file, value) { privateFile(file, `${JSON.stringify(value, null, 2)}\n`); }

async function ensureDemoRepository(directory) {
  if (existsSync(directory)) {
    if (!existsSync(join(directory, '.git'))) throw new LocalRunnerError('The demo repository directory already exists without Git. Move it aside explicitly; it was not overwritten.');
    return;
  }
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'README.md'), '# Runner demo\n\nDisposable local repository for Fluent Flow task execution.\n\nRun `npm test`. The initial add implementation is intentionally wrong. Try a task asking the agent to fix add and make the tests pass.\n\nParent: [local runner notes](../README.md).\n');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fluent-flow-runner-demo', private: true, scripts: { test: 'node --test' } }, null, 2)+'\n');
  writeFileSync(join(directory, 'math.mjs'), 'export function add(a, b) { return a - b; }\n');
  writeFileSync(join(directory, 'math.test.mjs'), "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './math.mjs';\ntest('adds positive numbers',()=>assert.equal(add(2,3),5));\ntest('adds negative numbers',()=>assert.equal(add(-2,-3),-5));\n");
  await git('git', ['init', '-b', 'main', directory]);
  await git('git', ['-C', directory, 'add', '.']);
  await git('git', ['-C', directory, '-c', 'user.name=Fluent Flow Demo', '-c', 'user.email=demo@example.test', 'commit', '-m', 'Initial disposable runner exercise']);
}

export async function prepareLocalRunner({ root, paseo, profileId }) {
  const serverEnv = readEnv(join(root, 'packages/fluent-flow/.env.local'));
  const dashboardEnv = readEnv(join(root, 'packages/dashboard/.env.local'));
  const databaseUrl = process.env.DATABASE_URL ?? serverEnv.DATABASE_URL;
  if (process.env.NODE_ENV === 'production' || serverEnv.NODE_ENV === 'production') {
    throw new LocalRunnerError('The local demo runner cannot run in production mode.');
  }
  let database, api;
  try {
    database = new URL(databaseUrl);
    api = new URL(process.env.FF_COLLAB_API_URL ?? dashboardEnv.FF_COLLAB_API_URL ?? 'http://127.0.0.1:3847');
  } catch { throw new LocalRunnerError('Configure the local demo database and API before running npm run runner.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || !/^\/ff_[a-z0-9_]+$/.test(database.pathname) ||
      !['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) ||
      !['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.pathname !== '/') {
    throw new LocalRunnerError('The test runner requires a loopback ff_* database and loopback API.');
  }
  const allowedDatabase = process.env.FF_LOCAL_RUNNER_DATABASE ?? serverEnv.FF_LOCAL_RUNNER_DATABASE ?? 'ff_demo';
  if (database.pathname !== `/${allowedDatabase}`) {
    throw new LocalRunnerError('The local runner requires the ff_demo database. For another disposable database, explicitly set FF_LOCAL_RUNNER_DATABASE to its name.');
  }
  const secret = process.env.FF_COLLAB_AUTH_SECRET ?? serverEnv.FF_COLLAB_AUTH_SECRET;
  if (!secret) throw new LocalRunnerError('Configure the shared local collaboration secret before starting the runner.');
  process.env.DATABASE_URL = databaseUrl;
  const fixtureFile = join(root, '.local/ff-demo-users.json');
  if (!existsSync(fixtureFile)) throw new LocalRunnerError('Local demo credentials are missing. Run the fixture setup with .local/ff-demo-users.json as its output.');
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  const owner = fixture.principals?.find(p => p.email === 'fixture-owner-a@example.test' && p.password);
  const principal = owner && await db.authenticateCollabPassword({ email: owner.email, password: owner.password, rateLimitKey: 'local-runner-bootstrap' });
  if (!principal || principal.id !== owner.principalId) throw new LocalRunnerError('The saved demo owner credentials are unavailable or invalid; no credentials were reset.');
  const actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const base = api.origin;
  async function request(path, { method = 'GET', body, waitForReady = false } = {}) {
    const deadline = Date.now() + 10_000;
    let response;
    while (true) {
      try {
        response = await fetch(`${base}/api/collab/v1${path}`, {
          method, headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, secret) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (!(waitForReady && response.status === 503 && Date.now() < deadline)) break;
        await response.body?.cancel();
      } catch {
        if (!waitForReady || Date.now() >= deadline) throw new LocalRunnerError('The local API is unavailable. Start npm run dev in another terminal first.');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!response.ok) throw new LocalRunnerError(`Local runner setup was rejected by the API (${response.status}).`);
    return response.status === 204 ? null : (await response.json()).data;
  }
  const me = await request('/me', { waitForReady: true });
  const projectId = fixture.projects?.find(p => p.name === 'Project A1')?.id;
  const project = me.workspaces.flatMap(w => w.projects).find(p => p.id === projectId);
  if (!project) throw new LocalRunnerError('Project A1 is unavailable to the saved demo owner.');

  const lease = await db.getPool().connect();
  const lockKey = `local-runner:project:${projectId}`;
  let acquired = false, released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { if (acquired) await lease.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); }
    finally { lease.release(); }
  };
  try {
    acquired = (await lease.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey])).rows[0].acquired;
    if (!acquired) throw new LocalRunnerError('A local runner is already running for this project.');
    const dir = join(root, '.local/runner');
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    if (!existsSync(join(dir, 'README.md'))) {
      privateFile(join(dir, 'README.md'), '# Local execution runner\n\nPrivate persistent state for `npm run runner`.\n\n- `state.json` and `host-token`: enrollment credential and stable host identity; never share or commit.\n- `connector.json`: connector configuration, pointing to the token file.\n- `connector-local-demo-*`: durable connector journal, redaction context and installed-CLI cache. Keep these across restarts.\n- [demo](demo/README.md): disposable Git repository used by Project A1. Existing edits are preserved.\n\nRun `npm run dev` and `npm run runner` in separate terminals from the repository root. An existing Paseo daemon and configured coding profile are required. Use `npm run runner -- --profile <id>` to select another existing profile. Ctrl+C stops the connector; it does not stop Paseo or delete worktrees or this state. Task Start is required to launch AI work.\n\nParent: [local demo notes](../README.md). Connector: [runner guide](../../packages/fluent-flow-runner/README.md).\n');
    }
    const stateFile = join(dir, 'state.json');
    const pendingEnrollment = join(dir, 'enrollment-pending.json');
    let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const databaseKey = `${database.hostname}:${database.port || '5432'}${database.pathname}`;
    if (state && (state.serverUrl !== base || state.databaseKey !== databaseKey || state.projectId !== projectId)) {
      throw new LocalRunnerError('The saved runner belongs to another local database or project; restore its matching configuration.');
    }
    if (!state && existsSync(pendingEnrollment)) {
      throw new LocalRunnerError('A previous runner enrollment was interrupted. Restore its private state or revoke the unused Local demo runner in settings before explicitly removing enrollment-pending.json; no new host was enrolled.');
    }
    if (!state && readdirSync(dir).some(name => name !== 'demo' && name !== 'README.md')) {
      throw new LocalRunnerError('Runner state is missing but private runner files remain. Restore the saved state before continuing.');
    }
    const profiles = (await paseo.config.get()).config.agentProfiles ?? [];
    const selectedId = profileId ?? state?.profileId;
    const profile = selectedId ? profiles.find(p => p.id === selectedId) : profiles.find(p => p.provider === 'omp' && p.model === 'ai3/qwen38-flash' && p.name.toLowerCase().includes('coder'));
    if (!profile) throw new LocalRunnerError('No matching coding profile is available. Choose an existing Paseo profile with --profile <id>.');
    const repository = join(dir, 'demo');
    await ensureDemoRepository(repository);
    if (state) {
      const host = (await request('/hosts')).find(h => h.id === state.hostId);
      if (!host || host.revokedAt || !state.token) throw new LocalRunnerError('The saved runner enrollment is missing or revoked; it was not replaced.');
      if (existsSync(pendingEnrollment)) unlinkSync(pendingEnrollment);
    } else {
      saveState(pendingEnrollment, { serverUrl: base, databaseKey, projectId, startedAt: new Date().toISOString() });
      const host = await request('/hosts', { method: 'POST', body: { name: 'Local demo runner' } });
      state = { serverUrl: base, databaseKey, projectId, hostId: host.id, token: host.token, instanceId: `local-demo-${randomUUID()}` };
      saveState(stateFile, state);
      unlinkSync(pendingEnrollment);
    }
    const previousIds = state.profileIds ?? [];
    state.profileId = profile.id;
    state.profileIds = [...new Set([...previousIds, profile.id])].filter(id => profiles.some(p => p.id === id));
    saveState(stateFile, state);
    const tokenFile = join(dir, 'host-token'); privateFile(tokenFile, state.token+'\n');
    const file = join(dir, 'connector.json');
    const diskConfig = { serverUrl: base, tokenFile, instanceId: state.instanceId, repositories: { demo: repository }, profiles: state.profileIds, paseo: { home: process.env.PASEO_HOME || join(process.env.HOME, '.paseo') } };
    saveState(file, diskConfig);
    const config = { ...diskConfig, file, token: state.token };

    async function configureProject() {
      const mappings = await request(`/projects/${projectId}/mappings`);
      let mapping = mappings.find(m => m.hostId === state.hostId && m.repositoryKey === 'demo' && m.defaultProfileId === profile.id);
      const current = (await request('/me')).workspaces.flatMap(w => w.projects).find(p => p.id === projectId);
      const defaults = current.executionDefaults;
      const existingDemoDefaults = defaults && mappings.some(m => m.id === defaults.mappingId && m.hostId === state.hostId && m.repositoryKey === 'demo');
      if (defaults && !(defaults.mappingId === mapping?.id && defaults.profileId === profile.id) && !(profileId && existingDemoDefaults)) {
        throw new LocalRunnerError('Project A1 uses other execution defaults. Select the local demo mapping in project settings explicitly.');
      }
      if (!mapping) mapping = await request(`/projects/${projectId}/mappings`, { method: 'POST', body: { hostId: state.hostId, repositoryKey: 'demo', baseRef: 'main', profileIds: [profile.id], defaultProfileId: profile.id } });
      if (!defaults || defaults.mappingId !== mapping.id || defaults.profileId !== profile.id) {
        await request(`/projects/${projectId}`, { method: 'PATCH', body: { expectedVersion: current.version, executionDefaults: { mappingId: mapping.id, profileId: profile.id, model: null, instructions: defaults?.instructions ?? '', summary: { enabled: false } } } });
      }
      return mapping;
    }
    return { config, profile, project, configureProject, release };
  } catch (error) { await release(); throw error; }
}

export async function serveLocalRunner({ runtime, prepared, signals = process, log = console.log }) {
  let stopping = false;
  const shutdown = () => { stopping = true; runtime.loop.stop(); };
  signals.once('SIGINT', shutdown); signals.once('SIGTERM', shutdown);
  try {
    await runtime.loop.register();
    if (stopping) return;
    await prepared.configureProject();
    if (stopping) return;
    log(`Local demo runner is ready for ${prepared.project.name}.`);
    log(`Profile: ${prepared.profile.name} (${prepared.profile.provider}, ${prepared.profile.model ?? 'provider default'}).`);
    log('Open http://localhost:3000/board, select Project A1, and use the task Execution tab to Start work.');
    log('Demo exercise: ask the agent to fix add so npm test passes. Ctrl+C stops this connector.');
    if (!stopping) await runtime.start();
  } finally {
    signals.removeListener('SIGINT', shutdown); signals.removeListener('SIGTERM', shutdown);
    try { await runtime.close(); } finally { await prepared.release(); }
  }
}
