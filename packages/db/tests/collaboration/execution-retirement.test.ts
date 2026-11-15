import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { freezeLegacyExecution } from '../../src/collaboration/execution-retirement.js';
import { convertCollabIdea, createCollabIdea, getCollabArtifactContent, queueCollabSummary, recordCollabArtifactReport } from '../../src/collaboration/evidence.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
let actor: { principalId: string; sessionVersion: number };
let projectId: string;
let mappingId: string;
let fixtureHostId: string;
let fixtureHostToken: string;
let fixtureConnector: db.ConnectorRegistration;

beforeEach(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'retirement-fixture-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 88781, login: 'retirement-owner' });
  await seedOrgMembership(databaseUrl, userId, 'retirement-org', 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Retirement owner', email: 'retirement@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId: 'retirement-org', name: 'Retirement workspace', idempotencyKey: randomUUID() });
  projectId = (await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Retirement project' })).id;
  const host = await db.createExecutionHost({ actor, name: 'Existing retirement host' });
  fixtureHostId = host.id;
  fixtureHostToken = host.token;
  mappingId = (await db.createProjectHostMapping({ actor, projectId, hostId: host.id, repositoryKey: 'acme/retirement', profileIds: ['retirement'], defaultProfileId: 'retirement' })).id;
  fixtureConnector = await db.registerConnector({ token: host.token, instanceId: 'retirement-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {},
    catalog: { repositories: [{ key: 'acme/retirement' }], profiles: [{ id: 'retirement', provider: 'fixture', model: 'fixture' }] } });
});


afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

async function sourceFixture() {
  const task = await db.createCollabTask({ actor, projectId, title: 'Existing legacy work' });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId, profileId: 'retirement', instructions: 'Finish existing work.' });
  if (!('sessionId' in started)) throw new Error('Retirement fixture requires internal execution access');
  return { task, started };
}

