import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';
import { readDeliveryWorkspace } from '../../src/collaboration/delivery-workspace.js';
import { createCollabDelivery, createCollabIdea, convertCollabIdea, getCollabDeliveryReview, getCollabProjectInsights, listCollabSummaries, queueCollabSummary, recordCollabSummaryReport } from '../../src/collaboration/evidence.js';
import { resolveExecutionHistoryReference } from '../../src/collaboration/execution-archives.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'execution-archive-org';
const observationTime = '2026-11-13T00:00:00.123456Z';
let actor: { principalId: string; sessionVersion: number };
let outsider: { principalId: string; sessionVersion: number };
let workspaceId: string;
let otherWorkspaceId: string;
let projectId: string;
let hostId: string;
let mappingId: string;

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'archive-fixture-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 88701, login: 'archive-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Archive owner', email: 'archive-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Archive workspace', idempotencyKey: randomUUID() });
  workspaceId = workspace.id;
  projectId = (await db.createCollabProject({ actor, workspaceId, name: 'Archive project' })).id;
  const otherUserId = await seedUser(databaseUrl, { githubId: 88702, login: 'archive-outsider' });
  await seedOrgMembership(databaseUrl, otherUserId, 'other-archive-org', 'admin');
  const otherPrincipal = await db.ensureGithubPrincipal({ userId: otherUserId, displayName: 'Archive outsider', email: 'archive-outsider@example.test' });
  outsider = { principalId: otherPrincipal.id, sessionVersion: otherPrincipal.sessionVersion };
  otherWorkspaceId = (await db.bootstrapCollaborationWorkspace({ actor: outsider, orgId: 'other-archive-org', name: 'Other workspace', idempotencyKey: randomUUID() })).id;
  const host = await db.createExecutionHost({ actor, name: 'Archive host' });
  hostId = host.id;
  mappingId = (await db.createProjectHostMapping({ actor, projectId, hostId, repositoryKey: 'acme/archive', profileIds: ['archive-profile'], defaultProfileId: 'archive-profile' })).id;
  await db.registerConnector({ token: host.token, instanceId: 'archive-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'acme/archive' }], profiles: [{ id: 'archive-profile', name: 'Archive profile', provider: 'omp', model: 'fixture' }] } });
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

async function sourceFixture(scope = { projectId, mappingId }) {
  const task = await db.createCollabTask({ actor, projectId: scope.projectId, title: 'Historical execution' });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId: scope.mappingId, profileId: 'archive-profile', instructions: 'Preserve the historical work.' });
  if (!('sessionId' in started)) throw new Error('Archive fixture requires internal execution access');
  const runId = started.run.id;
  const sessionId = started.sessionId;
  await getPool().query('UPDATE collab_runs SET workspace_id=$2 WHERE id=$1', [runId, '/operator/private/archive-source']);
  const observationIds = [randomUUID(), randomUUID()].sort();
  for (const [index, id] of observationIds.entries()) {
    await getPool().query(`INSERT INTO collab_connector_observations
      (id,event_id,host_id,run_id,session_id,kind,payload,provider_epoch,provider_seq,observed_at,created_at)
      VALUES ($1,$2,$3,$4,$5,'timeline',$6,'archive-epoch',$7,$8,$8)`,
    [id, `archive-event-${id}`, hostId, runId, sessionId, JSON.stringify({ type: 'agent_message', text: index === 0 ? 'Résumé µ\nfirst' : 'Second message' }), String(9007199254740993n + BigInt(index)), observationTime]);
  }
  return { taskId: task.id, runId, sessionId, observationIds };
}

