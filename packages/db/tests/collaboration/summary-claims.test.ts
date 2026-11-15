import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { bootstrapCollaborationWorkspace, createCollabProject, createCollabTask, ensureGithubPrincipal } from '../../src/collaboration/index.js';
import { getProjectSummarySettings, updateProjectSummarySettings } from '../../src/collaboration/summary-settings.js';
import { queueClaimSummary, listTaskSummaries } from '../../src/collaboration/summary-claims.js';
import { ensureClaimReportingBinding } from '../../src/collaboration/claim-reporting.js';
import { recordCollabSummaryReport, recordUsageSample } from '../../src/collaboration/evidence.js';
import { recordAgentProgress } from '../../src/collaboration/tokens.js';
import { resolveClaimReportingContext } from '../../src/collaboration/claim-reporting.js';
import { withClientTransaction } from '../../src/collaboration/tx.js';
import { insertPendingClaim } from '../../src/queries/claims.js';
import { appendClaimEvents } from '../../src/queries/claim-interactions.js';
import { createToken } from '../../src/queries/tokens.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'native-summary-claims';
let actor: { principalId: string; sessionVersion: number };
let projectId: string;
let runnerSessionId: number;
let agentTokenId: number;
let sourceIndex = 0;

async function configure(enabled = true, model: string | null = 'large') {
  const current = await getProjectSummarySettings({ actor, projectId });
  return updateProjectSummarySettings({ actor, projectId, expectedVersion: current.version,
    defaults: { enabled, agentId: 'summary-runner', profileId: 'digest', model } });
}

async function sourceTask() {
  const task = await createCollabTask({ actor, projectId, title: `Summary source ${++sourceIndex}`, description: 'Design a feature without treating a summary as verification.' });
  const claim = await insertPendingClaim({ orgId, repo: `acme/summary-source-${sourceIndex}`, prNumber: null, claimType: 'spec', payload: {} });
  if (!claim) throw new Error('Source claim fixture was not created');
  await getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version)
    VALUES($1,$2,$3,$3,$4,$5)`, [task.id, projectId, claim.id, actor.principalId, actor.sessionVersion]);
  await appendClaimEvents({ orgId, claimId: claim.id, events: [{ seq: 1, kind: 'notice', payload: { message: 'Original feature design' } }] });
  await getPool().query(`UPDATE agent_claims SET status='completed',completed_at=NOW() WHERE id=$1`, [claim.id]);
  return { task, claimId: claim.id };
}

async function bind(claimId: number) {
  await getPool().query(`UPDATE agent_claims SET status='claimed',session_id=$2,claimed_at=NOW(),expires_at=NOW()+interval '15 minutes' WHERE id=$1`, [claimId, runnerSessionId]);
  return withClientTransaction(tx => ensureClaimReportingBinding(tx, { orgId, agentId: 'summary-runner', runnerSessionId, claimId, agentTokenId }));
}

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'native-summary-claims-private-fixture-secret';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 9761, login: 'summary-claims-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await ensureGithubPrincipal({ userId, displayName: 'Summary operator', email: 'summary-claims@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await bootstrapCollaborationWorkspace({ actor, orgId, name: 'Native summaries', idempotencyKey: 'native-summary-claims-workspace' });
  projectId = (await createCollabProject({ actor, workspaceId: workspace.id, name: 'Summary project' })).id;
  await getPool().query(`INSERT INTO agents(id,org_id,agent_type,transport,max_chat_slots) VALUES('summary-runner',$1,'codex','long_poll',0)`, [orgId]);
  const session = await getPool().query<{ id: number }>(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,'summary-runner',$2,'online',NOW(),NOW()+interval '2 hours') RETURNING id`,
  [orgId, JSON.stringify({ capacity: 1, supported_claim_types: ['summary'], profiles: [{ id: 'digest', models: ['small', 'large'], default_model: 'small' }] })]);
  runnerSessionId = session.rows[0].id;
  agentTokenId = (await createToken({ orgId, agentId: 'summary-runner', label: 'native-summary-fixture' })).id;
  await configure();
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

