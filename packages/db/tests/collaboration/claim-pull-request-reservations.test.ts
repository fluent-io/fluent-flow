import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { cancelInvalidNativePrReservations, insertPullRequestPipelineClaim } from '../../src/collaboration/claim-pull-requests.js';
import { ensureClaimReportingBinding } from '../../src/collaboration/claim-reporting.js';
import { recordClaimWorkspaceObservation } from '../../src/collaboration/claim-workspace-state.js';
import { insertPendingClaim } from '../../src/queries/claims.js';
import { createToken } from '../../src/queries/tokens.js';
import { withClientTransaction } from '../../src/collaboration/tx.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'native-pr-reservations-org';
const repo = 'acme/native-pr-reservations';
const agentId = 'reservation-runner';
const HEAD = 'a'.repeat(40);
let actor: { principalId: string; sessionVersion: number };
let projectId: string;
let agentTokenId: number;

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'native-pr-reservations-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 89901, login: 'reservation-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Reservation owner', email: 'reservation-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Native reservations', idempotencyKey: randomUUID() });
  projectId = (await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native reservations' })).id;
  await getPool().query("INSERT INTO repos(id,org_id,repo_full_name,provider) VALUES($1,$2,$3,'github')", [randomUUID(), orgId, repo]);
  await getPool().query("INSERT INTO agents(id,org_id,agent_type,transport) VALUES($1,$2,'codex','long_poll')", [agentId, orgId]);
  agentTokenId = (await createToken({ orgId, agentId, label: 'reservation-fixture' })).id;
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

type Source = {
  taskId: string; claimId: number; rootClaimId: number; bindingId: string; captureKey: string;
  sessionId: number; branch: string; headSha: string; seq: number;
};

async function acquireSource(options: { claimType?: string; headSha?: string; branch?: string; checkRunId?: number } = {}): Promise<Source> {
  const claimType = options.claimType ?? 'build';
  const headSha = options.headSha ?? HEAD;
  const taskId = (await db.createCollabTask({ actor, projectId, title: 'Reservation source work' })).id;
  const branch = options.branch ?? `ff/task-${taskId}`;
  const sessionId = (await getPool().query<{ id: number }>(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,$2,$3,'online',now(),now()+interval '1 hour') RETURNING id`,
    [orgId, agentId, { capacity: 4, slot_id: 0, instance_id: randomUUID() }])).rows[0].id;
  const claimId = (await getPool().query<{ id: number }>(`INSERT INTO agent_claims(org_id,repo,pr_number,attempt,session_id,claim_type,status,payload,claimed_at,expires_at,head_sha,check_run_external_id)
    VALUES($1,$2,NULL,(SELECT COALESCE(MAX(attempt),0)+1 FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number IS NULL AND claim_type=$3),$4,$3,'claimed',$5,now(),now()+interval '1 hour',$6,$7)
    RETURNING id`,
    [orgId, repo, claimType, sessionId, { branch, source: 'collab' }, headSha, options.checkRunId ?? null])).rows[0].id;
  await getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id,created_by_session_version)
    VALUES($1,$2,$3,$3,$4,$5)`, [taskId, projectId, claimId, actor.principalId, actor.sessionVersion]);
  const binding = await withClientTransaction(tx => ensureClaimReportingBinding(tx, { orgId, agentId, runnerSessionId: sessionId, claimId, agentTokenId }));
  return { taskId, claimId, rootClaimId: claimId, bindingId: binding.bindingId, captureKey: binding.captureKey, sessionId, branch, headSha, seq: 0 };
}

async function observe(source: Source, binding?: { bindingId: string; captureKey: string }) {
  const identity = binding ?? source;
  const seq = String(++source.seq);
  const proof = { version: 1, bindingId: identity.bindingId, seq, state: 'known' as const, headCommit: source.headSha, dirty: false, final: false,
    repository: repo, taskBranch: source.branch, taskBranchHead: source.headSha };
  const material = JSON.stringify(['fluent-flow:workspace-observation:v1', proof.bindingId, source.claimId, seq, proof.state, proof.headCommit, proof.dirty, proof.final, proof.repository, proof.taskBranch, proof.taskBranchHead]);
  const signed = { ...proof, hmac: createHmac('sha256', Buffer.from(identity.captureKey, 'base64url')).update(material).digest('base64url') };
  await recordClaimWorkspaceObservation({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: signed.bindingId, proof: signed });
}

function pullRequest(source: Source, number: number) {
  const repository = { id: 9001, node_id: 'R_reservation_fixture', full_name: repo, owner: { login: orgId } };
  return { id: number + 100000, node_id: `PR_reservation_${number}`, number, state: 'open', body: '', title: 'Native build output',
    created_at: new Date().toISOString(), html_url: `https://github.com/${repo}/pull/${number}`,
    user: { login: 'reservation-owner' }, base: { repo: repository, ref: 'main' },
    head: { repo: repository, ref: source.branch, sha: source.headSha } };
}

async function reservePipelineClaim(source: Source, prNumber: number, checkRunId: number) {
  return insertPullRequestPipelineClaim({ orgId, repo, prNumber, attempt: 1, claimType: 'review',
    payload: { branch: source.branch, priorIssues: [] }, headSha: source.headSha, githubCheckId: checkRunId });
}

async function reservationFor(claimId: number) {
  return (await getPool().query(`SELECT producer_binding_id,task_id,root_claim_id,github_check_id::text AS github_check_id,head_sha
    FROM collab_claim_pr_reservations WHERE claim_id=$1`, [claimId])).rows;
}

async function lineageOf(claimId: number) {
  return (await getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id,
    execution.created_by_principal_id,execution.created_by_session_version
    FROM collab_claim_executions execution WHERE execution.claim_id=$1`, [claimId])).rows;
}

async function claimsFor(prNumber: number) {
  return (await getPool().query('SELECT id,status,session_id FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3', [orgId, repo, prNumber])).rows;
}

it('reserves a native pipeline claim onto the discovered check source and attaches exact actor and root when that source reports the pull request', async () => {
  const source = await acquireSource({ checkRunId: 880001 });
  const pr = pullRequest(source, 71);
  expect(await db.observeNativePullRequest({ orgId, repo, pullRequest: pr })).toEqual(expect.any(String));
  const claim = await reservePipelineClaim(source, 71, 771001);
  if (!claim) throw new Error('expected native pipeline claim');
  expect(claim).toMatchObject({ status: 'pending', session_id: null, head_sha: source.headSha });
  expect(await reservationFor(claim.id)).toEqual([{
    producer_binding_id: source.bindingId, task_id: source.taskId, root_claim_id: source.rootClaimId,
    github_check_id: '771001', head_sha: source.headSha,
  }]);
  await observe(source);
  const view = await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId, pullRequest: pr });
  expect(view).toMatchObject({ repo, prNumber: 71 });
  expect(await lineageOf(claim.id)).toEqual([{
    parent_claim_id: source.claimId, root_claim_id: source.rootClaimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion,
  }]);
  expect(await reservationFor(claim.id)).toEqual([]);
  expect(await claimsFor(71)).toEqual([{ id: claim.id, status: 'pending', session_id: null }]);
});

it('attaches a pipeline claim through an explicit parent on an existing native link without a reservation', async () => {
  const source = await acquireSource();
  await observe(source);
  const pr = pullRequest(source, 72);
  await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId, pullRequest: pr });
  const claim = await insertPullRequestPipelineClaim({ orgId, repo, prNumber: 72, attempt: 1, claimType: 'review_fix',
    payload: { branch: source.branch, issues: [] }, headSha: source.headSha, parentClaimId: source.claimId });
  if (!claim) throw new Error('expected native pipeline claim');
  expect(await lineageOf(claim.id)).toEqual([{
    parent_claim_id: source.claimId, root_claim_id: source.rootClaimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion,
  }]);
  expect(await reservationFor(claim.id)).toEqual([]);
});

it('rejects a factory call without an explicit parent or check source without inserting a claim', async () => {
  const source = await acquireSource();
  const pr = pullRequest(source, 73);
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pr });
  await expect(insertPullRequestPipelineClaim({ orgId, repo, prNumber: 73, attempt: 1, claimType: 'review',
    payload: { branch: source.branch }, headSha: source.headSha })).rejects.toMatchObject({ status: 403 });
  expect(await claimsFor(73)).toEqual([]);
  await observe(source);
  await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId, pullRequest: pr });
  await expect(insertPullRequestPipelineClaim({ orgId, repo, prNumber: 73, attempt: 2, claimType: 'review',
    payload: { branch: source.branch }, headSha: source.headSha })).rejects.toMatchObject({ status: 403 });
  expect(await claimsFor(73)).toEqual([]);
});

it('denies parent-based insertion when the parent binding is revoked and denies check discovery on an expired acquisition without new claims or evidence', async () => {
  const revoked = await acquireSource({ checkRunId: 774001 });
  await getPool().query('UPDATE collab_scoped_tokens SET revoked_at=now() WHERE id=$1', [revoked.bindingId]);
  await expect(insertPullRequestPipelineClaim({ orgId, repo, prNumber: 74, attempt: 1, claimType: 'review',
    payload: { branch: revoked.branch }, headSha: revoked.headSha, parentClaimId: revoked.claimId })).rejects.toMatchObject({ status: 403 });
  expect(await claimsFor(74)).toEqual([]);
  const expired = await acquireSource({ checkRunId: 774002 });
  await getPool().query("UPDATE agent_claims SET expires_at=now()-interval '1 minute' WHERE id=$1", [expired.claimId]);
  await expect(reservePipelineClaim(expired, 75, 774002)).rejects.toMatchObject({ status: 403 });
  expect(await claimsFor(75)).toEqual([]);
  expect((await getPool().query(`SELECT 1 FROM collab_claim_executions execution JOIN agent_claims claim ON claim.id=execution.claim_id
    WHERE claim.org_id=$1 AND claim.repo=$2 AND claim.pr_number IN (74,75)`, [orgId, repo])).rows).toEqual([]);
});

it('does not let a wrong-linking producer consume another producer reservation', async () => {
  const source = await acquireSource({ checkRunId: 776001 });
  const other = await acquireSource({ branch: source.branch });
  const pr = pullRequest(source, 76);
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pr });
  const claim = await reservePipelineClaim(source, 76, 776001);
  if (!claim) throw new Error('expected native pipeline claim');
  await observe(other);
  await db.recordClaimPullRequest({ taskId: other.taskId, claimId: other.claimId, reportingBindingId: other.bindingId, pullRequest: pr });
  expect(await reservationFor(claim.id)).toEqual([{
    producer_binding_id: source.bindingId, task_id: source.taskId, root_claim_id: source.rootClaimId,
    github_check_id: '776001', head_sha: source.headSha,
  }]);
  expect(await lineageOf(claim.id)).toEqual([]);
  expect(await claimsFor(76)).toEqual([{ id: claim.id, status: 'pending', session_id: null }]);
});

it('does not let a reacquisition one microsecond later revive an old reservation', async () => {
  const source = await acquireSource({ checkRunId: 777001 });
  const pr = pullRequest(source, 77);
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pr });
  const claim = await reservePipelineClaim(source, 77, 777001);
  if (!claim) throw new Error('expected native pipeline claim');
  await getPool().query("UPDATE agent_claims SET claimed_at=claimed_at+interval '1 microsecond' WHERE id=$1", [source.claimId]);
  const reacquired = await withClientTransaction(tx => ensureClaimReportingBinding(tx, { orgId, agentId, runnerSessionId: source.sessionId, claimId: source.claimId, agentTokenId }));
  expect(reacquired.bindingId).not.toBe(source.bindingId);
  await observe(source, reacquired);
  await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: reacquired.bindingId, pullRequest: pr });
  expect(await reservationFor(claim.id)).toEqual([{
    producer_binding_id: source.bindingId, task_id: source.taskId, root_claim_id: source.rootClaimId,
    github_check_id: '777001', head_sha: source.headSha,
  }]);
  expect(await lineageOf(claim.id)).toEqual([]);
});

it('does not let a new runner session revive an old reservation', async () => {
  const source = await acquireSource({ checkRunId: 778001 });
  const pr = pullRequest(source, 78);
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pr });
  const claim = await reservePipelineClaim(source, 78, 778001);
  if (!claim) throw new Error('expected native pipeline claim');
  const sessionId = (await getPool().query<{ id: number }>(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,$2,$3,'online',now(),now()+interval '1 hour') RETURNING id`,
    [orgId, agentId, { capacity: 4, slot_id: 0, instance_id: randomUUID() }])).rows[0].id;
  await getPool().query("UPDATE agent_claims SET session_id=$2,claimed_at=now() WHERE id=$1", [source.claimId, sessionId]);
  const moved = await withClientTransaction(tx => ensureClaimReportingBinding(tx, { orgId, agentId, runnerSessionId: sessionId, claimId: source.claimId, agentTokenId }));
  await observe(source, moved);
  await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: moved.bindingId, pullRequest: pr });
  expect(await reservationFor(claim.id)).toEqual([{
    producer_binding_id: source.bindingId, task_id: source.taskId, root_claim_id: source.rootClaimId,
    github_check_id: '778001', head_sha: source.headSha,
  }]);
  expect(await lineageOf(claim.id)).toEqual([]);
});

