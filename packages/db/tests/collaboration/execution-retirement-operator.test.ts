import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { freezeLegacyExecution, readLegacyExecutionInventory } from '../../src/collaboration/execution-retirement.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const cliPath = fileURLToPath(new URL('../../scripts/execution-retirement.mjs', import.meta.url));
let hostToken: string;
let runId: string;
let sessionId: string;
let ambiguousId: string;
let acceptedId: string;

beforeAll(() => {
  process.env.FF_COLLAB_AUTH_SECRET = 'retirement-operator-fixture-0123456789abcdef';
});

beforeEach(async () => {
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 88782, login: 'retirement-operator' });
  await seedOrgMembership(databaseUrl, userId, 'retirement-operator-org', 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Retirement operator', email: 'retirement-operator@example.test' });
  const actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId: 'retirement-operator-org', name: 'Operator workspace', idempotencyKey: randomUUID() });
  const project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Operator project' });
  const host = await db.createExecutionHost({ actor, name: 'Private operator host canary' });
  hostToken = host.token;
  const mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'private/operator-repo', profileIds: ['operator'], defaultProfileId: 'operator' });
  await db.registerConnector({ token: host.token, instanceId: 'retirement-operator', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {},
    catalog: { repositories: [{ key: 'private/operator-repo' }], profiles: [{ id: 'operator', provider: 'fixture', model: 'fixture' }] } });
  await db.updateProjectExecutionDefaults({ actor, projectId: project.id, expectedVersion: project.version,
    executionDefaults: { mappingId: mapping.id, profileId: 'operator', model: null, instructions: 'Private operator instruction canary', summary: { enabled: false, profileId: null, model: null } } });
  const task = await db.createCollabTask({ actor, projectId: project.id, title: 'Existing operator work' });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID() });
  if (!('sessionId' in started)) throw new Error('Operator fixture requires internal execution access');
  runId = started.run.id;
  sessionId = started.sessionId;
  ambiguousId = (await db.submitSessionCommand({ actor, sessionId, idempotencyKey: randomUUID(), command: { kind: 'prompt', text: 'Ambiguous private prompt canary', behavior: 'steer' } })).commandId;
  acceptedId = (await db.submitSessionCommand({ actor, sessionId, idempotencyKey: randomUUID(), command: { kind: 'prompt', text: 'Accepted private prompt canary', behavior: 'steer' } })).commandId;
  await getPool().query("UPDATE collab_connector_commands SET state=CASE WHEN id=$1 THEN 'ambiguous' ELSE 'accepted' END WHERE id=ANY($2::uuid[])", [ambiguousId, [ambiguousId, acceptedId]]);
  await getPool().query("UPDATE collab_runs SET state='idle',workspace_id='/private/operator/workspace-canary' WHERE id=$1", [runId]);
  await getPool().query("UPDATE collab_sessions SET state='idle' WHERE id=$1", [sessionId]);
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 5000, env: { ...process.env, DATABASE_URL: databaseUrl } });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error('The operator CLI did not exit normally');
  return result;
}

function expectPrivateValuesAbsent(value: string) {
  for (const secret of [hostToken, 'Private operator host canary', 'Private operator instruction canary', 'Ambiguous private prompt canary', 'Accepted private prompt canary', '/private/operator/workspace-canary', 'private/operator-repo']) {
    expect(value).not.toContain(secret);
  }
}

it('counts idle and ambiguous persisted work as unsettled without claiming remote drain or revealing payloads', async () => {
  const before = await readLegacyExecutionInventory();
  expect(before).toMatchObject({ scope: 'server_records_only', frozenAt: null, hosts: { unrevoked: '1' }, mappings: '1', storedLegacyDefaults: '1',
    runs: { unsettled: '1', states: [{ state: 'idle', count: '1' }] }, sessions: { unsettled: '1', states: [{ state: 'idle', count: '1' }] },
    commands: { unsettled: '3', states: expect.arrayContaining([{ state: 'ambiguous', kind: 'prompt', count: '1' }, { state: 'accepted', kind: 'prompt', count: '1' }]) } });
  expectPrivateValuesAbsent(JSON.stringify(before));
  expect(before).not.toHaveProperty('readyForRemoval');
  await getPool().query("UPDATE collab_runs SET state='cancelled' WHERE id=$1", [runId]);
  await getPool().query("UPDATE collab_sessions SET state='cancelled' WHERE id=$1", [sessionId]);
  await getPool().query("UPDATE collab_connector_commands SET state='cancelled' WHERE run_id=$1", [runId]);
  const after = await readLegacyExecutionInventory();
  expect(after).toMatchObject({ scope: 'server_records_only', frozenAt: null, hosts: { unrevoked: '1' }, runs: { unsettled: '0' }, sessions: { unsettled: '0' }, commands: { unsettled: '0' } });
  expect(after).not.toHaveProperty('readyForRemoval');
});

it('uses the actual CLI for read-only inventory and requires explicit global freeze confirmation', async () => {
  const initial = await readLegacyExecutionInventory();
  const inventory = runCli(['inventory']);
  expect(inventory.status).toBe(0);
  expect(JSON.parse(inventory.stdout)).toMatchObject({ scope: 'server_records_only', runs: { unsettled: '1' }, sessions: { unsettled: '1' }, commands: { unsettled: '3' } });
  expectPrivateValuesAbsent(inventory.stdout + inventory.stderr);
  const unconfirmed = runCli(['freeze']);
  expect(unconfirmed.status).not.toBe(0);
  expect(await readLegacyExecutionInventory()).toEqual(initial);
  const frozen = runCli(['freeze', '--confirm-all-legacy-execution']);
  expect(frozen.status).toBe(0);
  const result = JSON.parse(frozen.stdout);
  const state = await readLegacyExecutionInventory();
  expect(state.frozenAt).not.toBeNull();
  expect(result.frozenAt).toBe(state.frozenAt);
  expect(state.hosts).toEqual(initial.hosts);
  expect(state.commands).toEqual(initial.commands);
  expectPrivateValuesAbsent(unconfirmed.stdout + unconfirmed.stderr + frozen.stdout + frozen.stderr);
});

it('fails closed when the control record is absent instead of reporting an open or empty system', async () => {
  const available = runCli(['inventory']);
  expect(available.status).toBe(0);
  expect(JSON.parse(available.stdout)).toMatchObject({ runs: { unsettled: '1' } });
  const frozen = await freezeLegacyExecution();
  try {
    await getPool().query('DELETE FROM collab_legacy_execution_control');
    await expect(readLegacyExecutionInventory()).rejects.toMatchObject({ status: 500, code: 'configuration_error' });
    const result = runCli(['inventory']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expectPrivateValuesAbsent(result.stderr);
  } finally {
    await getPool().query('INSERT INTO collab_legacy_execution_control(singleton,frozen_at) VALUES(true,$1)', [frozen.frozenAt]);
  }
});