it('makes repeated freeze terminal for new host enrollment without deleting existing configuration', async () => {
  const before = (await getPool().query('SELECT id,name,revoked_at FROM collab_hosts ORDER BY id')).rows;
  const first = await freezeLegacyExecution();
  const repeated = await freezeLegacyExecution();
  let failure;
  try {
    await db.createExecutionHost({ actor, name: 'Must not enroll after freeze' });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
  expect(repeated.frozenAt).toBe(first.frozenAt);
  expect((await getPool().query('SELECT id,name,revoked_at FROM collab_hosts ORDER BY id')).rows).toEqual(before);
});

it('refuses a busy freeze without queuing behind an admitted transaction and preserves its replay receipt', async () => {
  const { started } = await sourceFixture();
  const input = { actor, sessionId: started.sessionId, idempotencyKey: randomUUID(), command: { kind: 'prompt' as const, text: 'One admitted turn.', behavior: 'steer' as const } };
  const client = await getPool().connect();
  const monitor = await getPool().connect();
  let committed = false;
  let freezing: Promise<unknown> | undefined;
  try {
    const admittedPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await client.query('BEGIN');
    const queued = await db.submitSessionCommand(input, client);
    let finished = false;
    freezing = freezeLegacyExecution().then(value => { finished = true; return value; }, error => { finished = true; throw error; });
    const settled = Promise.allSettled([freezing]);
    let observed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await monitor.query<{ waiting: number }>(`SELECT count(*)::int AS waiting
        FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
        WHERE activity.datname=current_database() AND activity.wait_event_type='Lock'
          AND lock.relation='collab_legacy_execution_control'::regclass AND NOT lock.granted
          AND $1=ANY(pg_blocking_pids(activity.pid))`, [admittedPid]);
      if (finished || result.rows[0].waiting > 0) { observed = true; break; }
    }
    expect(observed).toBe(true);
    await client.query('COMMIT');
    committed = true;
    const result = (await settled)[0];
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Busy freeze unexpectedly applied');
    expect(result.reason).toMatchObject({ status: 409, code: 'legacy_execution_busy' });
    await freezeLegacyExecution();
    expect(await db.submitSessionCommand(input)).toEqual({ commandId: queued.commandId, created: false });
    let failure;
    try {
      await db.submitSessionCommand({ ...input, idempotencyKey: randomUUID(), command: { ...input.command, text: 'Must not add a later turn.' } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
    expect((await getPool().query("SELECT id FROM collab_connector_commands WHERE run_id=$1 AND kind='prompt'", [started.run.id])).rows).toEqual([{ id: queued.commandId }]);
  } finally {
    if (!committed) await client.query('ROLLBACK');
    client.release();
    monitor.release();
    if (freezing) await Promise.allSettled([freezing]);
  }
});

async function countRows(query: string, params: unknown[] = []) {
  return (await getPool().query<{ n: number }>(query, params)).rows[0].n;
}

it('rejects new legacy runs, retries, sessions and model turns after freeze while drains keep working', async () => {
  const { task, started } = await sourceFixture();
  const projectVersion = (await getPool().query<{ version: number }>('SELECT version FROM collab_projects WHERE id=$1', [projectId])).rows[0].version;
  await db.updateProjectExecutionDefaults({
    actor, projectId, expectedVersion: projectVersion,
    executionDefaults: { mappingId, profileId: 'retirement', model: null, instructions: 'Finish existing work.', summary: { enabled: true, profileId: 'retirement', model: 'fixture' } },
  });
  await db.submitConnectorObservations({
    token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch,
    events: [{ eventId: randomUUID(), runId: started.run.id, kind: 'workspace_bound', observedAt: new Date().toISOString(), payload: { workspaceId: 'retirement-fixture-workspace' } }],
  });
  const taskVersionBefore = (await getPool().query<{ version: number }>('SELECT version FROM collab_tasks WHERE id=$1', [task.id])).rows[0].version;
  const runsBefore = await countRows('SELECT count(*)::int AS n FROM collab_runs WHERE task_id=$1', [task.id]);
  const sessionsBefore = await countRows('SELECT count(*)::int AS n FROM collab_sessions WHERE run_id=$1', [started.run.id]);
  const commandsBefore = await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id]);
  const idempotencyBefore = await countRows('SELECT count(*)::int AS n FROM collab_idempotency_records WHERE principal_id=$1', [actor.principalId]);
  await freezeLegacyExecution();

  const blockedStartKey = randomUUID();
  let startFailure;
  try {
    await db.startCollabRun({ actor, taskId: task.id, expectedVersion: taskVersionBefore, idempotencyKey: blockedStartKey, mappingId, profileId: 'retirement', instructions: 'Blocked start.' });
  } catch (error) {
    startFailure = error;
  }
  expect(startFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  let retryFailure;
  try {
    await db.startCollabRun({ actor, taskId: task.id, expectedVersion: taskVersionBefore, idempotencyKey: randomUUID(), mappingId, profileId: 'retirement', instructions: 'Blocked retry.', retryOfRunId: started.run.id });
  } catch (error) {
    retryFailure = error;
  }
  expect(retryFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  let sessionFailure;
  try {
    await db.createRunSession({ actor, runId: started.run.id, idempotencyKey: randomUUID(), title: 'Blocked extra session', instructions: '' });
  } catch (error) {
    sessionFailure = error;
  }
  expect(sessionFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  let promptFailure;
  try {
    await db.submitSessionCommand({ actor, sessionId: started.sessionId, idempotencyKey: randomUUID(), command: { kind: 'prompt', text: 'Blocked turn.', behavior: 'steer' } });
  } catch (error) {
    promptFailure = error;
  }
  expect(promptFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  let wrapupFailure;
  try {
    await db.queueRunCommand({ actor, runId: started.run.id, sessionId: started.sessionId, idempotencyKey: randomUUID(), kind: 'wrapup', payload: {} });
  } catch (error) {
    wrapupFailure = error;
  }
  expect(wrapupFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  let summaryFailure;
  try {
    await queueCollabSummary({ actor, runId: started.run.id, idempotencyKey: randomUUID() });
  } catch (error) {
    summaryFailure = error;
  }
  expect(summaryFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });

  expect((await getPool().query<{ version: number }>('SELECT version FROM collab_tasks WHERE id=$1', [task.id])).rows[0].version).toBe(taskVersionBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_runs WHERE task_id=$1', [task.id])).toBe(runsBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_sessions WHERE run_id=$1', [started.run.id])).toBe(sessionsBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id])).toBe(commandsBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_idempotency_records WHERE principal_id=$1', [actor.principalId])).toBe(idempotencyBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_idempotency_records WHERE idempotency_key=$1', [blockedStartKey])).toBe(0);

  await db.registerConnector({ token: fixtureHostToken, instanceId: 'retirement-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {},
    catalog: { repositories: [{ key: 'acme/retirement' }], profiles: [{ id: 'retirement', provider: 'fixture', model: 'fixture' }] } });
  await db.heartbeatConnector({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch });
  const drainEvent = randomUUID();
  const observed = await db.submitConnectorObservations({
    token: fixtureHostToken,
    connectorSessionId: fixtureConnector.connectorSessionId,
    leaseEpoch: fixtureConnector.leaseEpoch,
    events: [{ eventId: drainEvent, runId: started.run.id, sessionId: started.sessionId, kind: 'timeline', observedAt: new Date().toISOString(), payload: { seq: 1 }, providerCursor: { epoch: 'retirement-drain', seq: '1' } }],
  });
  expect(observed.acceptedEventIds).toEqual([drainEvent]);

  await getPool().query(`UPDATE collab_sessions SET state='needs_input' WHERE id=$1`, [started.sessionId]);
  const permission = await db.submitSessionCommand({ actor, sessionId: started.sessionId, idempotencyKey: randomUUID(), command: { kind: 'permission', requestId: randomUUID(), response: { behavior: 'allow' } } });
  expect(permission.created).toBe(true);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id])).toBe(commandsBefore + 1);

  const nativeTask = await db.createCollabTask({ actor, projectId, title: 'Native backlog after freeze' });
  expect(nativeTask.status).toBe('backlog');
  const settings = await db.getProjectChatSettings({ actor, projectId });
  const savedChat = await db.updateProjectChatSettings({ actor, projectId, expectedVersion: settings.version, executionMode: 'chat', defaultAgentId: null, defaults: { profileId: null, model: null, instructions: '' } });
  expect(savedChat.executionMode).toBe('chat');
  const summarySettings = await db.getProjectSummarySettings({ actor, projectId });
  const savedSummary = await db.updateProjectSummarySettings({ actor, projectId, expectedVersion: summarySettings.version, defaults: { enabled: false, agentId: null, profileId: null, model: null } });
  expect(savedSummary.defaults.enabled).toBe(false);
  const native = await db.startCollabClaimExecution({ actor, taskId: nativeTask.id, expectedVersion: nativeTask.version, idempotencyKey: randomUUID(), repo: null, claimType: 'chat' });
  expect((await getPool().query(`SELECT claim.claim_type,claim.status,execution.task_id
    FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id
    WHERE claim.id=$1`, [native.claim.id])).rows).toEqual([{ claim_type: 'chat', status: 'pending', task_id: nativeTask.id }]);
});