it('queues one explicit concurrent intent with frozen source and model without moving the task', async () => {
  await configure();
  const source = await sourceTask();
  const intent = { actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim' as const, claimId: source.claimId } };
  const results = await Promise.all([queueClaimSummary(intent), queueClaimSummary(intent)]);
  expect(results[0].claimId).toBe(results[1].claimId);
  expect(results.map(result => result.created).sort()).toEqual([false, true]);
  const claim = (await getPool().query('SELECT claim_type,repo,pr_number,task_id,target_agent_id,status FROM agent_claims WHERE id=$1', [results[0].claimId])).rows[0];
  expect(claim).toEqual({ claim_type: 'summary', repo: null, pr_number: null, task_id: source.task.id, target_agent_id: 'summary-runner', status: 'pending' });
  const request = (await getPool().query('SELECT profile_id,model,source_identity,source_cursor,source_text,created_by_principal_id,created_by_session_version FROM collab_summary_requests WHERE claim_id=$1', [results[0].claimId])).rows[0];
  expect(request).toMatchObject({ profile_id: 'digest', model: 'large', source_identity: { kind: 'claim', claimId: source.claimId }, source_cursor: { seq: '1' }, created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion });
  expect(request.source_text).toContain('Original feature design');
  await appendClaimEvents({ orgId, claimId: source.claimId, events: [{ seq: 2, kind: 'notice', payload: { message: 'Later design change' } }] });
  await configure(true, 'small');
  const frozen = (await getPool().query('SELECT model,source_cursor,source_text FROM collab_summary_requests WHERE claim_id=$1', [results[0].claimId])).rows[0];
  expect(frozen.model).toBe('large');
  expect(frozen.source_cursor).toEqual({ seq: '1' });
  expect(frozen.source_text).not.toContain('Later design change');
  expect((await getPool().query('SELECT status,version FROM collab_tasks WHERE id=$1', [source.task.id])).rows[0]).toEqual({ status: source.task.status, version: source.task.version });
  expect(await queueClaimSummary(intent)).toMatchObject({ claimId: results[0].claimId, created: false });
});

it('bounds selected history and source text while preserving its cursor', async () => {
  await configure();
  const source = await sourceTask();
  const base = '2147483500';
  await getPool().query(`INSERT INTO agent_claim_events(org_id,claim_id,seq,kind,payload,payload_bytes)
    SELECT $1,$2,$3::bigint+n,'notice',jsonb_build_object('message','step-'||n::text||' '||repeat('x',1000)),1100
    FROM generate_series(0,104) n`, [orgId, source.claimId, base]);
  const queued = await queueClaimSummary({ actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim', claimId: source.claimId } });
  const request = (await getPool().query('SELECT source_cursor,source_text,source_entry_count,source_truncated FROM collab_summary_requests WHERE claim_id=$1', [queued.claimId])).rows[0];
  expect(request.source_cursor).toEqual({ seq: (BigInt(base) + 104n).toString() });
  expect(request.source_entry_count).toBe(100);
  expect(request.source_text).toContain('step-5 ');
  expect(request.source_text).not.toContain('Original feature design');
  expect(request.source_text).not.toContain('step-4 ');
  expect(request.source_text.length).toBeLessThanOrEqual(60000);
  expect(request.source_truncated).toBe(true);
});

it('rejects disabled, mismatched-source and stale-version spending intents without queueing work', async () => {
  const source = await sourceTask();
  const other = await sourceTask();
  const key = randomUUID();
  const intent = { actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: key, source: { kind: 'claim' as const, claimId: source.claimId } };
  await configure(false);
  await expect(queueClaimSummary(intent)).rejects.toMatchObject({ status: 422 });
  await configure();
  await expect(queueClaimSummary({ ...intent, source: { kind: 'claim', claimId: other.claimId } })).rejects.toMatchObject({ status: 404 });
  await getPool().query('UPDATE collab_tasks SET version=version+1 WHERE id=$1', [source.task.id]);
  await expect(queueClaimSummary(intent)).rejects.toMatchObject({ status: 409 });
  expect((await getPool().query('SELECT claim_id FROM collab_summary_requests WHERE task_id=$1', [source.task.id])).rows).toEqual([]);
});

it('rejects reuse of a request identity for a different source', async () => {
  await configure();
  const source = await sourceTask();
  const otherClaim = await insertPendingClaim({ orgId, repo: `acme/summary-second-${sourceIndex}`, prNumber: null, claimType: 'review', payload: {} });
  if (!otherClaim) throw new Error('Second source fixture was not created');
  await getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version)
    VALUES($1,$2,$3,$3,$4,$5)`, [source.task.id, projectId, otherClaim.id, actor.principalId, actor.sessionVersion]);
  const intent = { actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim' as const, claimId: source.claimId } };
  const first = await queueClaimSummary(intent);
  await expect(queueClaimSummary({ ...intent, source: { kind: 'claim', claimId: otherClaim.id } })).rejects.toMatchObject({ status: 409 });
  expect((await getPool().query('SELECT claim_id FROM collab_summary_requests WHERE task_id=$1', [source.task.id])).rows).toEqual([{ claim_id: first.claimId }]);
});

it('publishes one internal summary using stored source and model, never provider attribution arguments', async () => {
  await configure();
  const source = await sourceTask();
  const queued = await queueClaimSummary({ actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim', claimId: source.claimId } });
  const binding = await bind(queued.claimId);
  await configure(true, 'small');
  const report = { taskId: source.task.id, source: { kind: 'claim' as const, claimId: queued.claimId, reportingBindingId: binding.bindingId }, body: 'Design agreed; implementation has not been verified.', model: 'provider-invented-model', sourceEpoch: 'forged-epoch', sourceSeq: '999', visibility: 'client' as const };
  const summary = await recordCollabSummaryReport(report);
  expect(summary).toMatchObject({ claimId: queued.claimId, runId: null, sessionId: null, body: report.body, model: 'large', sourceCursor: '1', visibility: 'internal', provenance: 'agent', authorId: actor.principalId });
  expect(await recordCollabSummaryReport(report)).toEqual(summary);
  await expect(recordCollabSummaryReport({ ...report, body: 'Replace the published summary' })).rejects.toMatchObject({ status: 409 });
  const listed = await listTaskSummaries({ actor, taskId: source.task.id });
  expect(listed.summaries).toEqual([expect.objectContaining({ id: summary.id, claimId: queued.claimId, source: { kind: 'claim', claimId: source.claimId }, model: 'large', sourceCursor: '1' })]);
  expect(JSON.stringify(listed)).not.toContain(binding.bindingId);
  expect(JSON.stringify(listed)).not.toContain(binding.credential);
  expect((await getPool().query('SELECT run_id,session_id,claim_id,model,source_seq,visibility FROM collab_summaries WHERE id=$1', [summary.id])).rows[0]).toEqual({ run_id: null, session_id: null, claim_id: queued.claimId, model: 'large', source_seq: '1', visibility: 'internal' });
  expect((await getPool().query('SELECT id FROM collab_runs WHERE task_id=$1', [source.task.id])).rows).toEqual([]);
});

it('keeps summary authority separate from work reporting but retains its measured usage', async () => {
  await configure();
  const source = await sourceTask();
  const queued = await queueClaimSummary({ actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim', claimId: source.claimId } });
  const binding = await bind(queued.claimId);
  const context = await withClientTransaction(tx => resolveClaimReportingContext(tx, { claimId: queued.claimId, reportingBindingId: binding.bindingId }));
  await expect(recordAgentProgress(context, { text: 'Pretend to finish implementation', percent: 100 })).rejects.toMatchObject({ status: 403 });
  await recordUsageSample({ taskId: source.task.id, source: { kind: 'claim', claimId: queued.claimId, reportingBindingId: binding.bindingId }, providerTurnId: 'summary-turn', tokensIn: null, tokensOut: null, costUsd: 0.02, unavailableReason: 'Provider did not report consumed tokens.' });
  expect((await getPool().query('SELECT claim_id,cost_usd::double precision AS cost_usd,tokens_in,tokens_out FROM collab_usage_samples WHERE claim_id=$1', [queued.claimId])).rows).toEqual([{ claim_id: queued.claimId, cost_usd: 0.02, tokens_in: null, tokens_out: null }]);
  const workBinding = await bind(source.claimId);
  await expect(recordCollabSummaryReport({ taskId: source.task.id, source: { kind: 'claim', claimId: source.claimId, reportingBindingId: workBinding.bindingId }, body: 'Work cannot publish a summary.', model: null, sourceEpoch: null, sourceSeq: null, visibility: 'internal' })).rejects.toMatchObject({ status: 403 });
  expect((await getPool().query('SELECT id FROM collab_summaries WHERE claim_id=$1', [source.claimId])).rows).toEqual([]);
});

it('orders native source sequences numerically across decimal-width boundaries', async () => {
  await configure();
  const source = await sourceTask();
  await appendClaimEvents({ orgId, claimId: source.claimId, events: Array.from({ length: 11 }, (_, index) => ({ seq: index + 2, kind: 'notice', payload: { message: `ordered-event-${index + 2}` } })) });
  const queued = await queueClaimSummary({ actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim', claimId: source.claimId } });
  const request = (await getPool().query('SELECT source_cursor,source_text FROM collab_summary_requests WHERE claim_id=$1', [queued.claimId])).rows[0];
  expect(request.source_cursor).toEqual({ seq: '12' });
  expect(request.source_text).toContain('ordered-event-2');
  expect(request.source_text).toContain('ordered-event-10');
  expect(request.source_text.indexOf('ordered-event-2')).toBeLessThan(request.source_text.indexOf('ordered-event-10'));
});

it('retains one frozen logical result and its actual producer across a retry', async () => {
  await configure();
  const source = await sourceTask();
  const queued = await queueClaimSummary({ actor, taskId: source.task.id, expectedVersion: source.task.version, idempotencyKey: randomUUID(), source: { kind: 'claim', claimId: source.claimId } });
  const originalBinding = await bind(queued.claimId);
  const report = { taskId: source.task.id, source: { kind: 'claim' as const, claimId: queued.claimId, reportingBindingId: originalBinding.bindingId }, body: 'The design was summarized before acknowledgement was lost.', model: null, sourceEpoch: null, sourceSeq: null, visibility: 'internal' as const };
  const original = await recordCollabSummaryReport(report);
  await getPool().query(`UPDATE agent_claims SET status='failed',completed_at=NOW() WHERE id=$1`, [queued.claimId]);
  const previous = (await getPool().query('SELECT payload FROM agent_claims WHERE id=$1', [queued.claimId])).rows[0];
  const retry = await insertPendingClaim({ orgId, repo: null, prNumber: null, taskId: source.task.id, targetAgentId: 'summary-runner', claimType: 'summary', payload: previous.payload });
  if (!retry) throw new Error('Retry fixture was not created');
  await getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version)
    SELECT task_id,project_id,$2,root_claim_id,created_by_principal_id,created_by_session_version FROM collab_claim_executions WHERE claim_id=$1`, [queued.claimId, retry.id]);
  const summaries = await import('../../src/collaboration/summary-claims.js');
  await withClientTransaction(tx => summaries.linkSummaryClaimAttempt({ orgId, parentClaimId: queued.claimId, claimId: retry.id }, tx));
  await configure(true, 'small');
  const work = await summaries.getClaimSummaryWork({ orgId, claimId: retry.id });
  expect(work).toMatchObject({ requestId: queued.requestId, reported: true, model: 'large', source: { kind: 'claim', claimId: source.claimId }, sourceCursor: { seq: '1' } });
  const retryBinding = await bind(retry.id);
  const replayed = await recordCollabSummaryReport({ ...report, source: { kind: 'claim', claimId: retry.id, reportingBindingId: retryBinding.bindingId } });
  expect(replayed.id).toBe(original.id);
  expect(replayed.claimId).toBe(queued.claimId);
  expect((await listTaskSummaries({ actor, taskId: source.task.id })).summaries.map(summary => summary.id)).toEqual([original.id]);
});
