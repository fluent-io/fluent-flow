import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as db from '@fluent-flow/db';
import { loadLocalProfiles, loadConnectorConfig, ConnectorConfigError, assertUniqueProfileIds } from '../packages/fluent-flow-runner/src/connector/config.js';
import { SHUTDOWN_UNCERTAIN } from '../packages/fluent-flow-runner/src/supervisor/cli.js';

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

const README = `# Local execution runner

Private persistent state for \`npm run runner\`.

- \`profiles.json\`: execution profiles you write yourself (format below). Fluent Flow reads it and never rewrites it.
- \`state.json\` and \`host-token\`: enrollment credential and stable host identity; never share or commit.
- \`connector.json\`: connector configuration generated on each start, pointing to the token file.
- \`connector-local-demo-*\`: durable connector journal, redaction context and installed-CLI cache. Keep these across restarts.
- [demo](demo/README.md): disposable Git repository used by Project A1. Existing edits are preserved.

Run \`npm run dev\` and \`npm run runner -- --profile <id>\` in separate terminals from the repository root. \`--profile\` chooses the project default among the advertised profiles; later starts reuse the saved default. Ctrl+C stops the connector; it does not delete worktrees or this state. Task Start is required to launch AI work.

## Execution profiles

\`profiles.json\` lists standalone profiles. Every field is required; nothing is filled in for you, and a profile with a missing or invalid field is reported as incomplete and not offered.

\`\`\`json
{
  "profiles": [
    { "id": "claude-main", "name": "Claude", "backend": "claude-code", "executable": "/absolute/path/to/claude",
      "contextDir": "/absolute/private/claude-context", "model": "<model>", "policy": { "permissionMode": "<mode>" } },
    { "id": "codex-main", "name": "Codex", "backend": "codex", "executable": "/absolute/path/to/codex",
      "contextDir": "/absolute/private/codex-context", "model": "<model>",
      "policy": { "approvalPolicy": "<policy>", "sandbox": "<sandbox>", "networkAccess": false } }
  ],
  "capacity": { "claude-code": 1, "codex": 1 }
}
\`\`\`

- \`id\`: lowercase letters, digits, \`.\`, \`_\` or \`-\`, up to 64 characters, and unique: an id used twice, or also used by a saved Paseo profile, stops startup.
- \`contextDir\`: an existing directory you own with no group or other permissions (\`chmod 700\`). It holds that tool's own sign-in and settings.
- \`capacity\`: optional per-tool limit on concurrent work on this host, an integer of at least 1 (default 1).
- Claude \`permissionMode\`: one of \`acceptEdits\`, \`auto\`, \`bypassPermissions\`, \`manual\`, \`dontAsk\`, \`plan\`. Network and tool access follow this mode. A reasonable starting point is \`manual\`.
- Codex \`approvalPolicy\`: \`untrusted\`, \`on-request\` or \`never\`; \`sandbox\`: \`read-only\`, \`workspace-write\` or \`danger-full-access\`. A reasonable starting point is \`on-request\` with \`workspace-write\`, then review its effect before relying on it.

These suggestions are not applied. Write the values you choose.

Sign in once in each dedicated context, from a terminal:

- Claude: \`CLAUDE_CONFIG_DIR=<contextDir> claude\`, then \`/login\`.
- Codex: \`CODEX_HOME=<contextDir> codex login\`.

## Paseo integration

Paseo is optional. It is used only when you start with \`npm run runner -- --enable-integration paseo\`. Saved Paseo profiles and defaults are kept but not offered when the flag is absent.

Parent: [local demo notes](../README.md). Connector: [runner guide](../../packages/fluent-flow-runner/README.md).
`;

const SAVED_DEFAULT_NOT_ADVERTISED = 'The saved project default profile is not advertised in this runner session. Select an available execution profile before Start.';
const PRIVATE_OWNER_FILES = new Set(['demo', 'README.md', 'profiles.json']);