it('preserves original identities and precision after live transcript removal', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  expect(archive).toMatchObject({ sourceRunId: source.runId, workspaceId, orgId, taskId: source.taskId, projectId, formatVersion: 1, recordCounts: { run: 1, session: 1, command: 1, observation: 2 }, sealedAt: null });
  const exported = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await db.readExecutionArchiveExportPage({ workspaceId, archiveId: archive.id, cursor, limit: 2 });
    exported.push(...page.records);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(exported.map(record => `${record.type}:${record.id}`).sort()).toEqual([
    `run:${source.runId}`, `session:${source.sessionId}`,
    ...source.observationIds.map(id => `observation:${id}`),
    `command:${(await getPool().query('SELECT id FROM collab_connector_commands WHERE run_id=$1', [source.runId])).rows[0].id}`,
  ].sort());
  expect(JSON.parse(exported.find(record => record.type === 'run')!.payloadJson).workspace_id).toBe('/operator/private/archive-source');
  expect(await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id, compareSource: true })).toMatchObject({ integrityValid: true, sourceMatches: true, issues: [] });
  const first = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId, limit: 1 });
  expect(first.entries.map(entry => entry.eventId)).toEqual([`archive-event-${source.observationIds[0]}`]);
  expect(first.entries[0].providerCursor).toEqual({ epoch: 'archive-epoch', seq: '9007199254740993' });
  expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')).t).toBe(observationTime);
  const second = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId, cursor: first.nextCursor!, limit: 1 });
  expect(second.entries.map(entry => entry.eventId)).toEqual([`archive-event-${source.observationIds[1]}`]);
  expect(second.entries[0].providerCursor?.seq).toBe('9007199254740994');
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
  const retained = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId });
  expect(retained.entries.map(entry => entry.payload.text)).toEqual(['Résumé µ\nfirst', 'Second message']);
});

it('keeps raw machine configuration out of browser metadata and enforces current access', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  const metadata = await db.getCollabExecutionArchive({ actor, archiveId: archive.id });
  expect(metadata).toMatchObject({ id: archive.id, sourceRunId: source.runId, taskId: source.taskId });
  expect(JSON.stringify(metadata)).not.toContain('/operator/private');
  await expect(db.captureLegacyRunArchive({ workspaceId: otherWorkspaceId, runId: source.runId })).rejects.toMatchObject({ status: 404 });
  await expect(db.readExecutionArchiveExportPage({ workspaceId: otherWorkspaceId, archiveId: archive.id })).rejects.toMatchObject({ status: 404 });
  await expect(db.getCollabExecutionArchive({ actor: outsider, archiveId: archive.id })).rejects.toMatchObject({ status: 404 });
  await getPool().query('UPDATE collab_principals SET disabled_at=now() WHERE id=$1', [actor.principalId]);
  try {
    await expect(db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId })).rejects.toMatchObject({ status: 401 });
  } finally {
    await getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]);
  }
});

it('detects stored-byte corruption before exposing a timeline', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='observation'", [archive.id]);
  const verification = await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id });
  expect(verification.integrityValid).toBe(false);
  expect(verification.issues).toContain('record_hash_mismatch');
  await expect(db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId })).rejects.toMatchObject({ status: 503, code: 'archive_integrity_error' });
});

it('distinguishes a valid snapshot from a changed live source', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query(`UPDATE collab_connector_observations SET payload='{"type":"agent_message","text":"Changed after capture"}'::jsonb WHERE id=$1`, [source.observationIds[0]]);
  const verification = await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id, compareSource: true });
  expect(verification).toMatchObject({ integrityValid: true, sourceMatches: false });
  expect(verification.issues).toContain('source_changed');
  const snapshot = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId });
  expect(snapshot.entries[0].payload.text).toBe('Résumé µ\nfirst');
});

