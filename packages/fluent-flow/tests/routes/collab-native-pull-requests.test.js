import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const github = vi.hoisted(() => ({ prs: new Map(), config: { reviewer: { enabled: true, trigger_check: 'native-ci', max_retries: 3 }, verification: { enabled: false } } }));
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/config/loader.js', async () => {
  const actual = await vi.importActual('../../src/config/loader.js');
  return { ...actual, resolveConfig: async () => github.config };
});
vi.mock('../../src/providers/github/rest.js', async () => {
  const actual = await vi.importActual('../../src/providers/github/rest.js');
  return { ...actual,
    getPR: async (_owner, _repo, number) => {
      const pr = github.prs.get(number);
      if (!pr) throw new Error('Fixture PR does not exist');
      return structuredClone(pr);
    },
    findPullRequestsByHead: async (_owner, _repo, branch) => [...github.prs.values()].filter(pr => pr.head.ref === branch && pr.state === 'open').map(pr => structuredClone(pr)),
    getPRsForCommit: async (_owner, _repo, sha) => [...github.prs.values()].filter(pr => pr.head.sha === sha).map(pr => structuredClone(pr)),
    getReviews: async () => [],
    dismissReview: async () => {},
  };
});
vi.mock('../../src/providers/github/graphql.js', async () => {
  const actual = await vi.importActual('../../src/providers/github/graphql.js');
  return { ...actual, getPRNodeId: async () => 'PR_native_fixture', enablePullRequestAutoMerge: async () => ({}) };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedUser, seedOrgMembership } = await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');
const { createClaim, createFollowOnClaim, expireClaims } = await import('../../src/agents/claim-manager.js');
const { claimPendingWork } = await import('../../src/routes/agent-server.js');
const { routeWebhookEvent } = await import('../../src/routes/webhook.js');
const SECRET = 'native-pr-reporting-secret-0123456789abcdef';
const WEBHOOK_SECRET = 'native-pr-webhook-secret-0123456789abcdef';
const orgId = 'native-pr-org';
const repo = `${orgId}/fixture`;
const agentId = 'native-pr-runner';
let server;
let base;
let actor;
let restarter;
let projectId;
let nextPr = 8100;
const previousSecrets = { auth: process.env.FF_COLLAB_AUTH_SECRET, webhook: process.env.FF_GITHUB_APP_WEBHOOK_SECRET };

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = SECRET;
  process.env.FF_GITHUB_APP_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await resetCollabSchema(process.env.DATABASE_URL);
  await db.runMigrations();
  const userId = await seedUser(process.env.DATABASE_URL, { githubId: 89701, login: 'native-pr-owner' });
  await seedOrgMembership(process.env.DATABASE_URL, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Native PR owner', email: 'native-pr-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Native PR workspace', idempotencyKey: randomUUID() });
  projectId = (await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native PR project' })).id;
  const restartUserId = await seedUser(process.env.DATABASE_URL, { githubId: 89702, login: 'native-pr-restarter' });
  await seedOrgMembership(process.env.DATABASE_URL, restartUserId, orgId, 'member');
  const restartPrincipal = await db.ensureGithubPrincipal({ userId: restartUserId, displayName: 'Native PR restarter', email: 'native-pr-restarter@example.test' });
  const restartRole = await db.createWorkspaceRole({ actor, workspaceId: workspace.id, name: 'Native work operator', capabilities: ['task.read','task.write','internal.read','run.start'] });
  await db.addCollabMember({ actor, workspaceId: workspace.id, principalId: restartPrincipal.id, roleId: restartRole.id });
  restarter = { principalId: restartPrincipal.id, sessionVersion: restartPrincipal.sessionVersion };
  await db.getPool().query("INSERT INTO repos(id,org_id,repo_full_name,provider) VALUES($1,$2,$1,'github')", [repo, orgId]);
  await db.createAgent({ id: agentId, orgId, agentType: 'codex', transport: 'long_poll', transportMeta: {}, repos: [repo] });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.closePool();
  for (const [name, value] of [['FF_COLLAB_AUTH_SECRET', previousSecrets.auth], ['FF_GITHUB_APP_WEBHOOK_SECRET', previousSecrets.webhook]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(async () => {
  github.prs.clear();
  github.config.verification = { enabled: false };
  await db.getPool().query("UPDATE agent_claims SET status='cancelled',session_id=NULL,completed_at=now() WHERE org_id=$1 AND status IN ('pending','claimed')", [orgId]);
});

async function agent(token, path, body) {
  const response = await fetch(`${base}/api/agent-server${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function tool(source, name, args = {}, meta) {
  const response = await fetch(`${base}/mcp/collab`, { method: 'POST',
    headers: { authorization: `Bearer ${source.reporting.credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }) });
  const body = await response.json();
  if (body.error || !body.result || body.result.isError) return { status: response.status, isError: true, body };
  return { status: response.status, isError: false, value: JSON.parse(body.result.content[0].text) };
}

async function collab(method, path, body) {
  const response = await fetch(`${base}/api/collab/v1${path}`, { method,
    headers: { 'x-fluent-flow-actor': db.signCollaborationActor(actor, SECRET), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

async function sourceFixture({ taskId, pullRequest, initiator = actor } = {}) {
  const task = taskId ? (await db.getCollabTask(initiator, taskId)).task : await db.createCollabTask({ actor: initiator, projectId, title: 'Native authenticated PR' });
  const branch = `ff/task-${task.id}`;
  const started = await db.startCollabClaimExecution({ actor: initiator, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), repo, claimType: 'spec' });
  const token = await db.createToken({ orgId, agentId, label: 'native-pr-fixture' });
  const registered = await agent(token.plaintext, '/register', { meta: { instance_id: randomUUID(), slot_id: 0, capacity: 4, supported_claim_types: ['spec','build'] } });
  expect(registered.status).toBe(200);
  const sessionId = registered.body.session_id;
  const spec = (await agent(token.plaintext, '/poll', { session_id: sessionId })).body.work;
  expect(spec.claim_id).toBe(started.claim.id);
  const completed = await agent(token.plaintext, '/claim', { session_id: sessionId, claim_id: spec.claim_id, repo, pr_number: null, attempt: spec.attempt, status: 'completed' });
  expect(completed.status).toBe(200);
  const build = (await agent(token.plaintext, '/poll', { session_id: sessionId })).body.work;
  expect(build.claim_type).toBe('build');
  const number = pullRequest?.number ?? nextPr++;
  const repository = { id: 9001, node_id: 'R_native_fixture', full_name: repo, owner: { login: orgId } };
  const pr = pullRequest ?? { id: number + 100000, node_id: `PR_native_${number}`, number, state: 'open', body: '', title: 'Native build output',
    created_at: new Date().toISOString(), html_url: `https://github.com/${repo}/pull/${number}`,
    user: { login: 'native-pr-owner' }, base: { repo: repository, ref: 'main' }, head: { repo: repository, ref: branch, sha: number.toString(16).padStart(40, 'a') } };
  github.prs.set(number, pr);
  return { taskId: task.id, rootClaimId: spec.claim_id, claimId: build.claim_id, reporting: build.reporting,
    token: token.plaintext, tokenId: token.id, sessionId, branch, pr, seq: 0, attempt: build.attempt };
}

async function workspace(source, overrides = {}) {
  const seq = String(++source.seq);
  const proof = { version: 1, bindingId: source.reporting.bindingId, seq, state: 'known', headCommit: source.pr.head.sha, dirty: false, final: false,
    repository: repo, taskBranch: source.branch, taskBranchHead: source.pr.head.sha, ...overrides };
  const material = JSON.stringify(['fluent-flow:workspace-observation:v1', proof.bindingId, source.claimId, seq, proof.state,
    proof.headCommit, proof.dirty, proof.final, proof.repository, proof.taskBranch, proof.taskBranchHead]);
  proof.hmac = createHmac('sha256', Buffer.from(source.reporting.captureKey, 'base64url')).update(material).digest('base64url');
  const result = await tool(source, 'collaboration_report_workspace', {}, { 'fluent-flow/workspace-observation': proof });
  expect(result.isError).toBe(false);
}

async function signedWebhook(event, payload, valid = true) {
  const body = JSON.stringify({ repository: { id: 9001, full_name: repo }, ...payload });
  const response = await fetch(`${base}/webhooks/github-app`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-github-event': event,
    'x-hub-signature-256': `sha256=${createHmac('sha256', valid ? WEBHOOK_SECRET : 'not-the-secret').update(body).digest('hex')}`,
  }, body });
  return response.status;
}

async function dispatchCI(source, opened = true) {
  if (opened) expect(await signedWebhook('pull_request', { action: 'opened', pull_request: source.pr })).toBe(200);
  expect(await signedWebhook('check_run', { action: 'completed', check_run: { id: source.pr.number + 200000, name: 'native-ci', status: 'completed', conclusion: 'success', head_sha: source.pr.head.sha, app: { slug: 'github-actions' } } })).toBe(200);
  await expect.poll(async () => (await db.getPool().query("SELECT id FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND claim_type='review'", [orgId, repo, source.pr.number])).rows.length).toBe(1);
  return (await db.getPool().query("SELECT * FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND claim_type='review'", [orgId, repo, source.pr.number])).rows[0];
}

async function reviewFixture({ verdict = 'FAIL' } = {}) {
  const source = await sourceFixture();
  await workspace(source, { final: true });
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  expect((await agent(source.token, '/claim', { session_id: source.sessionId, claim_id: source.claimId,
    repo, pr_number: null, attempt: source.attempt, status: 'completed' })).status).toBe(200);
  const review = await dispatchCI(source);
  const token = await db.createToken({ orgId, agentId, label: 'native-review-owner' });
  const registered = await agent(token.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 1, capacity: 4, supported_claim_types: ['review'],
  } });
  const leased = await agent(token.plaintext, '/poll', { session_id: registered.body.session_id });
  expect(leased.body.work.claim_id).toBe(review.id);
  const publication = await tool({ reporting: leased.body.work.reporting }, 'collaboration_report_review', {
    status: verdict, blocking: verdict === 'FAIL' ? [{ file: 'src/example.js', line: 10, issue: 'A real blocking defect' }] : [], advisory: [],
  });
  expect(publication.isError).toBe(false);
  return { source, review, work: leased.body.work, marker: publication.value.marker };
}

function reviewEvent({ source, marker }, status, overrides = {}) {
  return { repository: { id: 9001, full_name: repo }, action: 'submitted', pull_request: source.pr,
    review: { id: source.pr.number + 300000, node_id: `PRR_native_${source.pr.number}`, commit_id: source.pr.head.sha,
      body: `<!-- reviewer-result: ${JSON.stringify({ ...marker, status,
        blocking: status === 'FAIL' ? [{ file: 'src/example.js', line: 10, issue: 'A real blocking defect' }] : [],
        ...overrides })} -->` } };
}

it('links a signed native review failure to the actual leased review and preserves the initiating root', async () => {
  const fixture = await reviewFixture();
  expect(typeof fixture.marker.review_ticket).toBe('string');
  expect(await signedWebhook('pull_request_review', reviewEvent(fixture, 'FAIL'))).toBe(200);
  await expect.poll(async () => (await db.getPool().query(
    "SELECT id FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND claim_type='review_fix'",
    [orgId, repo, fixture.source.pr.number])).rows.length).toBe(1);
  const lineage = await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id,
    execution.created_by_principal_id,execution.created_by_session_version FROM collab_claim_executions execution
    JOIN agent_claims claim ON claim.id=execution.claim_id WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.claim_type='review_fix'`,
  [repo, fixture.source.pr.number]);
  expect(lineage.rows).toEqual([{ parent_claim_id: fixture.review.id, root_claim_id: fixture.source.rootClaimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion }]);
});

it.each(['missing','forged','stale_acquisition','wrong_commit'])('ignores %s native review evidence before changing retry counts or queuing paid work', async kind => {
  const fixture = await reviewFixture();
  const event = reviewEvent(fixture, 'FAIL', kind === 'missing' ? { claim_id: undefined, review_ticket: undefined }
    : kind === 'forged' ? { review_ticket: `ffrv_${'A'.repeat(43)}` } : {});
  if (kind === 'stale_acquisition') await db.getPool().query("UPDATE agent_claims SET claimed_at=claimed_at+interval '1 microsecond' WHERE id=$1", [fixture.review.id]);
  if (kind === 'wrong_commit') event.review.commit_id = 'f'.repeat(40);
  const before = (await db.getPool().query('SELECT retry_count,last_review_sha FROM review_retries WHERE repo=$1 AND pr_number=$2', [repo, fixture.source.pr.number])).rows;
  await routeWebhookEvent('pull_request_review', event);
  expect((await db.getPool().query('SELECT retry_count,last_review_sha FROM review_retries WHERE repo=$1 AND pr_number=$2', [repo, fixture.source.pr.number])).rows).toEqual(before);
  expect((await db.getPool().query("SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type IN ('review_fix','verify')", [repo, fixture.source.pr.number])).rows).toEqual([]);
});

it('does not let a native GitHub PASS terminate the still-owned review process', async () => {
  const fixture = await reviewFixture({ verdict: 'PASS' });
  await routeWebhookEvent('pull_request_review', reviewEvent(fixture, 'PASS'));
  expect((await db.getPool().query('SELECT status,session_id FROM agent_claims WHERE id=$1', [fixture.review.id])).rows)
    .toEqual([{ status: 'claimed', session_id: expect.any(Number) }]);
});

it('records the actual completed spec as the parent of its automatically queued build', async () => {
  const source = await sourceFixture();
  expect((await db.getPool().query('SELECT parent_claim_id,root_claim_id FROM collab_claim_executions WHERE claim_id=$1', [source.claimId])).rows)
    .toEqual([{ parent_claim_id: source.rootClaimId, root_claim_id: source.rootClaimId }]);
});

it.each([false, true])('preserves native review red fix green and rereview ancestry across authenticated leases (early CI: %s)', async (earlyCI) => {
  github.config.verification = { enabled: true };
  const fixture = await reviewFixture();
  const oldHead = fixture.source.pr.head.sha;
  await routeWebhookEvent('pull_request_review', reviewEvent(fixture, 'FAIL'));
  const token = await db.createToken({ orgId, agentId, label: 'native-red-owner' });
  const registered = await agent(token.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 2, capacity: 4, supported_claim_types: ['verify'],
  } });
  const leased = await agent(token.plaintext, '/poll', { session_id: registered.body.session_id });
  const red = leased.body.work;
  expect(red).toMatchObject({ claim_type: 'verify', phase: 'red', findings: [{ id: 'F1', message: 'A real blocking defect' }] });
  fixture.source.pr.head.sha = 'b'.repeat(40);
  const reported = await agent(token.plaintext, '/claim', {
    session_id: registered.body.session_id, claim_id: red.claim_id, repo, pr_number: fixture.source.pr.number,
    attempt: red.attempt, status: 'completed', verification: {
      phase: 'red', framework: 'vitest', outcome: 'PASS',
      matrix: { requirements: [], suite: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 }, schema_version: 1 },
      test_hashes: [{ path: 'test/verify/requirement.test.js', sha256: 'a'.repeat(64) }],
      artifact_sha: fixture.source.pr.head.sha, red_base_sha: oldHead,
      manifest: { pr_number: fixture.source.pr.number, requirements: [{
        requirement: { id: 'REQ-1', form: 'ubiquitous', text: 'The defect is prevented.', source_finding_id: 'F1' },
        tests: ['test/verify/requirement.test.js'], framework: 'vitest',
      }] },
    },
  });
  expect(reported.status, JSON.stringify((await import('../../src/logger.js')).default.error.mock.calls)).toBe(200);
  const lineage = await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id,
    execution.created_by_principal_id,execution.created_by_session_version FROM collab_claim_executions execution
    JOIN agent_claims claim ON claim.id=execution.claim_id WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.claim_type='review_fix'`,
  [repo, fixture.source.pr.number]);
  expect(lineage.rows).toEqual([{ parent_claim_id: red.claim_id, root_claim_id: fixture.source.rootClaimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion }]);
  const fixToken = await db.createToken({ orgId, agentId, label: 'native-fix-owner' });
  const fixer = await agent(fixToken.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 3, capacity: 4, supported_claim_types: ['review_fix'],
  } });
  const fix = (await agent(fixToken.plaintext, '/poll', { session_id: fixer.body.session_id })).body.work;
  expect((await db.getPool().query('SELECT head_sha FROM agent_claims WHERE id=$1', [fix.claim_id])).rows)
    .toEqual([{ head_sha: 'b'.repeat(40) }]);
  fixture.source.pr.head.sha = 'c'.repeat(40);
  const fixed = { ...fixture.source, claimId: fix.claim_id, reporting: fix.reporting, seq: 0 };
  const ciEvent = { repository: { id: 9001, full_name: repo }, action: 'completed', check_run: {
    id: fixture.source.pr.number + 400000, name: 'native-ci', status: 'completed', conclusion: 'success',
    head_sha: fixture.source.pr.head.sha, app: { slug: 'github-actions' },
  } };
  if (earlyCI) {
    await routeWebhookEvent('check_run', ciEvent);
    const held = await db.getPool().query(`SELECT claim.status,claim.session_id,reservation.producer_binding_id,
      reservation.task_id,reservation.root_claim_id FROM agent_claims claim
      JOIN collab_claim_pr_reservations reservation ON reservation.claim_id=claim.id
      WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.payload->>'phase'='green'`, [repo, fixture.source.pr.number]);
    expect(held.rows).toEqual([{ status: 'pending', session_id: null, producer_binding_id: fix.reporting.bindingId,
      task_id: fixture.source.taskId, root_claim_id: fixture.source.rootClaimId }]);
    expect(await claimPendingWork(orgId, agentId, registered.body.session_id)).toBeNull();
  }
  await workspace(fixed, { final: true });
  expect((await tool(fixed, 'collaboration_link_pull_request', { prNumber: fixture.source.pr.number })).isError).toBe(false);
  expect((await agent(fixToken.plaintext, '/claim', {
    session_id: fixer.body.session_id, claim_id: fix.claim_id, repo, pr_number: fixture.source.pr.number,
    attempt: fix.attempt, status: 'completed',
  })).status).toBe(200);
  expect(await signedWebhook('check_run', { action: 'completed', check_run: {
    id: fixture.source.pr.number + 400000, name: 'native-ci', status: 'completed', conclusion: 'success',
    head_sha: fixture.source.pr.head.sha, app: { slug: 'github-actions' },
  } })).toBe(200);
  await expect.poll(async () => (await db.getPool().query(
    "SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type='verify' AND payload->>'phase'='green'",
    [repo, fixture.source.pr.number])).rows.length).toBe(1);
  const greenLineage = await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id
    FROM collab_claim_executions execution JOIN agent_claims claim ON claim.id=execution.claim_id
    WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.payload->>'phase'='green'`,
  [repo, fixture.source.pr.number]);
  expect(greenLineage.rows).toEqual([{ parent_claim_id: fix.claim_id, root_claim_id: fixture.source.rootClaimId }]);
  const green = (await agent(token.plaintext, '/poll', { session_id: registered.body.session_id })).body.work;
  expect(green).toMatchObject({ phase: 'green', reporting: { credential: expect.any(String) } });
  await routeWebhookEvent('check_run', { repository: { id: 9001, full_name: repo }, action: 'completed', check_run: {
    id: fixture.source.pr.number + 400000, name: 'native-ci', status: 'completed', conclusion: 'success',
    head_sha: fixture.source.pr.head.sha, app: { slug: 'github-actions' },
  } });
  expect((await db.getPool().query(
    "SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type='verify' AND payload->>'phase'='green'",
    [repo, fixture.source.pr.number])).rows).toEqual([{ id: green.claim_id }]);
  const greenResult = await agent(token.plaintext, '/claim', {
    session_id: registered.body.session_id, claim_id: green.claim_id, repo, pr_number: fixture.source.pr.number,
    attempt: green.attempt, status: 'completed', verification: {
      phase: 'green', framework: 'vitest', outcome: 'PASS',
      matrix: { requirements: [], suite: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 }, schema_version: 1 },
      test_hashes: [{ path: 'test/verify/requirement.test.js', sha256: 'a'.repeat(64) }],
      artifact_sha: 'b'.repeat(40), red_base_sha: oldHead, green_sha: fixture.source.pr.head.sha,
    },
  });
  expect(greenResult.status, JSON.stringify((await import('../../src/logger.js')).default.error.mock.calls)).toBe(200);
  expect((await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id FROM collab_claim_executions execution
    JOIN agent_claims claim ON claim.id=execution.claim_id WHERE claim.repo=$1 AND claim.pr_number=$2
    AND claim.claim_type='review' AND claim.head_sha=$3`, [repo, fixture.source.pr.number, fixture.source.pr.head.sha])).rows)
    .toEqual([{ parent_claim_id: green.claim_id, root_claim_id: fixture.source.rootClaimId }]);
  if (!earlyCI) {
    fixture.source.pr.head.sha = 'e'.repeat(40);
    const restarted = await sourceFixture({ taskId: fixture.source.taskId, pullRequest: fixture.source.pr, initiator: restarter });
    await workspace(restarted, { final: true });
    expect((await tool(restarted, 'collaboration_link_pull_request', {})).isError).toBe(false);
    expect((await agent(restarted.token, '/claim', { session_id: restarted.sessionId, claim_id: restarted.claimId,
      repo, pr_number: null, attempt: restarted.attempt, status: 'completed' })).status).toBe(200);
    await routeWebhookEvent('check_run', { ...ciEvent, check_run: {
      ...ciEvent.check_run, id: ciEvent.check_run.id + 1, head_sha: restarted.pr.head.sha,
    } });
    expect((await db.getPool().query(`SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2
      AND claim_type='verify' AND payload->>'phase'='green' AND head_sha=$3`,
    [repo, restarted.pr.number, restarted.pr.head.sha])).rows).toEqual([]);
    expect((await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id,
      execution.created_by_principal_id,execution.created_by_session_version FROM collab_claim_executions execution
      JOIN agent_claims claim ON claim.id=execution.claim_id WHERE claim.repo=$1 AND claim.pr_number=$2
      AND claim.claim_type='review' AND claim.head_sha=$3`, [repo, restarted.pr.number, restarted.pr.head.sha])).rows)
      .toEqual([{ parent_claim_id: restarted.claimId, root_claim_id: restarted.rootClaimId,
        created_by_principal_id: restarter.principalId, created_by_session_version: restarter.sessionVersion }]);
  }
});

it('holds an early rereview on its actual fixer when verification is disabled', async () => {
  const fixture = await reviewFixture();
  await routeWebhookEvent('pull_request_review', reviewEvent(fixture, 'FAIL'));
  const fixToken = await db.createToken({ orgId, agentId, label: 'early-native-fix' });
  const fixer = await agent(fixToken.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 2, capacity: 4, supported_claim_types: ['review_fix'],
  } });
  const fix = (await agent(fixToken.plaintext, '/poll', { session_id: fixer.body.session_id })).body.work;
  expect(fix.claim_type).toBe('review_fix');
  fixture.source.pr.head.sha = 'd'.repeat(40);
  await routeWebhookEvent('check_run', { repository: { id: 9001, full_name: repo }, action: 'completed', check_run: {
    id: fixture.source.pr.number + 500000, name: 'native-ci', status: 'completed', conclusion: 'success',
    head_sha: fixture.source.pr.head.sha, app: { slug: 'github-actions' },
  } });
  const held = (await db.getPool().query(`SELECT claim.id,claim.status,reservation.producer_binding_id FROM agent_claims claim
    JOIN collab_claim_pr_reservations reservation ON reservation.claim_id=claim.id
    WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.claim_type='review' AND claim.head_sha=$3`,
  [repo, fixture.source.pr.number, fixture.source.pr.head.sha])).rows;
  expect(held).toEqual([{ id: expect.any(Number), status: 'pending', producer_binding_id: fix.reporting.bindingId }]);
  const reviewerToken = await db.createToken({ orgId, agentId, label: 'early-native-rereview' });
  const reviewer = await agent(reviewerToken.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 3, capacity: 4, supported_claim_types: ['review'],
  } });
  expect(await claimPendingWork(orgId, agentId, reviewer.body.session_id)).toBeNull();
  const fixed = { ...fixture.source, claimId: fix.claim_id, reporting: fix.reporting, seq: 0 };
  await workspace(fixed, { final: true });
  expect((await tool(fixed, 'collaboration_link_pull_request', {})).isError).toBe(false);
  expect((await agent(fixToken.plaintext, '/claim', { session_id: fixer.body.session_id, claim_id: fix.claim_id,
    repo, pr_number: fixture.source.pr.number, attempt: fix.attempt, status: 'completed' })).status).toBe(200);
  const work = (await agent(reviewerToken.plaintext, '/poll', { session_id: reviewer.body.session_id })).body.work;
  expect(work).toMatchObject({ claim_id: held[0].id, claim_type: 'review', reporting: { credential: expect.any(String) } });
  expect((await db.getPool().query('SELECT parent_claim_id,root_claim_id FROM collab_claim_executions WHERE claim_id=$1', [work.claim_id])).rows)
    .toEqual([{ parent_claim_id: fix.claim_id, root_claim_id: fixture.source.rootClaimId }]);
  expect((await db.getPool().query("SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type='verify'",
    [repo, fixture.source.pr.number])).rows).toEqual([]);
});

it('records one authenticated native PR without requiring a host mapping or inventing execution identities', async () => {
  const source = await sourceFixture();
  await workspace(source);
  const linked = await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number });
  expect(linked.isError).toBe(false);
  expect(linked.value).toMatchObject({ taskId: source.taskId, repo, prNumber: source.pr.number, claimId: source.claimId, verified: true });
  expect(await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).toMatchObject({ isError: false, value: { id: linked.value.id } });
  const persisted = await db.getPool().query('SELECT task_id,claim_id,created_by_principal_id FROM collab_delivery_links WHERE id=$1', [linked.value.id]);
  expect(persisted.rows).toEqual([{ task_id: source.taskId, claim_id: String(source.claimId), created_by_principal_id: actor.principalId }]);
  const links = await collab('GET', `/tasks/${source.taskId}/delivery-links`);
  expect(links.status).toBe(200);
  expect(links.body.data).toEqual([expect.objectContaining({ id: linked.value.id, prNumber: source.pr.number, verified: true })]);
  const runs = await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1', [source.taskId]);
  expect(runs.rows).toEqual([]);
  for (const secret of Object.values(source.reporting)) expect(JSON.stringify([linked.value, links.body])).not.toContain(secret);
});

it('preserves the PR origin while a later authorized task start uses its own creator snapshot and root', async () => {
  const source = await sourceFixture();
  await workspace(source, { final: true });
  const initial = await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number });
  expect(initial.isError).toBe(false);
  expect((await agent(source.token, '/claim', { session_id: source.sessionId, claim_id: source.claimId, repo, pr_number: null, attempt: source.attempt, status: 'completed' })).status).toBe(200);
  const second = await sourceFixture({ taskId: source.taskId, pullRequest: source.pr, initiator: restarter });
  await workspace(second);
  const linked = await tool(second, 'collaboration_link_pull_request', { prNumber: source.pr.number });
  expect(linked).toMatchObject({ isError: false, value: { id: initial.value.id, claimId: source.claimId, producerClaimId: second.claimId } });
  const review = await createClaim({ orgId, repo, prNumber: source.pr.number, attempt: 1, claimType: 'review', parentClaimId: second.claimId, payload: { branch: second.branch }, headSha: source.pr.head.sha });
  const lineage = await db.getPool().query('SELECT root_claim_id,parent_claim_id,created_by_principal_id,created_by_session_version FROM collab_claim_executions WHERE claim_id=$1', [review.id]);
  expect(lineage.rows).toEqual([{ root_claim_id: second.rootClaimId, parent_claim_id: second.claimId,
    created_by_principal_id: restarter.principalId, created_by_session_version: restarter.sessionVersion }]);
  expect((await db.getPool().query('SELECT claim_id,created_by_principal_id FROM collab_delivery_links WHERE id=$1', [initial.value.id])).rows)
    .toEqual([{ claim_id: String(source.claimId), created_by_principal_id: actor.principalId }]);
});

it('does not queue native review work for a head that GitHub has already superseded', async () => {
  const source = await sourceFixture();
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  const oldHead = source.pr.head.sha;
  source.pr.head.sha = 'b'.repeat(40);
  const stale = await createClaim({ orgId, repo, prNumber: source.pr.number, attempt: 1, claimType: 'review', parentClaimId: source.claimId, payload: { branch: source.branch }, headSha: oldHead });
  expect(stale).toBeNull();
  expect((await db.getPool().query("SELECT id FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND claim_type='review'", [orgId,repo,source.pr.number])).rows).toEqual([]);
});

it.each(['repository','fork','branch','head','unpushed','dirty'])('rejects %s mismatch instead of trusting model-supplied PR identity', async mismatch => {
  const source = await sourceFixture();
  const observed = mismatch === 'unpushed' ? { taskBranchHead: 'b'.repeat(40) } : mismatch === 'dirty' ? { dirty: true } : {};
  await workspace(source, observed);
  if (mismatch === 'repository') source.pr.base.repo = { ...source.pr.base.repo, full_name: 'foreign/fixture' };
  if (mismatch === 'fork') source.pr.head.repo = { ...source.pr.head.repo, id: 9002, node_id: 'R_foreign_fork', full_name: 'attacker/fixture' };
  if (mismatch === 'branch') source.pr.head.ref = 'unrelated-branch';
  if (mismatch === 'head') source.pr.head.sha = 'b'.repeat(40);
  github.prs.set(source.pr.number, source.pr);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(true);
  expect((await db.getPool().query('SELECT id FROM collab_delivery_links WHERE task_id=$1', [source.taskId])).rows).toEqual([]);
});

it('holds early signed-webhook work unleased until native producer proof atomically supplies task lineage', async () => {
  const source = await sourceFixture();
  const review = await dispatchCI(source);
  const observerToken = await db.createToken({ orgId, agentId, label: 'early-review-observer' });
  const observer = await agent(observerToken.plaintext, '/register', { meta: { instance_id: randomUUID(), slot_id: 1, capacity: 4, supported_claim_types: ['review'] } });
  expect(await claimPendingWork(orgId, agentId, observer.body.session_id)).toBeNull();
  expect((await db.getPool().query('SELECT claim_id FROM collab_claim_executions WHERE claim_id=$1', [review.id])).rows).toEqual([]);
  await workspace(source);
  const linked = await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number });
  expect(linked.isError).toBe(false);
  const acquired = await agent(observerToken.plaintext, '/poll', { session_id: observer.body.session_id });
  expect(acquired.body.work).toMatchObject({ claim_id: review.id, claim_type: 'review', reporting: { credential: expect.any(String) } });
  const lineage = await db.getPool().query('SELECT task_id,root_claim_id,parent_claim_id,created_by_principal_id,created_by_session_version FROM collab_claim_executions WHERE claim_id=$1', [review.id]);
  expect(lineage.rows).toEqual([{ task_id: source.taskId, root_claim_id: source.rootClaimId, parent_claim_id: source.claimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion }]);
});

it('resolves a native candidate from authenticated GitHub when CI precedes the PR-open webhook', async () => {
  const source = await sourceFixture();
  const review = await dispatchCI(source, false);
  expect((await db.getPool().query('SELECT claim_id FROM collab_claim_executions WHERE claim_id=$1', [review.id])).rows).toEqual([]);
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', {})).isError).toBe(false);
  const scoped = await db.getPool().query('SELECT task_id,parent_claim_id FROM collab_claim_executions WHERE claim_id=$1', [review.id]);
  expect(scoped.rows).toEqual([{ task_id: source.taskId, parent_claim_id: source.claimId }]);
});

it('never adopts pre-existing unrelated claim history or a forged PR webhook', async () => {
  const source = await sourceFixture();
  const unrelated = await createClaim({ orgId, repo, prNumber: source.pr.number, attempt: 1, claimType: 'review', payload: { branch: 'unrelated' }, headSha: 'f'.repeat(40) });
  await db.getPool().query("UPDATE agent_claims SET status='completed',completed_at=now() WHERE id=$1", [unrelated.id]);
  expect(await signedWebhook('pull_request', { action: 'opened', pull_request: source.pr }, false)).toBe(401);
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  expect((await db.getPool().query('SELECT claim_id FROM collab_claim_executions WHERE claim_id=$1', [unrelated.id])).rows).toEqual([]);
});

it('keeps a generic post-link claim outside the task reporting authority', async () => {
  const source = await sourceFixture();
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  const unrelated = await createClaim({ orgId, repo, prNumber: source.pr.number, attempt: 7,
    claimType: 'review_fix', payload: { branch: source.branch }, headSha: source.pr.head.sha });
  const token = await db.createToken({ orgId, agentId, label: 'generic-post-link-owner' });
  const observer = await agent(token.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 1, capacity: 4, supported_claim_types: ['review_fix'],
  } });
  const acquired = await agent(token.plaintext, '/poll', { session_id: observer.body.session_id });
  expect(acquired.body.work).toMatchObject({ claim_id: unrelated.id });
  expect(Object.hasOwn(acquired.body.work, 'reporting')).toBe(false);
  expect((await db.getPool().query('SELECT claim_id FROM collab_claim_executions WHERE claim_id=$1', [unrelated.id])).rows).toEqual([]);
});

it('does not spend twice when GitHub redelivers the same native review result', async () => {
  const fixture = await reviewFixture();
  const event = reviewEvent(fixture, 'FAIL');
  await routeWebhookEvent('pull_request_review', event);
  await routeWebhookEvent('pull_request_review', event);
  expect((await db.getPool().query('SELECT retry_count FROM review_retries WHERE repo=$1 AND pr_number=$2', [repo, fixture.source.pr.number])).rows)
    .toEqual([{ retry_count: 1 }]);
  expect((await db.getPool().query("SELECT count(*)::int AS total FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type='review_fix'", [repo, fixture.source.pr.number])).rows)
    .toEqual([{ total: 1 }]);
});

it('cannot change a published PASS into paid FAIL work by copying its public marker', async () => {
  const fixture = await reviewFixture({ verdict: 'PASS' });
  await routeWebhookEvent('pull_request_review', reviewEvent(fixture, 'PASS'));
  const before = (await db.getPool().query('SELECT retry_count,last_review_sha FROM review_retries WHERE repo=$1 AND pr_number=$2', [repo, fixture.source.pr.number])).rows;
  const forged = reviewEvent(fixture, 'FAIL');
  forged.review.id += 1;
  forged.review.node_id += '_copied';
  await routeWebhookEvent('pull_request_review', forged);
  expect((await db.getPool().query('SELECT retry_count,last_review_sha FROM review_retries WHERE repo=$1 AND pr_number=$2', [repo, fixture.source.pr.number])).rows).toEqual(before);
  expect((await db.getPool().query("SELECT id FROM agent_claims WHERE repo=$1 AND pr_number=$2 AND claim_type IN ('review_fix','verify')", [repo, fixture.source.pr.number])).rows).toEqual([]);
});

it('freezes one owner-published review per acquisition and rejects a different verdict', async () => {
  const fixture = await reviewFixture({ verdict: 'PASS' });
  const own = { reporting: fixture.work.reporting };
  const replay = await tool(own, 'collaboration_report_review', { status: 'PASS', blocking: [], advisory: [] });
  expect(replay).toMatchObject({ isError: false, value: { marker: fixture.marker } });
  const changed = await tool(own, 'collaboration_report_review', {
    status: 'FAIL', blocking: [{ message: 'A different result' }], advisory: [],
  });
  expect(changed.isError).toBe(true);
  expect((await db.getPool().query('SELECT result_json,applied_at FROM collab_claim_review_results WHERE id=$1', [fixture.marker.review_result_id])).rows)
    .toEqual([{ result_json: JSON.stringify({ status: 'PASS', blocking: [], advisory: [] }), applied_at: null }]);
  for (const secret of Object.values(fixture.work.reporting)) expect(JSON.stringify(replay.value)).not.toContain(secret);
});

it('does not let a build-purpose reporting credential publish a review result', async () => {
  const source = await sourceFixture();
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  expect((await tool(source, 'collaboration_report_review', { status: 'PASS', blocking: [], advisory: [] })).isError).toBe(true);
  expect((await db.getPool().query('SELECT id FROM collab_claim_review_results WHERE reporting_binding_id=$1', [source.reporting.bindingId])).rows).toEqual([]);
});

it('rolls back source expiry if reserved-claim cancellation fails and recovers on the next sweep', async () => {
  const source = await sourceFixture();
  const reserved = await dispatchCI(source);
  await db.getPool().query("UPDATE agent_claims SET expires_at=now()-interval '1 hour' WHERE id=$1", [source.claimId]);
  const before = (await db.getPool().query('SELECT status FROM agent_sessions WHERE id=$1', [source.sessionId])).rows;
  await db.getPool().query(`CREATE FUNCTION ff_test_reject_reservation_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.org_id='native-pr-org' AND OLD.status='pending' AND NEW.status='cancelled' AND NEW.claim_type='review' THEN
        RAISE EXCEPTION 'Fixture blocked reservation cancellation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ff_test_reservation_cancel BEFORE UPDATE ON agent_claims
    FOR EACH ROW EXECUTE FUNCTION ff_test_reject_reservation_cancel()`);
  try {
    await expect(expireClaims()).rejects.toThrow('Fixture blocked reservation cancellation');
    expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [source.claimId])).rows).toEqual([{ status: 'claimed' }]);
    expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [reserved.id])).rows).toEqual([{ status: 'pending' }]);
    expect((await db.getPool().query('SELECT status FROM agent_sessions WHERE id=$1', [source.sessionId])).rows).toEqual(before);
  } finally {
    await db.getPool().query('DROP TRIGGER ff_test_reservation_cancel ON agent_claims; DROP FUNCTION ff_test_reject_reservation_cancel()');
  }
  await expireClaims();
  expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [source.claimId])).rows).toEqual([{ status: 'expired' }]);
  expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [reserved.id])).rows).toEqual([{ status: 'cancelled' }]);
});

it('requires the owning finalized PR output before completing a native build', async () => {
  const source = await sourceFixture();
  const result = { session_id: source.sessionId, claim_id: source.claimId, repo, pr_number: null,
    attempt: source.attempt, status: 'completed' };
  expect((await agent(source.token, '/claim', result)).status).toBe(409);
  expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [source.claimId])).rows).toEqual([{ status: 'claimed' }]);
  await workspace(source);
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  expect((await agent(source.token, '/claim', result)).status).toBe(409);
  await workspace(source, { final: true });
  expect((await tool(source, 'collaboration_link_pull_request', { prNumber: source.pr.number })).isError).toBe(false);
  expect((await agent(source.token, '/claim', result)).status).toBe(200);
  expect((await agent(source.token, '/claim', result)).status).toBe(200);
  expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [source.claimId])).rows).toEqual([{ status: 'completed' }]);
});

it('does not treat another acquisition output at the same head as the new build completion proof', async () => {
  const first = await sourceFixture();
  await workspace(first, { final: true });
  expect((await tool(first, 'collaboration_link_pull_request', { prNumber: first.pr.number })).isError).toBe(false);
  expect((await agent(first.token, '/claim', { session_id: first.sessionId, claim_id: first.claimId, repo,
    pr_number: null, attempt: first.attempt, status: 'completed' })).status).toBe(200);
  const second = await sourceFixture({ taskId: first.taskId, pullRequest: first.pr, initiator: restarter });
  await workspace(second, { final: true });
  const result = { session_id: second.sessionId, claim_id: second.claimId, repo, pr_number: null,
    attempt: second.attempt, status: 'completed' };
  expect((await agent(second.token, '/claim', result)).status).toBe(409);
  expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [second.claimId])).rows).toEqual([{ status: 'claimed' }]);
  expect((await tool(second, 'collaboration_link_pull_request', { prNumber: first.pr.number })).isError).toBe(false);
  expect((await agent(second.token, '/claim', result)).status).toBe(200);
  await db.getPool().query('UPDATE collab_scoped_tokens SET revoked_at=now() WHERE id=$1', [first.reporting.bindingId]);
  const beforeReplay = (await db.getPool().query('SELECT id,status FROM agent_claims WHERE org_id=$1 ORDER BY id', [orgId])).rows;
  expect((await agent(first.token, '/claim', { session_id: first.sessionId, claim_id: first.claimId, repo,
    pr_number: null, attempt: first.attempt, status: 'completed' })).status).toBe(200);
  expect((await db.getPool().query('SELECT id,status FROM agent_claims WHERE org_id=$1 ORDER BY id', [orgId])).rows).toEqual(beforeReplay);
});

it.each([false, true])('reviews the current producer instead of older same-root work (active old fix: %s)', async (activeFix) => {
  const fixture = await reviewFixture({ verdict: activeFix ? 'FAIL' : 'PASS' });
  if (activeFix) {
    await routeWebhookEvent('pull_request_review', reviewEvent(fixture, 'FAIL'));
    const token = await db.createToken({ orgId, agentId, label: 'older-same-root-fix' });
    const session = await agent(token.plaintext, '/register', { meta: {
      instance_id: randomUUID(), slot_id: 2, capacity: 4, supported_claim_types: ['review_fix'],
    } });
    expect((await agent(token.plaintext, '/poll', { session_id: session.body.session_id })).body.work.claim_type).toBe('review_fix');
  }
  const rebuild = await createFollowOnClaim({ parentClaimId: fixture.source.rootClaimId, orgId, repo,
    prNumber: null, claimType: 'build', payload: { source: 'collab', branch: fixture.source.branch } });
  const token = await db.createToken({ orgId, agentId, label: 'same-root-rebuild' });
  const session = await agent(token.plaintext, '/register', { meta: {
    instance_id: randomUUID(), slot_id: 3, capacity: 4, supported_claim_types: ['build'],
  } });
  const work = (await agent(token.plaintext, '/poll', { session_id: session.body.session_id })).body.work;
  expect(work.claim_id).toBe(rebuild.id);
  fixture.source.pr.head.sha = 'f'.repeat(40);
  const producer = { ...fixture.source, claimId: work.claim_id, reporting: work.reporting, seq: 0 };
  await workspace(producer, { final: true });
  expect((await tool(producer, 'collaboration_link_pull_request', {})).isError).toBe(false);
  expect((await agent(token.plaintext, '/claim', { session_id: session.body.session_id, claim_id: work.claim_id,
    repo, pr_number: null, attempt: work.attempt, status: 'completed' })).status).toBe(200);
  await routeWebhookEvent('check_run', { repository: { id: 9001, full_name: repo }, action: 'completed', check_run: {
    id: fixture.source.pr.number + 600000, name: 'native-ci', status: 'completed', conclusion: 'success',
    head_sha: fixture.source.pr.head.sha, app: { slug: 'github-actions' },
  } });
  expect((await db.getPool().query(`SELECT execution.parent_claim_id,execution.root_claim_id
    FROM collab_claim_executions execution JOIN agent_claims claim ON claim.id=execution.claim_id
    WHERE claim.repo=$1 AND claim.pr_number=$2 AND claim.claim_type='review' AND claim.head_sha=$3`,
  [repo, fixture.source.pr.number, fixture.source.pr.head.sha])).rows)
    .toEqual([{ parent_claim_id: work.claim_id, root_claim_id: fixture.source.rootClaimId }]);
});