it('blocks mapping, default and connector-fallback writes after freeze while native settings stay editable', async () => {
  const initial = await db.getProjectChatSettings({ actor, projectId });
  await db.updateProjectChatSettings({ actor, projectId, expectedVersion: initial.version, executionMode: 'chat', defaultAgentId: null, defaults: { profileId: null, model: null, instructions: '' } });
  const defaultsBefore = (await getPool().query('SELECT execution_defaults FROM collab_projects WHERE id=$1', [projectId])).rows[0].execution_defaults;
  await freezeLegacyExecution();

  let mappingFailure;
  try {
    await db.createProjectHostMapping({ actor, projectId, hostId: fixtureHostId, repositoryKey: 'acme/blocked', profileIds: ['retirement'], defaultProfileId: 'retirement' });
  } catch (error) {
    mappingFailure = error;
  }
  expect(mappingFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
  expect(await countRows('SELECT count(*)::int AS n FROM collab_project_host_mappings WHERE project_id=$1', [projectId])).toBe(1);

  const projectVersionBefore = (await getPool().query<{ version: number }>('SELECT version FROM collab_projects WHERE id=$1', [projectId])).rows[0].version;
  let defaultsFailure;
  try {
    await db.updateProjectExecutionDefaults({ actor, projectId, expectedVersion: projectVersionBefore, executionDefaults: { mappingId, profileId: 'retirement', model: null, instructions: 'Blocked defaults.', summary: { enabled: false, profileId: null, model: null } } });
  } catch (error) {
    defaultsFailure = error;
  }
  expect(defaultsFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
  expect((await getPool().query<{ version: number }>('SELECT version FROM collab_projects WHERE id=$1', [projectId])).rows[0].version).toBe(projectVersionBefore);
  expect((await getPool().query('SELECT execution_defaults FROM collab_projects WHERE id=$1', [projectId])).rows[0].execution_defaults).toEqual(defaultsBefore);

  const settings = await db.getProjectChatSettings({ actor, projectId });
  let switchFailure;
  try {
    await db.updateProjectChatSettings({ actor, projectId, expectedVersion: settings.version, executionMode: 'connector', defaultAgentId: null, defaults: { profileId: null, model: null, instructions: '' } });
  } catch (error) {
    switchFailure = error;
  }
  expect(switchFailure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
  const afterSwitch = await db.getProjectChatSettings({ actor, projectId });
  expect(afterSwitch.executionMode).toBe('chat');
  expect(afterSwitch.version).toBe(settings.version);

  const savedChat = await db.updateProjectChatSettings({ actor, projectId, expectedVersion: settings.version, executionMode: 'chat', defaultAgentId: null, defaults: { profileId: null, model: null, instructions: '' } });
  expect(savedChat.executionMode).toBe('chat');
  expect(savedChat.version).toBe(settings.version + 1);
});

it('retrieves existing artifact bytes and settles cancellation through the owning connector after freeze', async () => {
  const { task, started } = await sourceFixture();
  const bytes = Buffer.from('Existing evidence survives the admission freeze.\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const artifact = await recordCollabArtifactReport({
    taskId: task.id, source: { kind: 'legacy', runId: started.run.id, sessionId: started.sessionId },
    direction: 'output', kind: 'file', name: 'Existing evidence', reference: 'evidence.txt',
    mediaType: 'text/plain', sizeBytes: bytes.length, sha256,
  });
  await freezeLegacyExecution();
  expect(await getCollabArtifactContent({ actor, taskId: task.id, artifactId: artifact.id })).toMatchObject({ state: 'queued' });
  const pending = await db.pollConnectorCommands({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, waitMs: 0, limit: 10 });
  const capture = pending.commands.find(command => command.runId === started.run.id && command.kind === 'artifact_read');
  if (!capture) throw new Error('The owning connector did not receive the existing artifact retrieval');
  await db.ackConnectorCommand({
    token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch,
    commandId: capture.id, state: 'applied',
    result: { status: 'available', mediaType: 'text/plain', sizeBytes: bytes.length, sha256, contentBase64: bytes.toString('base64'), truncated: false },
  });
  expect(await getCollabArtifactContent({ actor, taskId: task.id, artifactId: artifact.id })).toEqual({
    name: 'Existing evidence', mediaType: 'text/plain', contentBase64: bytes.toString('base64'), content: bytes.toString('utf8'), truncated: false,
  });
  const cancellation = await db.submitSessionCommand({ actor, sessionId: started.sessionId, idempotencyKey: randomUUID(), command: { kind: 'cancel' } });
  const cancellations = await db.pollConnectorCommands({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, waitMs: 0, limit: 10 });
  expect(cancellations.commands.find(command => command.id === cancellation.commandId)).toMatchObject({ runId: started.run.id, sessionId: started.sessionId, kind: 'cancel' });
  await db.ackConnectorCommand({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, commandId: cancellation.commandId, state: 'applied' });
  expect((await getPool().query('SELECT state FROM collab_connector_commands WHERE id=$1', [cancellation.commandId])).rows[0].state).toBe('applied');
  await db.submitConnectorObservations({
    token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch,
    events: [{ eventId: randomUUID(), runId: started.run.id, sessionId: started.sessionId, kind: 'state', observedAt: new Date().toISOString(), payload: { state: 'cancelled' } }],
  });
  expect((await getPool().query('SELECT state FROM collab_runs WHERE id=$1', [started.run.id])).rows[0].state).toBe('cancelled');
});

it('rolls back a legacy idea follow-up instead of recording an undelivered conversion after freeze', async () => {
  const { task, started } = await sourceFixture();
  const idea = await createCollabIdea({ actor, taskId: task.id, runId: started.run.id, sessionId: started.sessionId, title: 'Existing follow-up', body: 'Preserve the idea until execution is available.', visibility: 'internal' });
  const before = (await getPool().query('SELECT * FROM collab_ideas WHERE id=$1', [idea.id])).rows[0];
  const commandsBefore = await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id]);
  const idempotencyKey = randomUUID();
  await freezeLegacyExecution();
  let failure;
  try {
    await convertCollabIdea({ actor, taskId: task.id, ideaId: idea.id, kind: 'follow_up', expectedVersion: idea.version, sessionId: started.sessionId, idempotencyKey });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ status: 409, code: 'legacy_execution_frozen' });
  expect((await getPool().query('SELECT * FROM collab_ideas WHERE id=$1', [idea.id])).rows[0]).toEqual(before);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id])).toBe(commandsBefore);
  expect(await countRows('SELECT count(*)::int AS n FROM collab_idempotency_records WHERE principal_id=$1 AND scope_key=$2 AND idempotency_key=$3', [actor.principalId, `idea:${idea.id}`, idempotencyKey])).toBe(0);
});