it('rolls back every archive record when capture fails partway through', async () => {
  const source = await sourceFixture();
  await getPool().query(`CREATE FUNCTION fail_archive_record_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.record_type='observation' THEN RAISE EXCEPTION 'archive capture fixture failure'; END IF; RETURN NEW; END $$`);
  await getPool().query('CREATE TRIGGER fail_archive_record_fixture BEFORE INSERT ON collab_execution_archive_records FOR EACH ROW EXECUTE FUNCTION fail_archive_record_fixture()');
  try {
    await expect(db.captureLegacyRunArchive({ workspaceId, runId: source.runId })).rejects.toMatchObject({ code: 'P0001' });
    expect((await getPool().query('SELECT id FROM collab_execution_archives WHERE source_run_id=$1', [source.runId])).rows).toEqual([]);
    expect((await getPool().query("SELECT record_id FROM collab_execution_archive_records WHERE record_type='run' AND record_id=$1", [source.runId])).rows).toEqual([]);
  } finally {
    await getPool().query('DROP TRIGGER fail_archive_record_fixture ON collab_execution_archive_records');
    await getPool().query('DROP FUNCTION fail_archive_record_fixture()');
  }
});

it('preserves a nullable historical organization without changing current authorization', async () => {
  const source = await sourceFixture();
  await getPool().query('UPDATE collab_workspaces SET org_id=NULL WHERE id=$1', [workspaceId]);
  let archive: db.ExecutionArchiveManifest | undefined;
  try {
    archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
    expect(archive.orgId).toBeNull();
  } finally {
    await getPool().query('UPDATE collab_workspaces SET org_id=$2 WHERE id=$1', [workspaceId, orgId]);
  }
  expect(await db.getCollabExecutionArchive({ actor, archiveId: archive!.id })).toMatchObject({ orgId: null });
});

it('rejects a timeline cursor from a different archived session', async () => {
  const firstSource = await sourceFixture();
  const secondSource = await sourceFixture();
  const first = await db.captureLegacyRunArchive({ workspaceId, runId: firstSource.runId });
  const second = await db.captureLegacyRunArchive({ workspaceId, runId: secondSource.runId });
  const page = await db.getExecutionArchiveTimeline({ actor, archiveId: first.id, sessionId: firstSource.sessionId, limit: 1 });
  await expect(db.getExecutionArchiveTimeline({ actor, archiveId: second.id, sessionId: secondSource.sessionId, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
  await expect(db.getExecutionArchiveTimeline({ actor, archiveId: second.id, sessionId: firstSource.sessionId })).rejects.toMatchObject({ status: 404 });
});

it('prevents changes to sealed snapshots and their records', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  await expect(getPool().query('DELETE FROM collab_execution_archive_records WHERE archive_id=$1', [archive.id])).rejects.toMatchObject({ code: '23514' });
  await expect(getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1", [archive.id])).rejects.toMatchObject({ code: '23514' });
  await expect(getPool().query('UPDATE collab_execution_archives SET sealed_at=NULL WHERE id=$1', [archive.id])).rejects.toMatchObject({ code: '23514' });
  await expect(getPool().query('DELETE FROM collab_execution_archives WHERE id=$1', [archive.id])).rejects.toMatchObject({ code: '23514' });
  expect(await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id })).toMatchObject({ integrityValid: true });
});

it('serializes sealing against an in-flight record change', async () => {
  const source = await sourceFixture();
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  const writer = await getPool().connect();
  const sealer = await getPool().connect();
  try {
    await writer.query('BEGIN');
    await writer.query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1", [archive.id]);
    await sealer.query('BEGIN');
    await sealer.query("SET LOCAL lock_timeout='100ms'");
    await expect(sealer.query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id])).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await writer.query('ROLLBACK');
    await sealer.query('ROLLBACK');
    writer.release();
    sealer.release();
  }
  expect(await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id })).toMatchObject({ integrityValid: true });
});

