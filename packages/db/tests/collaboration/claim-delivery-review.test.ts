import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { createCollabDelivery, getCollabDeliveryReview, listCollabOpenItems, listCollabTaskDecisions, recordCollabCheckReport, recordCollabTaskDecision } from '../../src/collaboration/evidence.js';
import { ensureClaimReportingBinding } from '../../src/collaboration/claim-reporting.js';
import { recordClaimWorkspaceObservation } from '../../src/collaboration/claim-workspace-state.js';
import { upsertClaimRequest } from '../../src/queries/claim-interactions.js';
import { createToken } from '../../src/queries/tokens.js';
import { withClientTransaction } from '../../src/collaboration/tx.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'native-delivery-review-org';
const repo = 'acme/native-delivery-review';
const agentId = 'delivery-review-runner';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
let actor: { principalId: string; sessionVersion: number };
let reviewer: typeof actor;
let projectId: string;
let runnerSessionId: number;
let agentTokenId: number;

type Fixture = { taskId: string; claimId: number; bindingId: string; captureKey: string; credential: string; seq: number };

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'native-delivery-review-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 89501, login: 'delivery-review-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Delivery owner', email: 'delivery-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Native delivery', idempotencyKey: randomUUID() });
  projectId = (await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native delivery' })).id;
  const reviewerUser = await seedUser(databaseUrl, { githubId: 89502, login: 'delivery-review-reader' });
  await seedOrgMembership(databaseUrl, reviewerUser, orgId, 'member');
  const reviewerPrincipal = await db.ensureGithubPrincipal({ userId: reviewerUser, displayName: 'Delivery reviewer', email: 'delivery-reviewer@example.test' });
  const role = await db.createWorkspaceRole({ actor, workspaceId: workspace.id, name: 'Delivery-only reviewer', capabilities: ['task.read', 'delivery.accept'] });
  await db.addCollabMember({ actor, workspaceId: workspace.id, principalId: reviewerPrincipal.id, roleId: role.id });
  reviewer = { principalId: reviewerPrincipal.id, sessionVersion: reviewerPrincipal.sessionVersion };
  await getPool().query("INSERT INTO repos(id,org_id,repo_full_name,provider) VALUES($1,$2,$3,'github')", [randomUUID(), orgId, repo]);
  await getPool().query("INSERT INTO agents(id,org_id,agent_type,transport) VALUES($1,$2,'codex','long_poll')", [agentId, orgId]);
  agentTokenId = (await createToken({ orgId, agentId, label: 'native-delivery-fixture' })).id;
  runnerSessionId = (await getPool().query<{ id: number }>(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,$2,'{"capacity":4,"slot_id":0,"instance_id":"delivery"}','online',now(),now()+interval '1 hour') RETURNING id`, [orgId, agentId])).rows[0].id;
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

async function fixture(taskId?: string): Promise<Fixture> {
  const id = taskId ?? (await db.createCollabTask({ actor, projectId, title: 'Review native work' })).id;
  const claimId = (await getPool().query<{ id: number }>(`INSERT INTO agent_claims(org_id,repo,pr_number,attempt,session_id,claim_type,status,payload,claimed_at,expires_at)
    VALUES($1,$2,NULL,(SELECT COALESCE(MAX(attempt),0)+1 FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number IS NULL AND claim_type='spec'),$3,'spec','claimed','{}',now(),now()+interval '1 hour') RETURNING id`, [orgId, repo, runnerSessionId])).rows[0].id;
  await getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version)
    VALUES($1,$2,$3,$3,$4,$5)`, [id, projectId, claimId, actor.principalId, actor.sessionVersion]);
  const binding = await withClientTransaction(tx => ensureClaimReportingBinding(tx, { orgId, agentId, runnerSessionId, claimId, agentTokenId }));
  return { taskId: id, claimId, ...binding, seq: 0 };
}

async function observe(source: Fixture, headCommit: string | null, dirty: boolean | null, final = false) {
  const seq = String(++source.seq);
  const state = headCommit === null ? 'unavailable' : 'known';
  const material = JSON.stringify(['fluent-flow:workspace-observation:v1', source.bindingId, source.claimId, seq, state, headCommit, dirty, final, null, null, null]);
  await recordClaimWorkspaceObservation({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId,
    proof: { version: 1, bindingId: source.bindingId, seq, state, headCommit, dirty, final, repository: null, taskBranch: null, taskBranchHead: null,
      hmac: createHmac('sha256', Buffer.from(source.captureKey, 'base64url')).update(material).digest('base64url') } });
}

async function deliver(taskId: string) {
  await getPool().query("UPDATE collab_tasks SET status='in_progress' WHERE id=$1", [taskId]);
  const { task } = await db.getCollabTask(actor, taskId);
  return createCollabDelivery({ actor, taskId, expectedVersion: task.version, note: 'Review the actual native source.' });
}

async function check(source: Fixture) {
  return recordCollabCheckReport({ taskId: source.taskId, source: { kind: 'claim', claimId: source.claimId, reportingBindingId: source.bindingId },
    name: `Behavior ${source.claimId}`, command: 'npm test', status: 'passed', exitCode: 0, commit: HEAD, dirty: false });
}

it('reviews owner-bound native evidence without requiring a legacy run', async () => {
  const source = await fixture();
  await observe(source, HEAD, false);
  await check(source);
  await deliver(source.taskId);
  expect(await listCollabOpenItems({ actor, taskId: source.taskId })).toEqual([]);
  const review = await getCollabDeliveryReview({ actor: reviewer, taskId: source.taskId });
  expect(review).toMatchObject({ runId: null, source: { kind: 'claim', claimId: source.claimId }, headCommit: HEAD, dirty: false, openItems: [] });
  expect(JSON.stringify(review)).not.toContain(source.bindingId);
});