export async function prepareLocalRunner({ root, profileId, enableIntegrations = [], connectPaseo, warn = console.error }) {
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

  const paseoEnabled = enableIntegrations.includes('paseo');
  let paseo = null;
  const lease = await db.getPool().connect();
  const lockKey = `local-runner:project:${projectId}`;
  let acquired = false, released = false;
  const releaseLock = async () => {
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
    if (!existsSync(join(dir, 'README.md'))) privateFile(join(dir, 'README.md'), README);
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
    if (!state && readdirSync(dir).some(name => !PRIVATE_OWNER_FILES.has(name))) {
      throw new LocalRunnerError('Runner state is missing but private runner files remain. Restore the saved state before continuing.');
    }
    const profilesFile = join(dir, 'profiles.json');
    const ownerProfiles = existsSync(profilesFile) ? JSON.parse(readFileSync(profilesFile, 'utf8')) : {};
    const local = existsSync(profilesFile) ? loadLocalProfiles({ file: profilesFile }) : { profiles: [] };
    const standalone = local.profiles.filter(p => p.complete).map(p => ({ id: p.id, name: p.name, provider: p.backend, model: p.model }));
    const savedPaseoIds = state?.profileIds ?? [];
    const localIds = local.profiles.map(p => p.id).filter(Boolean);
    assertUniqueProfileIds(localIds, savedPaseoIds);
    let paseoProfiles = [];
    if (paseoEnabled) {
      paseo = await connectPaseo();
      paseoProfiles = (await paseo.config.get()).config.agentProfiles ?? [];
      assertUniqueProfileIds(localIds, paseoProfiles.map(p => p.id));
    }
    const available = [...standalone, ...paseoProfiles];
    const selectedId = profileId ?? state?.profileId;
    const profile = selectedId ? available.find(p => p.id === selectedId) ?? null : null;
    const paseoIds = paseoEnabled
      ? [...new Set([...savedPaseoIds, ...(profile && paseoProfiles.includes(profile) ? [profile.id] : [])])].filter(id => paseoProfiles.some(p => p.id === id))
      : savedPaseoIds;
    if (standalone.length === 0 && !(paseoEnabled && paseoIds.length > 0)) {
      throw new ConnectorConfigError(paseoIds.length > 0 && !paseoEnabled ? 'paseo_opt_in_required' : 'no_complete_profile');
    }
    if (profileId && !profile) throw new LocalRunnerError('No matching execution profile is available. Choose a complete execution profile with --profile <id>.');
    if (!profile && !state) throw new LocalRunnerError('No matching execution profile is available. Choose a complete execution profile with --profile <id>.');
    if (!profile && state?.profileId) warn(SAVED_DEFAULT_NOT_ADVERTISED);
    const advertisedIds = [...standalone.map(p => p.id), ...(paseoEnabled ? paseoIds : [])];
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
    if (profile) state.profileId = profile.id;
    state.profileIds = paseoIds;
    saveState(stateFile, state);
    const tokenFile = join(dir, 'host-token'); privateFile(tokenFile, state.token+'\n');
    const file = join(dir, 'connector.json');
    const diskConfig = { serverUrl: base, tokenFile, instanceId: state.instanceId, repositories: { demo: repository },
      profiles: ownerProfiles.profiles ?? [], capacity: ownerProfiles.capacity,
      integrations: { paseo: { profiles: paseoIds, home: process.env.PASEO_HOME || join(process.env.HOME, '.paseo') } } };
    saveState(file, diskConfig);
    const config = loadConnectorConfig({ file, enableIntegrations });

    async function configureProject() {
      const mappings = await request(`/projects/${projectId}/mappings`);
      const current = (await request('/me')).workspaces.flatMap(w => w.projects).find(p => p.id === projectId);
      const defaults = current.executionDefaults;
      if (!profile) return mappings.find(m => m.id === defaults?.mappingId) ?? null;
      let mapping = mappings.find(m => m.hostId === state.hostId && m.repositoryKey === 'demo' && m.defaultProfileId === profile.id);
      const existingDemoDefaults = defaults && mappings.some(m => m.id === defaults.mappingId && m.hostId === state.hostId && m.repositoryKey === 'demo');
      if (defaults && !(defaults.mappingId === mapping?.id && defaults.profileId === profile.id) && !(profileId && existingDemoDefaults)) {
        throw new LocalRunnerError('Project A1 uses other execution defaults. Select the local demo mapping in project settings explicitly.');
      }
      if (!mapping) mapping = await request(`/projects/${projectId}/mappings`, { method: 'POST', body: { hostId: state.hostId, repositoryKey: 'demo', baseRef: 'main', profileIds: advertisedIds, defaultProfileId: profile.id } });
      if (!defaults || defaults.mappingId !== mapping.id || defaults.profileId !== profile.id) {
        await request(`/projects/${projectId}`, { method: 'PATCH', body: { expectedVersion: current.version, executionDefaults: { mappingId: mapping.id, profileId: profile.id, model: null, instructions: defaults?.instructions ?? '', summary: { enabled: false } } } });
      }
      return mapping;
    }
    return { config, profile, project, paseo, configureProject, release: releaseLock };
  } catch (error) {
    try { await paseo?.close?.(); } finally { await releaseLock(); }
    throw error;
  }
}

export async function serveLocalRunner({ runtime, prepared, signals = process, log = console.log }) {
  let stopping = false;
  let stop = null;
  const shutdown = () => { stopping = true; runtime.loop.stop(); };
  signals.once('SIGINT', shutdown); signals.once('SIGTERM', shutdown);
  try {
    await runtime.loop.register();
    if (!stopping) await prepared.configureProject();
    if (!stopping) {
      log(`Local demo runner is ready for ${prepared.project.name}.`);
      log(prepared.profile ? `Profile: ${prepared.profile.name} (${prepared.profile.provider}, ${prepared.profile.model ?? 'provider default'}).` : SAVED_DEFAULT_NOT_ADVERTISED);
      log('Open http://localhost:3000/board, select Project A1, and use the task Execution tab to Start work.');
      log('Demo exercise: ask the agent to fix add so npm test passes. Ctrl+C stops this connector.');
      await runtime.start();
    }
  } finally {
    signals.removeListener('SIGINT', shutdown); signals.removeListener('SIGTERM', shutdown);
    try { ({ stop } = await runtime.close({ intentional: stopping })); } finally { await prepared.release(); }
  }
  if (stop !== 'uncertain') return 0;
  log(SHUTDOWN_UNCERTAIN);
  return 1;
}