it('preserves every observation across capture, verification and timeline page boundaries', async () => {
  const source = await sourceFixture();
  await getPool().query(`INSERT INTO collab_connector_observations
    (id,event_id,host_id,run_id,session_id,kind,payload,provider_epoch,provider_seq,observed_at,created_at)
    SELECT gen_random_uuid(),'archive-page-' || $1::text || '-' || n,$2,$1::uuid,$3,'timeline',
      jsonb_build_object('text','Page ' || n),'archive-epoch',(9007199254740994::bigint+n)::text,$4,$4
    FROM generate_series(1,100) n`, [source.runId, hostId, source.sessionId, observationTime]);
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  expect(archive.recordCounts).toEqual({ command: 1, observation: 102, run: 1, session: 1 });
  expect(await db.verifyExecutionArchive({ workspaceId, archiveId: archive.id, compareSource: true })).toMatchObject({ integrityValid: true, sourceMatches: true, issues: [] });
  const first = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId, limit: 100 });
  const second = await db.getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId, limit: 100, cursor: first.nextCursor! });
  expect([...first.entries, ...second.entries].map(entry => entry.eventId).sort()).toEqual([
    ...source.observationIds.map(id => `archive-event-${id}`),
    ...Array.from({ length: 100 }, (_, i) => `archive-page-${source.runId}-${i + 1}`),
  ].sort());
  expect(second.nextCursor).toBeNull();
});

it('keeps historical execution and original sessions readable after the live source is retired', async () => {
  const source = await sourceFixture();
  await getPool().query("UPDATE collab_runs SET state='cancelled' WHERE id=$1", [source.runId]);
  await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  const live = await db.listTaskExecutionHistory({ actor, taskId: source.taskId });
  expect(live.entries).toEqual([expect.objectContaining({ runId: source.runId, state: 'cancelled', source: { kind: 'legacy', runId: source.runId } })]);
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [source.runId]);
  const retired = await db.listTaskExecutionHistory({ actor, taskId: source.taskId });
  expect(retired.entries).toEqual([expect.objectContaining({ runId: source.runId, state: 'cancelled', source: { kind: 'archive', runId: source.runId, archiveId: archive.id } })]);
  expect(retired.nextCursor).toBeNull();
  const sessions = await db.listExecutionHistorySessions({ actor, taskId: source.taskId, runId: source.runId });
  expect(sessions.sessions).toEqual([expect.objectContaining({ id: source.sessionId, runId: source.runId, profileId: 'archive-profile', role: 'work' })]);
  const transcript = await db.getExecutionHistoryTimeline({ actor, taskId: source.taskId, runId: source.runId, sessionId: sessions.sessions[0].id });
  expect(transcript.entries.map(entry => entry.payload.text)).toEqual(['Résumé µ\nfirst', 'Second message']);
  await expect(db.listTaskExecutionHistory({ actor: outsider, taskId: source.taskId })).rejects.toMatchObject({ status: 404 });
});

it('binds a historical timeline to its selected task, run and original session', async () => {
  const first = await sourceFixture();
  const second = await sourceFixture();
  const entry = await db.getExecutionHistoryEntry({ actor, taskId: first.taskId, runId: first.runId });
  expect(entry.source).toEqual({ kind: 'legacy', runId: first.runId });
  const sessions = await db.listExecutionHistorySessions({ actor, taskId: first.taskId, runId: first.runId });
  expect(sessions.sessions.map(session => session.id)).toEqual([first.sessionId]);
  const timeline = await db.getExecutionHistoryTimeline({ actor, taskId: first.taskId, runId: first.runId, sessionId: first.sessionId });
  expect(timeline.entries.map(entry => entry.payload.text)).toEqual(['Résumé µ\nfirst', 'Second message']);
  await expect(db.getExecutionHistoryEntry({ actor, taskId: first.taskId, runId: second.runId })).rejects.toMatchObject({ status: 404 });
  await expect(db.getExecutionHistoryTimeline({ actor, taskId: first.taskId, runId: first.runId, sessionId: second.sessionId })).rejects.toMatchObject({ status: 404 });
});