it('reconciles an ambiguous admitted launch without creating another execution intent after freeze', async () => {
  const { started } = await sourceFixture();
  const commands = await db.pollConnectorCommands({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, waitMs: 0, limit: 10 });
  const launch = commands.commands.find(command => command.runId === started.run.id && command.kind === 'launch');
  if (!launch) throw new Error('The owning connector did not receive the admitted launch');
  await db.ackConnectorCommand({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, commandId: launch.id, state: 'ambiguous' });
  expect((await getPool().query('SELECT state FROM collab_runs WHERE id=$1', [started.run.id])).rows[0].state).toBe('reconciling');
  const commandsBefore = await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id]);
  await freezeLegacyExecution();
  await db.reconcileConnectorCommand({ actor, commandId: launch.id, action: 'redeliver' });
  const replay = await db.pollConnectorCommands({ token: fixtureHostToken, connectorSessionId: fixtureConnector.connectorSessionId, leaseEpoch: fixtureConnector.leaseEpoch, waitMs: 0, limit: 10 });
  expect(replay.commands.find(command => command.id === launch.id)).toMatchObject({ id: launch.id, runId: started.run.id, sessionId: started.sessionId, kind: 'launch' });
  expect((await getPool().query('SELECT state FROM collab_runs WHERE id=$1', [started.run.id])).rows[0].state).toBe('queued');
  expect(await countRows('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [started.run.id])).toBe(commandsBefore);
});
