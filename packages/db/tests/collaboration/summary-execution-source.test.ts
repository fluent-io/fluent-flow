import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import * as db from '../../src/collaboration/index.js';
import { captureLegacyRunArchive, freezeExecutionSummarySource } from '../../src/collaboration/execution-archives.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

const observationPayload = z.object({ text: z.string() }).passthrough();

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'summary-source-org';
let actor: { principalId: string; sessionVersion: number };
let outsider: { principalId: string; sessionVersion: number };
let reader: { principalId: string; sessionVersion: number };
let workspaceId: string;
let projectId: string;
let hostId: string;
let mappingId: string;

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'summary-source-fixture-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 89001, login: 'summary-source-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Summary source owner', email: 'summary-source-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  workspaceId = (await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Summary source workspace', idempotencyKey: randomUUID() })).id;
  projectId = (await db.createCollabProject({ actor, workspaceId, name: 'Summary source project' })).id;
  const otherUserId = await seedUser(databaseUrl, { githubId: 89002, login: 'summary-source-outsider' });
  await seedOrgMembership(databaseUrl, otherUserId, 'other-summary-source-org', 'admin');
  const otherPrincipal = await db.ensureGithubPrincipal({ userId: otherUserId, displayName: 'Summary source outsider', email: 'summary-source-outsider@example.test' });
  outsider = { principalId: otherPrincipal.id, sessionVersion: otherPrincipal.sessionVersion };
  await db.bootstrapCollaborationWorkspace({ actor: outsider, orgId: 'other-summary-source-org', name: 'Other summary workspace', idempotencyKey: randomUUID() });
  const readerUserId = await seedUser(databaseUrl, { githubId: 89003, login: 'summary-source-reader' });
  await seedOrgMembership(databaseUrl, readerUserId, orgId, 'member');
  const readerPrincipal = await db.ensureGithubPrincipal({ userId: readerUserId, displayName: 'Summary source reader', email: 'summary-source-reader@example.test' });
  const readerRole = await db.createWorkspaceRole({ actor, workspaceId, name: 'Summary reader', capabilities: ['task.read'] });
  await db.addCollabMember({ actor, workspaceId, principalId: readerPrincipal.id, roleId: readerRole.id });
  reader = { principalId: readerPrincipal.id, sessionVersion: readerPrincipal.sessionVersion };
  const host = await db.createExecutionHost({ actor, name: 'Summary source host' });
  hostId = host.id;
  mappingId = (await db.createProjectHostMapping({ actor, projectId, hostId, repositoryKey: 'acme/summary-source', profileIds: ['summary-source-profile'], defaultProfileId: 'summary-source-profile' })).id;
  await db.registerConnector({ token: host.token, instanceId: 'summary-source-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'acme/summary-source' }], profiles: [{ id: 'summary-source-profile', name: 'Summary source profile', provider: 'omp', model: 'fixture' }] } });
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

function observationAt(index: number) {
  return new Date(Date.UTC(2026, 10, 13, 12, 0, 0, index * 1000)).toISOString().replace(/Z$/, '000Z');
}

function providerSeq(index: number) {
  return String(9007199254740993n + BigInt(index));
}

async function createRunFixture() {
  const task = await db.createCollabTask({ actor, projectId, title: 'Summary source run' });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId, profileId: 'summary-source-profile', instructions: 'Preserve the summary source.' });
  if (!('sessionId' in started)) throw new Error('Summary source fixture requires internal execution access');
  return { taskId: task.id, runId: started.run.id, sessionId: started.sessionId };
}

async function insertObservation(source: { runId: string; sessionId: string }, index: number, kind: string, text: string, epoch: string | null, seq: string | null) {
  const id = randomUUID();
  const at = observationAt(index);
  await getPool().query(`INSERT INTO collab_connector_observations
    (id,event_id,host_id,run_id,session_id,kind,payload,provider_epoch,provider_seq,observed_at,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
  [id, `summary-source-${id}`, hostId, source.runId, source.sessionId, kind, JSON.stringify({ type: 'agent_message', text }), epoch, seq, at]);
  return id;
}

async function retireLiveRows(runId: string) {
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [runId]);
}

async function sealArchive(archiveId: string) {
  await getPool().query("UPDATE collab_execution_archives SET sealed_at='2026-11-13T13:00:00.000000Z' WHERE id=$1", [archiveId]);
}

it('returns the latest hundred live observations chronologically with the newest provider cursor', async () => {
  const source = await createRunFixture();
  for (let index = 0; index < 101; index += 1) {
    await insertObservation(source, index, 'timeline', `Message ${index}`, 'source-epoch', providerSeq(index));
  }
  await insertObservation(source, 101, 'attention', 'Attention note', 'source-epoch', null);
  await insertObservation(source, 102, 'state', 'State noise', 'source-epoch', providerSeq(102));
  const before = await getPool().query('SELECT count(*)::int AS total FROM collab_connector_observations');
  const frozen = await freezeExecutionSummarySource({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId });
  const after = await getPool().query('SELECT count(*)::int AS total FROM collab_connector_observations');
  expect(after.rows[0].total).toBe(before.rows[0].total);
  expect(frozen.identity).toEqual({ kind: 'legacy', runId: source.runId, sessionId: source.sessionId });
  expect(frozen.history).toHaveLength(100);
  expect(frozen.history.map(entry => entry.kind)).toEqual([...Array.from({ length: 99 }, () => 'timeline'), 'attention']);
  expect(observationPayload.parse(frozen.history[0].payload).text).toBe('Message 2');
  expect(observationPayload.parse(frozen.history.at(-1)!.payload).text).toBe('Attention note');
  for (const entry of frozen.history) {
    expect(Object.keys(entry).sort()).toEqual(['kind', 'payload', 'providerCursor']);
  }
  expect(frozen.history.at(-1)!.providerCursor).toBeNull();
  expect(frozen.cursor).toEqual({ epoch: 'source-epoch', seq: providerSeq(100) });
});

it('falls back to the session queue cursor when no observation reports a provider pair', async () => {
  const source = await createRunFixture();
  await insertObservation(source, 0, 'timeline', 'Unpaired message', null, null);
  await getPool().query('UPDATE collab_sessions SET timeline_epoch=$2, timeline_seq=$3 WHERE id=$1', [source.sessionId, 'session-epoch', '77']);
  const frozen = await freezeExecutionSummarySource({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId });
  expect(frozen.identity).toEqual({ kind: 'legacy', runId: source.runId, sessionId: source.sessionId });
  expect(frozen.cursor).toEqual({ epoch: 'session-epoch', seq: '77' });
  expect(frozen.history).toHaveLength(1);
  expect(frozen.history[0].providerCursor).toBeNull();
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  await retireLiveRows(source.runId);
  const archived = await freezeExecutionSummarySource({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId });
  expect(archived.cursor).toEqual({ epoch: 'session-epoch', seq: '77' });
  expect(archived.history).toEqual(frozen.history);
});

it('reads the sealed archive with original identities after the live rows retire', async () => {
  const source = await createRunFixture();
  await insertObservation(source, 0, 'timeline', 'Résumé µ\nfirst', 'source-epoch', providerSeq(0));
  await insertObservation(source, 1, 'timeline', 'Second message', 'source-epoch', providerSeq(1));
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  await retireLiveRows(source.runId);
  const frozen = await freezeExecutionSummarySource({ actor, taskId: source.taskId.toUpperCase(), runId: source.runId.toUpperCase(), sessionId: source.sessionId.toUpperCase() });
  expect(frozen.identity).toEqual({ kind: 'archive', runId: source.runId, sessionId: source.sessionId, archiveId: archive.id });
  expect(frozen.cursor).toEqual({ epoch: 'source-epoch', seq: providerSeq(1) });
  expect(frozen.history).toHaveLength(2);
  expect(observationPayload.parse(frozen.history[0].payload).text).toBe('Résumé µ\nfirst');
  expect(observationPayload.parse(frozen.history[1].payload).text).toBe('Second message');
  expect(frozen.history[0].providerCursor).toEqual({ epoch: 'source-epoch', seq: providerSeq(0) });
  expect(Object.keys(frozen.history[0]).sort()).toEqual(['kind', 'payload', 'providerCursor']);
  const timeline = await db.getExecutionHistoryTimeline({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId });
  expect(timeline.entries[0].providerCursor?.seq).toBe(providerSeq(0));
});

it('rejects mismatched task, run and session bindings', async () => {
  const first = await createRunFixture();
  const second = await createRunFixture();
  await expect(freezeExecutionSummarySource({ actor, taskId: second.taskId, runId: first.runId, sessionId: first.sessionId })).rejects.toMatchObject({ status: 404 });
  await expect(freezeExecutionSummarySource({ actor, taskId: first.taskId, runId: second.runId, sessionId: first.sessionId })).rejects.toMatchObject({ status: 404 });
  await expect(freezeExecutionSummarySource({ actor, taskId: first.taskId, runId: first.runId, sessionId: second.sessionId })).rejects.toMatchObject({ status: 404 });
  await expect(freezeExecutionSummarySource({ actor: outsider, taskId: first.taskId, runId: first.runId, sessionId: first.sessionId })).rejects.toMatchObject({ status: 404 });
});

it('denies a disabled principal like the public readers', async () => {
  const source = await createRunFixture();
  await insertObservation(source, 0, 'timeline', 'Guarded message', 'source-epoch', providerSeq(0));
  await getPool().query('UPDATE collab_principals SET disabled_at=now() WHERE id=$1', [actor.principalId]);
  try {
    await expect(freezeExecutionSummarySource({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId })).rejects.toMatchObject({ status: 401 });
    await expect(db.getExecutionHistoryTimeline({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId })).rejects.toMatchObject({ status: 401 });
  } finally {
    await getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]);
  }
});

it('denies a same-project reader without internal.read like the public readers', async () => {
  const source = await createRunFixture();
  await insertObservation(source, 0, 'timeline', 'Internal source', 'source-epoch', providerSeq(0));
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  await retireLiveRows(source.runId);
  await expect(freezeExecutionSummarySource({ actor: reader, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId })).rejects.toMatchObject({ status: 403 });
  await expect(db.getExecutionHistoryTimeline({ actor: reader, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId })).rejects.toMatchObject({ status: 403 });
});

it('refuses a corrupted archive source', async () => {
  const source = await createRunFixture();
  await insertObservation(source, 0, 'timeline', 'Will be corrupted', 'source-epoch', providerSeq(0));
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='observation'", [archive.id]);
  await sealArchive(archive.id);
  await retireLiveRows(source.runId);
  await expect(freezeExecutionSummarySource({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId })).rejects.toMatchObject({ status: 503, code: 'archive_integrity_error' });
});