it('accepts UUID input casing without changing original session or event identities', async () => {
  const source = await sourceFixture();
  const timeline = await db.getExecutionHistoryTimeline({
    actor, taskId: source.taskId.toUpperCase(), runId: source.runId.toUpperCase(), sessionId: source.sessionId.toUpperCase(),
  });
  expect(timeline.entries.map(entry => entry.eventId)).toEqual(source.observationIds.map(id => `archive-event-${id}`));
  const archive = await db.captureLegacyRunArchive({ workspaceId: workspaceId.toUpperCase(), runId: source.runId.toUpperCase() });
  expect(archive.sourceRunId).toBe(source.runId);
  expect(await db.verifyExecutionArchive({ workspaceId: workspaceId.toUpperCase(), archiveId: archive.id.toUpperCase(), compareSource: true }))
    .toMatchObject({ integrityValid: true, sourceMatches: true, issues: [] });
});

it('preserves sealed workspace freshness and run counts while ignoring unsealed snapshots', async () => {
  const isolatedProject = await db.createCollabProject({ actor, workspaceId, name: 'Archive source counting' });
  const isolatedMapping = await db.createProjectHostMapping({ actor, projectId: isolatedProject.id, hostId, repositoryKey: 'acme/archive', profileIds: ['archive-profile'], defaultProfileId: 'archive-profile' });
  const source = await sourceFixture({ projectId: isolatedProject.id, mappingId: isolatedMapping.id });
  await getPool().query("UPDATE collab_runs SET state='idle',head_commit=$2,dirty=true WHERE id=$1", [source.runId, 'a'.repeat(40)]);
  await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query("UPDATE collab_runs SET state='failed',head_commit=$2,dirty=false WHERE id=$1", [source.runId, 'b'.repeat(40)]);
  const latest = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [latest.id]);
  const liveWorkspace = await readDeliveryWorkspace(source.taskId, getPool());
  expect(liveWorkspace).toMatchObject({ runId: source.runId, headCommit: 'b'.repeat(40), dirty: false });
  const task = (await db.getCollabTask(actor, source.taskId)).task;
  await createCollabDelivery({ actor, taskId: task.id, expectedVersion: task.version, note: 'Preserve the human review source.', artifactIds: [], checkEvidenceIds: [] });
  const liveReview = await getCollabDeliveryReview({ actor, taskId: task.id });
  expect(liveReview).toMatchObject({ runId: source.runId, headCommit: 'b'.repeat(40), dirty: false });
  const range = { actor, projectId: isolatedProject.id, from: new Date('2000-01-01'), to: new Date('2100-01-01') };
  expect((await getCollabProjectInsights(range)).runs).toEqual({ totalCount: 1, failedCount: 1 });
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [source.runId]);
  const history = await db.listTaskExecutionHistory({ actor, taskId: source.taskId });
  expect.soft(history.entries.map(entry => ({ source: entry.source, state: entry.state })))
    .toEqual([{ source: { kind: 'archive', runId: source.runId, archiveId: latest.id }, state: 'failed' }]);
  expect.soft(await readDeliveryWorkspace(source.taskId, getPool())).toEqual(liveWorkspace);
  expect.soft((await getCollabProjectInsights(range)).runs).toEqual({ totalCount: 1, failedCount: 1 });
  expect.soft(await getCollabDeliveryReview({ actor, taskId: source.taskId })).toEqual(liveReview);
});

it('does not trust corrupted archived workspace state after live execution retirement', async () => {
  const source = await sourceFixture();
  await getPool().query('UPDATE collab_runs SET head_commit=$2,dirty=false WHERE id=$1', [source.runId, 'c'.repeat(40)]);
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='run'", [archive.id]);
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [source.runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [source.runId]);
  await expect(readDeliveryWorkspace(source.taskId, getPool())).rejects.toMatchObject({ status: 503, code: 'archive_integrity_error' });
});