it('invalidates evidence against newer task work without borrowing another task head', async () => {
  const source = await fixture();
  await observe(source, HEAD, false, true);
  const evidence = await check(source);
  await getPool().query("UPDATE agent_claims SET status='completed',session_id=NULL,completed_at=now() WHERE id=$1", [source.claimId]);
  await deliver(source.taskId);
  const next = await fixture(source.taskId);
  await observe(next, NEXT_HEAD, false);
  const unrelated = await fixture();
  await observe(unrelated, HEAD, false);
  const items = await listCollabOpenItems({ actor, taskId: source.taskId });
  expect(items).toEqual([expect.objectContaining({ id: evidence.id, label: expect.stringMatching(/stale/i) })]);
  expect(await getCollabDeliveryReview({ actor, taskId: source.taskId })).toMatchObject({ source: { kind: 'claim', claimId: next.claimId }, headCommit: NEXT_HEAD });
});

it('does not borrow a prior acquisition head after the same claim is reacquired', async () => {
  const source = await fixture();
  await observe(source, HEAD, false);
  const evidence = await check(source);
  await deliver(source.taskId);
  const before = await getCollabDeliveryReview({ actor, taskId: source.taskId });
  await getPool().query("UPDATE agent_claims SET claimed_at=claimed_at+interval '1 microsecond' WHERE id=$1", [source.claimId]);
  const current = await getCollabDeliveryReview({ actor, taskId: source.taskId });
  expect(current).toMatchObject({ source: { kind: 'claim', claimId: source.claimId }, headCommit: null, dirty: null });
  expect(current.evidenceRevision).not.toBe(before.evidenceRevision);
  expect(current.openItems).toEqual([expect.objectContaining({ id: evidence.id, label: expect.stringMatching(/stale/i) })]);
});

it('requires explicit acknowledgment of real ACP requests without exposing their private payloads', async () => {
  const source = await fixture();
  await observe(source, HEAD, false);
  const delivery = await deliver(source.taskId);
  const before = await getCollabDeliveryReview({ actor: reviewer, taskId: source.taskId });
  const privateText = 'Private deployment credential approval';
  await upsertClaimRequest({ orgId, claimId: source.claimId, requestKey: 'private-permission', kind: 'permission', payload: { toolCall: { title: privateText }, secret: 'PRIVATE-REQUEST-CANARY' } });
  const review = await getCollabDeliveryReview({ actor: reviewer, taskId: source.taskId });
  expect(review.openItems).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: 'Native approval awaiting a response' }]);
  expect(JSON.stringify(review)).not.toMatch(/Private deployment|PRIVATE-REQUEST-CANARY|private-permission/);
  const stored = await getPool().query<{ id: string }>('SELECT id FROM agent_claim_requests WHERE org_id=$1 AND claim_id=$2 AND request_key=$3', [orgId, source.claimId, 'private-permission']);
  expect(review.openItems[0].id).toBe(stored.rows[0].id);
  expect(await listCollabOpenItems({ actor, taskId: source.taskId })).toEqual([{ id: stored.rows[0].id, label: `Native approval: ${privateText}` }]);
  const decide = (reviewSnapshot: typeof review, acknowledgedOpenItemIds: string[]) => recordCollabTaskDecision({ actor: reviewer, taskId: source.taskId,
    expectedVersion: delivery.taskVersion, decision: 'accept', reviewSnapshot, acknowledgedOpenItemIds });
  await expect(decide(review, [])).rejects.toMatchObject({ status: 422, code: 'acknowledgment_required' });
  await expect(decide(before, [stored.rows[0].id])).rejects.toMatchObject({ status: 409, code: 'review_changed' });
  await getPool().query("UPDATE agent_claim_requests SET status='answer_queued' WHERE id=$1", [stored.rows[0].id]);
  await expect(decide(review, [stored.rows[0].id])).rejects.toMatchObject({ status: 409, code: 'review_changed' });
  const queued = await getCollabDeliveryReview({ actor: reviewer, taskId: source.taskId });
  expect(queued.openItems[0].id).toBe(stored.rows[0].id);
  await expect(decide(queued, [stored.rows[0].id])).resolves.toMatchObject({ decision: 'accept', acknowledged: true });
  const accepted = (await getPool().query('SELECT review_snapshot FROM collab_task_decisions WHERE task_id=$1', [source.taskId])).rows[0].review_snapshot;
  await observe(source, NEXT_HEAD, true);
  expect((await listCollabTaskDecisions({ actor: reviewer, taskId: source.taskId })).decisions[0].reviewSnapshot).toEqual(accepted);
});

it('includes elicitation and uncertain responses, but not resolved or cancelled requests', async () => {
  const source = await fixture();
  await deliver(source.taskId);
  for (const [key, kind, status] of [['question', 'elicitation', 'open'], ['uncertain', 'permission', 'uncertain'], ['resolved', 'permission', 'resolved'], ['cancelled', 'permission', 'cancelled']] as const) {
    await upsertClaimRequest({ orgId, claimId: source.claimId, requestKey: key, kind, payload: { message: 'Private question text' } });
    await getPool().query('UPDATE agent_claim_requests SET status=$4 WHERE org_id=$1 AND claim_id=$2 AND request_key=$3', [orgId, source.claimId, key, status]);
  }
  const review = await getCollabDeliveryReview({ actor: reviewer, taskId: source.taskId });
  expect(review.openItems.map(item => item.label).sort()).toEqual(['Native approval awaiting a response', 'Native question awaiting a response']);
});