it('does not rewrite reservation source identity when candidate metadata is updated', async () => {
  const source = await acquireSource({ checkRunId: 779001 });
  const pr = pullRequest(source, 79);
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pr });
  const claim = await reservePipelineClaim(source, 79, 779001);
  if (!claim) throw new Error('expected native pipeline claim');
  const before = await reservationFor(claim.id);
  const pushed = { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } };
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pushed });
  expect(await reservationFor(claim.id)).toEqual(before);
});

it('cancels reservations of lost or finished sources without leasing them and without touching ordinary pending claims', async () => {
  const source = await acquireSource({ checkRunId: 780001 });
  const healthy = await acquireSource({ checkRunId: 780002 });
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pullRequest(source, 80) });
  await db.observeNativePullRequest({ orgId, repo, pullRequest: pullRequest(healthy, 81) });
  const abandoned = await reservePipelineClaim(source, 80, 780001);
  const guarded = await reservePipelineClaim(healthy, 81, 780002);
  const ordinary = await insertPendingClaim({ orgId, repo, prNumber: 80, attempt: 1, claimType: 'verify',
    payload: { branch: source.branch }, headSha: source.headSha });
  if (!abandoned || !guarded || !ordinary) throw new Error('expected pipeline and ordinary claims');
  await getPool().query("UPDATE agent_claims SET status='completed',session_id=NULL,completed_at=now() WHERE id=$1", [source.claimId]);
  await cancelInvalidNativePrReservations();
  expect(await claimsFor(80)).toEqual(expect.arrayContaining([
    { id: abandoned.id, status: 'cancelled', session_id: null },
    { id: ordinary.id, status: 'pending', session_id: null },
  ]));
  expect(await reservationFor(abandoned.id)).toEqual([]);
  expect(await claimsFor(81)).toEqual([{ id: guarded.id, status: 'pending', session_id: null }]);
  expect((await reservationFor(guarded.id))[0]).toMatchObject({ producer_binding_id: healthy.bindingId });
  expect(await cancelInvalidNativePrReservations()).toBe(0);
});

it('repeats an exact-scope pull request report idempotently without fake bindings or roots', async () => {
  const source = await acquireSource();
  await observe(source);
  const pr = pullRequest(source, 82);
  const first = await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId, pullRequest: pr });
  const second = await db.recordClaimPullRequest({ taskId: source.taskId, claimId: source.claimId, reportingBindingId: source.bindingId, pullRequest: pr });
  expect(second).toEqual(first);
  expect((await getPool().query('SELECT count(*)::int AS count FROM collab_delivery_links WHERE org_id=$1 AND repo=$2 AND pr_number=$3', [orgId, repo, 82])).rows).toEqual([{ count: 1 }]);
  expect((await getPool().query('SELECT count(*)::int AS count FROM collab_pull_request_roots WHERE root_claim_id=$1', [source.rootClaimId])).rows).toEqual([{ count: 1 }]);
});