it('keeps canonical summaries readable by their original run after the legacy source is retired', async () => {
  const isolatedProject = await db.createCollabProject({ actor, workspaceId, name: 'Archived summary references' });
  const isolatedMapping = await db.createProjectHostMapping({ actor, projectId: isolatedProject.id, hostId, repositoryKey: 'acme/archive', profileIds: ['archive-profile'], defaultProfileId: 'archive-profile' });
  const source = await sourceFixture({ projectId: isolatedProject.id, mappingId: isolatedMapping.id });
  await getPool().query('UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1', [isolatedProject.id, {
    mappingId: isolatedMapping.id, profileId: 'archive-profile', instructions: '', model: null,
    summary: { enabled: true, profileId: 'archive-profile', model: 'fixture' },
  }]);
  const queued = await queueCollabSummary({ actor, runId: source.runId, idempotencyKey: randomUUID() });
  const sessionId = (await getPool().query<{ session_id: string }>('SELECT session_id FROM collab_connector_commands WHERE id=$1', [queued.commandId])).rows[0].session_id;
  const summary = await recordCollabSummaryReport({
    taskId: source.taskId, source: { kind: 'legacy', runId: source.runId, sessionId },
    body: 'Résumé historique — vérification observée.\nOriginal evidence remains.', visibility: 'internal',
    model: null, sourceEpoch: null, sourceSeq: null,
  });
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  const constraints = await getPool().query<{ drop_sql: string; restore_sql: string }>(`SELECT
    format('ALTER TABLE collab_summaries DROP CONSTRAINT %I',conname) AS drop_sql,
    format('ALTER TABLE collab_summaries ADD CONSTRAINT %I %s',conname,pg_get_constraintdef(oid)) AS restore_sql
    FROM pg_constraint WHERE conrelid='collab_summaries'::regclass AND contype='f'
      AND confrelid IN ('collab_runs'::regclass,'collab_sessions'::regclass)`);
  const dropped: string[] = [];
  try {
    for (const constraint of constraints.rows) {
      await getPool().query(constraint.drop_sql);
      dropped.push(constraint.restore_sql);
    }
    await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_runs WHERE id=$1', [source.runId]);
    expect((await getPool().query('SELECT id FROM collab_summaries WHERE id=$1', [summary.id])).rows).toEqual([{ id: summary.id }]);
    expect(await listCollabSummaries({ actor, taskId: source.taskId, runId: source.runId })).toEqual([{
      id: summary.id, runId: source.runId, sessionId,
      body: 'Résumé historique — vérification observée.\nOriginal evidence remains.', visibility: 'internal',
      model: 'fixture', sourceCursor: 'archive-epoch:9007199254740994', provenance: 'agent',
      authorId: actor.principalId, createdAt: summary.createdAt,
    }]);
    await expect(listCollabSummaries({ actor: outsider, runId: source.runId })).rejects.toMatchObject({ status: 404 });
    await expect(listCollabSummaries({ actor, taskId: randomUUID(), runId: source.runId })).rejects.toMatchObject({ status: 404 });
  } finally {
    await getPool().query('DELETE FROM collab_summaries WHERE id=$1', [summary.id]);
    for (const restore of dropped) await getPool().query(restore);
  }
});

async function retireReferenceFixture(runId: string) {
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1 AND claim_id IS NULL', [runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [runId]);
}

it('resolves a legacy idea follow-up through its actual destination run before and after retirement without rewriting provenance', async () => {
  const origin = await sourceFixture();
  await getPool().query("UPDATE collab_runs SET state='failed' WHERE id=$1", [origin.runId]);
  const currentTask = await db.getCollabTask(actor, origin.taskId);
  const destination = await db.startCollabRun({ actor, taskId: origin.taskId, expectedVersion: currentTask.task.version, idempotencyKey: randomUUID(),
    mappingId, profileId: 'archive-profile', instructions: 'Continue in a distinct execution.', retryOfRunId: origin.runId });
  if (!('sessionId' in destination)) throw new Error('Reference fixture requires internal execution access');
  const idea = await createCollabIdea({ actor, taskId: origin.taskId, runId: origin.runId, sessionId: origin.sessionId,
    title: 'Continue the original idea', body: 'Keep both source and destination identities.', visibility: 'internal' });
  const key = randomUUID();
  const input = { actor, taskId: origin.taskId, ideaId: idea.id, expectedVersion: idea.version, kind: 'follow_up' as const, sessionId: destination.sessionId, idempotencyKey: key };
  const converted = await convertCollabIdea(input);
  if (!converted.commandId) throw new Error('Reference fixture requires a legacy command');
  const before = (await getPool().query('SELECT to_jsonb(idea) AS data FROM collab_ideas idea WHERE id=$1', [idea.id])).rows[0].data;
  expect(before).toMatchObject({ run_id: origin.runId, session_id: origin.sessionId, conversion_session_id: destination.sessionId, conversion_command_id: converted.commandId });
  expect(await resolveExecutionHistoryReference({ actor, taskId: origin.taskId, commandId: converted.commandId }))
    .toEqual({ runId: destination.run.id, sessionId: destination.sessionId, source: { kind: 'legacy', runId: destination.run.id } });
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: destination.run.id });
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  const constraints = (await getPool().query<{ name: string; definition: string }>(
    `SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.contype='f' AND c.conrelid='collab_ideas'::regclass
        AND c.confrelid IN ('collab_connector_commands'::regclass,'collab_sessions'::regclass)`)).rows;
  try {
    for (const constraint of constraints) await getPool().query(`ALTER TABLE collab_ideas DROP CONSTRAINT "${constraint.name.replaceAll('"', '""')}"`);
    await retireReferenceFixture(destination.run.id);
    const expected = { runId: destination.run.id, sessionId: destination.sessionId, source: { kind: 'archive', runId: destination.run.id, archiveId: archive.id } };
    expect(await resolveExecutionHistoryReference({ actor, taskId: origin.taskId, sessionId: destination.sessionId.toUpperCase() })).toEqual(expected);
    expect(await resolveExecutionHistoryReference({ actor, taskId: origin.taskId, commandId: converted.commandId })).toEqual(expected);
    expect((await convertCollabIdea(input)).commandId).toBe(converted.commandId);
    expect((await getPool().query('SELECT to_jsonb(idea) AS data FROM collab_ideas idea WHERE id=$1', [idea.id])).rows[0].data).toEqual(before);
    const wrongTask = await db.createCollabTask({ actor, projectId, title: 'Unrelated reference scope' });
    await expect(resolveExecutionHistoryReference({ actor, taskId: wrongTask.id, sessionId: destination.sessionId })).rejects.toMatchObject({ status: 404 });
    await expect(resolveExecutionHistoryReference({ actor: outsider, taskId: origin.taskId, commandId: converted.commandId })).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(expected)).not.toContain('/operator/private');
  } finally {
    await getPool().query('DELETE FROM collab_ideas WHERE id=$1', [idea.id]);
    for (const constraint of constraints) await getPool().query(`ALTER TABLE collab_ideas ADD CONSTRAINT "${constraint.name.replaceAll('"', '""')}" ${constraint.definition}`);
  }
});

it('refuses corrupt archived reference records instead of inventing a live source', async () => {
  const source = await sourceFixture();
  expect(await resolveExecutionHistoryReference({ actor, taskId: source.taskId, sessionId: source.sessionId }))
    .toEqual({ runId: source.runId, sessionId: source.sessionId, source: { kind: 'legacy', runId: source.runId } });
  const archive = await db.captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='run'", [archive.id]);
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=now() WHERE id=$1', [archive.id]);
  await retireReferenceFixture(source.runId);
  await expect(resolveExecutionHistoryReference({ actor, taskId: source.taskId, sessionId: source.sessionId }))
    .rejects.toMatchObject({ status: 503, code: 'archive_integrity_error' });
});
