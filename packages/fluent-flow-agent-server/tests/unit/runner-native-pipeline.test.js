import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const github = vi.hoisted(() => ({ prs: new Map(), checks: new Map(), origin: null }));
vi.mock('../../../fluent-flow/src/providers/github/rest.js', async () => {
  const actual = await vi.importActual('../../../fluent-flow/src/providers/github/rest.js');
  const observedPullRequest = (pullRequest) => {
    const observed = structuredClone(pullRequest);
    observed.head.sha = execFileSync('git', ['--git-dir', github.origin, 'rev-parse', `refs/heads/${observed.head.ref}`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    return observed;
  };
  return { ...actual,
    getPR: async (_owner, _name, number) => {
      const pullRequest = github.prs.get(number);
      if (!pullRequest) throw new Error('Fixture pull request does not exist');
      return observedPullRequest(pullRequest);
    },
    findPullRequestsByHead: async (_owner, _name, branch) => [...github.prs.values()]
      .filter((pullRequest) => pullRequest.head.ref === branch && pullRequest.state === 'open')
      .map(observedPullRequest),
    getPRsForCommit: async (_owner, _name, sha) => [...github.prs.values()]
      .map(observedPullRequest).filter((pullRequest) => pullRequest.head.sha === sha),
    getCheckRunsForCommit: async (_owner, _name, sha) => [...github.checks.values()]
      .filter((checkRun) => checkRun.head_sha === sha)
      .map((checkRun) => structuredClone(checkRun)),
    getCheckRunAnnotations: async () => [],
    getReviews: async () => [],
    dismissReview: async () => {},
    postComment: async () => ({}),
    getRepoFileContents: async (_owner, _name, path) => path === '.github/fluent-flow.yml'
      ? Buffer.from('verification:\n  framework: node\n  install_command: ["node", "-e", "0"]\n  flake: { retries: 0 }\n  authoring: { retries: 0, red_reproductions: 1 }\n  timeouts_min: { red: 2, green: 2 }\n').toString('base64')
      : null,
  };
});
vi.mock('../../../fluent-flow/src/providers/github/graphql.js', async () => {
  const actual = await vi.importActual('../../../fluent-flow/src/providers/github/graphql.js');
  return { ...actual, getPRNodeId: async () => 'PR_pipeline_fixture', enablePullRequestAutoMerge: async () => ({}) };
});
vi.mock('../../../fluent-flow/src/providers/github/app-auth.js', async () => {
  const actual = await vi.importActual('../../../fluent-flow/src/providers/github/app-auth.js');
  return { ...actual, fetchInstallationToken: async () => ({ token: 'ghs_pipelineFixture000000000000000000000000', expiresAt: new Date(Date.now() + 3600_000) }) };
});

const previousSecrets = { auth: process.env.FF_COLLAB_AUTH_SECRET, webhook: process.env.FF_GITHUB_APP_WEBHOOK_SECRET };
const databaseUrl = process.env.COLLAB_REPORTING_MCP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_REPORTING_MCP_TEST_DATABASE_URL must name a dedicated loopback ff_reporting_mcp_* database.');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname) || !/^\/ff_reporting_mcp_[a-z0-9_]+$/.test(parsedDatabaseUrl.pathname)) {
  throw new Error('Unsafe reporting MCP integration database.');
}
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'pipeline-secret-0123456789abcdef0123456789abcdef';
process.env.FF_GITHUB_APP_WEBHOOK_SECRET = 'pipeline-webhook-secret-0123456789abcdef';

const { resetCollabSchema, seedUser, seedOrgMembership } = await import('../../../fluent-flow/tests/helpers/collab-db.js');
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { createRunner } = await import('../../src/runner.js');
const { createClient } = await import('../../src/client.js');
const { createLogger } = await import('../../src/logger.js');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const orgId = 'pipeline-org';
const repo = 'acme/runner-native-pipeline';
const githubUrl = `https://github.com/${repo}.git`;
const chatAgentId = 'pipeline-chat-agent';
const workAgentId = 'pipeline-work-agent';
let prNumber = 9100;
const cleanupRoots = [];

let server;
let base;
let owner;
let projectId;

function asActor(principal) {
  return { principalId: principal.id, sessionVersion: principal.sessionVersion };
}

async function listen() {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop(target) {
  await new Promise((resolve) => target.close(resolve));
}

async function collabRequest(method, path, body, idempotencyKey) {
  const response = await fetch(`${base}/api/collab/v1${path}`, {
    method,
    headers: {
      'x-fluent-flow-actor': db.signCollaborationActor(asActor(owner), process.env.FF_COLLAB_AUTH_SECRET),
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function signedWebhook(event, payload) {
  const body = JSON.stringify({ repository: { id: 91001, full_name: repo }, ...payload });
  const response = await fetch(`${base}/webhooks/github-app`, { method: 'POST', headers: {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.FF_GITHUB_APP_WEBHOOK_SECRET).update(body).digest('hex')}`,
  }, body });
  return response.status;
}

async function until(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for pipeline state');
}

function gitAt(cwd, args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Pipeline Fixture', '-c', 'user.email=pipeline@example.test', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function seedBare(root) {
  const bare = join(root, 'origin.git');
  gitAt(root, ['init', '--bare', '-b', 'main', bare]);
  gitAt(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const seed = join(root, 'seed');
  gitAt(root, ['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  mkdirSync(join(seed, 'src'));
  mkdirSync(join(seed, 'test'));
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'pipeline-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(seed, 'src', 'calculator.js'), 'export function add(a,b){ return a - b; }\n');
  writeFileSync(join(seed, 'test', 'smoke.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('fixture loads', () => assert.equal(1 + 1, 2));\n");
  gitAt(seed, ['add', '.']);
  gitAt(seed, ['commit', '-m', 'Seed fixture']);
  gitAt(seed, ['push', 'origin', 'HEAD']);
  return { bare, head: gitAt(seed, ['rev-parse', 'HEAD']) };
}

function seedBaseRepo(baseDir, bare) {
  mkdirSync(dirname(baseDir), { recursive: true, mode: 0o700 });
  gitAt(dirname(baseDir), ['clone', bare, baseDir]);
  gitAt(baseDir, ['remote', 'set-url', 'origin', githubUrl]);
  gitAt(baseDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
  return baseDir;
}

function traceEntries(tracePath, kind) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.kind === kind);
}

function makeRunner({ cwd, token, scenario, tracePath, errors, meta, chat, stopAfterCompleted }) {
  let completed = 0;
  const runner = createRunner({
    client: createClient({ serverUrl: base, token: token.plaintext }),
    log: createLogger(false, 'info', { write: (chunk) => {
      const event = JSON.parse(chunk);
      if (event.level === 'error') errors.push(event);
      if (stopAfterCompleted && event.event === 'claim_reported' && event.status === 'completed' && ++completed === stopAfterCompleted) {
        void runner.shutdown();
      }
    } }),
    cwd,
    childEnvironment: { PATH: process.env.PATH },
    runnerToken: token.plaintext,
    meta,
    acpCommand: process.execPath,
    acpArgs: [fakeAgent, '--scenario', scenario, '--trace', tracePath],
    heartbeatIntervalMs: 1000,
    commandPollMs: 25,
    eventFlushMs: 10,
    executionTimeoutMs: 20000,
    ...(chat ? { chat } : {}),
  });
  return runner;
}

async function claimStatus(claimId) {
  return (await db.getPool().query('SELECT status,end_reason FROM agent_claims WHERE id=$1', [claimId])).rows[0];
}

async function commandRow(commandId) {
  return (await db.getPool().query('SELECT status,result FROM agent_claim_commands WHERE id=$1', [commandId])).rows[0];
}

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await db.runMigrations();
  const ownerUserId = await seedUser(databaseUrl, { githubId: 9973, login: 'pipeline-owner' });
  await seedOrgMembership(databaseUrl, ownerUserId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId: ownerUserId, displayName: 'Pipeline Owner', email: 'pipeline-owner@example.test' });
  owner = { id: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor: asActor(owner), orgId, name: 'Pipeline', idempotencyKey: 'pipeline-workspace' });
  projectId = (await db.createCollabProject({ actor: asActor(owner), workspaceId: workspace.id, name: 'Pipeline Project' })).id;
  await db.getPool().query(`INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $1, 'github')`, [repo, orgId]);
  const installation = (await db.getPool().query(
    `INSERT INTO provider_installations (org_id, provider, external_installation_id, account_login, account_type)
      VALUES ($1, 'github', $2, 'acme', 'Organization') RETURNING id`,
    [orgId, 9100500],
  )).rows[0];
  await db.getPool().query('UPDATE repos SET installation_id=$1 WHERE id=$2', [installation.id, repo]);
  await db.createAgent({ id: chatAgentId, orgId, agentType: 'claude', transport: 'long_poll', repos: [repo] });
  await db.createAgent({ id: workAgentId, orgId, agentType: 'claude', transport: 'long_poll', repos: [repo] });
  await listen();
}, 30000);

afterAll(async () => {
  if (server) await stop(server);
  await db.closePool();
  for (const [name, value] of [['FF_COLLAB_AUTH_SECRET', previousSecrets.auth], ['FF_GITHUB_APP_WEBHOOK_SECRET', previousSecrets.webhook]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('chat handoff to native build review pipeline', () => {
  it('runs attended design through real red-green verification and correctly parented rereview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-runner-native-pipeline-'));
    cleanupRoots.push(root);
    const chatWorkDir = join(root, 'chat');
    const buildWorkDir = join(root, 'build');
    mkdirSync(chatWorkDir);
    mkdirSync(buildWorkDir);
    const bare = seedBare(root);
    github.origin = bare.bare;
    const chatBaseDir = join(root, 'chat-chat', 'repos', ...repo.split('/'));
    seedBaseRepo(chatBaseDir, bare.bare);
    seedBaseRepo(join(buildWorkDir, '.fluent-flow', 'repos', ...repo.split('/')), bare.bare);


    const profile = { id: 'design', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['small', 'large'], defaultModel: 'small' };
    const chatToken = await db.createToken({ orgId, agentId: chatAgentId, label: 'pipeline-chat-runner' });
    const workToken = await db.createToken({ orgId, agentId: workAgentId, label: 'pipeline-work-runner' });
    const chatTracePath = join(root, 'chat-trace.jsonl');
    const workTracePath = join(root, 'work-trace.jsonl');
    const chatErrors = [];
    const workErrors = [];
    const reviewErrors = [];
    const verificationErrors = [];
    const reviewTracePath = join(root, 'review-trace.jsonl');
    const verificationTracePath = join(root, 'verification-trace.jsonl');
    let reviewer;
    let runningReviewer;
    let verifier;
    let runningVerifier;
    const chatRunner = makeRunner({
      cwd: chatWorkDir, token: chatToken, scenario: 'pipeline-handoff', tracePath: chatTracePath, errors: chatErrors,
      meta: { instance_id: 'pipeline-chat', slot_id: 0, capacity: 2 },
      chat: { enabled: true, profiles: [profile] },
    });
    const workRunner = makeRunner({
      cwd: buildWorkDir, token: workToken, scenario: 'normal', tracePath: workTracePath, errors: workErrors,
      meta: { instance_id: 'pipeline-work', slot_id: 0, capacity: 1 }, stopAfterCompleted: 2,
    });
    const runningChat = chatRunner.start();
    const runningWork = workRunner.start();
    try {
      const task = await db.createCollabTask({ actor: asActor(owner), projectId, title: 'Pipeline joined acceptance' });
      const started = await db.startCollabClaimExecution({
        actor: asActor(owner), taskId: task.id, expectedVersion: task.version,
        idempotencyKey: `pipeline-chat-${randomUUID()}`, repo, claimType: 'chat',
      });
      const chatClaimId = started.claim.id;
      await until(async () => {
        expect(chatErrors).toEqual([]);
        return (await claimStatus(chatClaimId))?.status === 'claimed';
      }, 20000);

      const prompt = await collabRequest('POST', `/claim-executions/${chatClaimId}/commands`, {
        kind: 'prompt', payload: { text: 'Draft the accepted design document, commit it, and push the task branch to origin.' },
      }, randomUUID());
      expect([200, 202]).toContain(prompt.status);
      const promptCommandId = prompt.body.data.commandId;
      await until(async () => (await commandRow(promptCommandId))?.status === 'acked', 20000);
      const pushed = await until(async () => traceEntries(chatTracePath, 'pipeline_push').at(-1) ?? false, 20000);
      const taskBranch = `ff/task-${task.id}`;
      expect(pushed.branch).toBe(taskBranch);
      expect(pushed.headSha).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
      const headSha = pushed.headSha;

      const number = prNumber++;
      const repository = { id: 91002, node_id: 'R_pipeline_fixture', full_name: repo, owner: { login: orgId } };
      const pullRequest = {
        id: number + 100000, node_id: `PR_pipeline_${number}`, number, state: 'open', body: '', title: 'Pipeline build output',
        created_at: new Date().toISOString(), html_url: `https://github.com/${repo}/pull/${number}`,
        user: { login: 'pipeline-owner' }, base: { repo: repository, ref: 'main' }, head: { repo: repository, ref: taskBranch, sha: headSha },
      };
      github.prs.set(number, pullRequest);

      const handoff = await collabRequest('POST', `/claim-executions/${chatClaimId}/commands`, { kind: 'handoff', payload: {} }, randomUUID());
      expect([200, 202]).toContain(handoff.status);
      const handoffCommandId = handoff.body.data.commandId;
      let prepared = null;
      await until(async () => {
        const status = await collabRequest('GET', `/claim-executions/${chatClaimId}/handoffs/${handoffCommandId}`);
        if (status.status !== 200) return false;
        prepared = status.body.data;
        return prepared.status === 'acked' && prepared.prepared !== null;
      }, 20000);
      expect(prepared.prepared).toMatchObject({ branch: taskBranch, headSha });
      expect(prepared.prepared.digest).toMatchObject({ goal: 'Ship the accepted pipeline design', filesTouched: ['accepted-design.md'] });

      const currentTask = (await db.getCollabTask(asActor(owner), task.id)).task;
      const handoffStart = await collabRequest('POST', `/claim-executions/${chatClaimId}/handoffs/${handoffCommandId}`, {
        expectedVersion: currentTask.version,
      }, randomUUID());
      expect([200, 202]).toContain(handoffStart.status);
      expect(handoffStart.body.data).toMatchObject({ taskId: task.id, created: true });
      const specClaimId = handoffStart.body.data.claimId;

      let buildClaimId = null;
      await until(async () => {
        expect(workErrors).toEqual([]);
        const spec = await claimStatus(specClaimId);
        if (spec?.status !== 'completed') return false;
        const build = (await db.getPool().query(
          `SELECT claim.id,claim.status FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id
           WHERE execution.parent_claim_id=$1 AND claim.claim_type='build'`, [specClaimId])).rows[0];
        buildClaimId = build?.id ?? null;
        return Boolean(build) && build.status === 'completed';
      }, 45000);
      await workRunner.shutdown();
      await runningWork;

      const linkRow = (await db.getPool().query(
        'SELECT id,repo,pr_number,head_branch,head_sha,task_id,claim_id,root_claim_id,native_binding_id,producer_binding_id FROM collab_delivery_links WHERE task_id=$1',
        [task.id])).rows;
      expect(linkRow).toHaveLength(1);
      const originBinding = (await db.getPool().query(
        'SELECT token.id FROM collab_scoped_tokens token JOIN agent_claims claim ON claim.id=token.claim_id AND claim.claimed_at=token.claimed_at AND claim.session_id=token.runner_session_id WHERE claim.id=$1',
        [buildClaimId])).rows[0].id;
      expect(linkRow[0]).toMatchObject({
        repo, pr_number: number, head_branch: taskBranch, head_sha: headSha,
        task_id: task.id, claim_id: String(buildClaimId), root_claim_id: chatClaimId,
        native_binding_id: originBinding, producer_binding_id: originBinding,
      });
      const roots = (await db.getPool().query(
        'SELECT root_claim_id,delivery_link_id,producer_claim_id FROM collab_pull_request_roots WHERE delivery_link_id=$1',
        [linkRow[0].id])).rows;
      expect(roots).toEqual([{ root_claim_id: chatClaimId, delivery_link_id: linkRow[0].id, producer_claim_id: buildClaimId }]);

      const buildWorktree = join(buildWorkDir, '.fluent-flow', 'repos', ...repo.split('/'), '.worktrees', `claim-${buildClaimId}`);
      const specWorktree = join(buildWorkDir, '.fluent-flow', 'repos', ...repo.split('/'), '.worktrees', `claim-${specClaimId}`);
      expect(existsSync(buildWorktree)).toBe(false);
      expect(existsSync(specWorktree)).toBe(false);
      const buildBinding = linkRow[0].native_binding_id;
      const buildProof = (await db.getPool().query(
        'SELECT state,dirty,final,head_commit,task_branch,task_branch_head,repository FROM collab_claim_workspace_state WHERE reporting_binding_id=$1',
        [buildBinding])).rows[0];
      expect(buildProof).toMatchObject({
        state: 'known', dirty: false, final: true, head_commit: headSha,
        task_branch: taskBranch, task_branch_head: headSha, repository: repo,
      });
      const endSession = await collabRequest('POST', `/claim-executions/${chatClaimId}/commands`, { kind: 'end_session', payload: {} }, randomUUID());
      expect([200, 202]).toContain(endSession.status);
      await until(async () => (await claimStatus(chatClaimId))?.status === 'cancelled', 20000);
      expect(await claimStatus(chatClaimId)).toMatchObject({ status: 'cancelled', end_reason: 'user' });
      await chatRunner.shutdown();
      await runningChat;

      expect(await signedWebhook('pull_request', { action: 'opened', pull_request: pullRequest })).toBe(200);
      const checkRun = { id: 400000 + number, name: 'pipeline-ci', status: 'completed', conclusion: 'success', head_sha: headSha, app: { slug: 'github-actions' } };
      github.checks.set(checkRun.id, checkRun);
      expect(await signedWebhook('check_run', { action: 'completed', check_run: checkRun })).toBe(200);
      let reviewClaimId = null;
      await until(async () => {
        const review = (await db.getPool().query(
          "SELECT id,status,head_sha FROM agent_claims WHERE org_id=$1 AND repo=$2 AND pr_number=$3 AND claim_type='review'",
          [orgId, repo, number])).rows[0];
        reviewClaimId = review?.id ?? null;
        return Boolean(review);
      }, 20000);
      expect((await claimStatus(reviewClaimId)).status).toBe('pending');
      expect((await db.getPool().query('SELECT head_sha FROM agent_claims WHERE id=$1', [reviewClaimId])).rows[0].head_sha).toBe(headSha);

      const lineage = (await db.getPool().query(
        `SELECT claim_id,parent_claim_id,root_claim_id,task_id,delivery_link_id,created_by_principal_id,created_by_session_version
         FROM collab_claim_executions WHERE claim_id = ANY($1)`,
        [[chatClaimId, specClaimId, buildClaimId, reviewClaimId]])).rows;
      const rowFor = (claimId) => lineage.find((row) => row.claim_id === claimId);
      expect(rowFor(chatClaimId)).toMatchObject({ parent_claim_id: null, root_claim_id: chatClaimId, task_id: task.id, created_by_principal_id: owner.id, created_by_session_version: owner.sessionVersion });
      expect(rowFor(specClaimId)).toMatchObject({ parent_claim_id: chatClaimId, root_claim_id: chatClaimId, task_id: task.id, created_by_principal_id: owner.id, created_by_session_version: owner.sessionVersion });
      expect(rowFor(buildClaimId)).toMatchObject({ parent_claim_id: specClaimId, root_claim_id: chatClaimId, task_id: task.id, created_by_principal_id: owner.id, created_by_session_version: owner.sessionVersion });
      expect(rowFor(reviewClaimId)).toMatchObject({
        parent_claim_id: buildClaimId, root_claim_id: chatClaimId, task_id: task.id,
        delivery_link_id: linkRow[0].id, created_by_principal_id: owner.id, created_by_session_version: owner.sessionVersion,
      });

      reviewer = makeRunner({
        cwd: buildWorkDir, token: workToken, scenario: 'native-pipeline', tracePath: reviewTracePath, errors: reviewErrors,
        meta: { instance_id: 'pipeline-review', slot_id: 0, capacity: 1 }, stopAfterCompleted: 1,
      });
      runningReviewer = reviewer.start();
      await until(async () => {
        expect(reviewErrors).toEqual([]);
        return (await claimStatus(reviewClaimId))?.status === 'completed';
      }, 20000);
      await reviewer.shutdown();
      await runningReviewer;
      const marker = traceEntries(reviewTracePath, 'review_marker').at(-1).marker;
      expect(marker.status).toBe('FAIL');
      expect(await signedWebhook('pull_request_review', {
        action: 'submitted', pull_request: pullRequest,
        review: { id: 700000 + number, node_id: `PRR_pipeline_${number}`, state: 'commented', commit_id: headSha, body: `<!-- reviewer-result: ${JSON.stringify(marker)} -->` },
      })).toBe(200);
      const redClaim = await until(async () => (await db.getPool().query(
        "SELECT claim.id FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE execution.parent_claim_id=$1 AND claim.claim_type='verify' AND claim.payload->>'phase'='red'",
        [reviewClaimId])).rows[0], 20000);
      const redClaimId = redClaim.id;
      verifier = makeRunner({
        cwd: buildWorkDir, token: workToken, scenario: 'native-pipeline', tracePath: verificationTracePath, errors: verificationErrors,
        meta: { instance_id: 'pipeline-verification', slot_id: 0, capacity: 1 }, stopAfterCompleted: 3,
      });
      runningVerifier = verifier.start();
      let fixClaimId;
      await until(async () => {
        expect(verificationErrors).toEqual([]);
        const fix = (await db.getPool().query(
          "SELECT claim.id,claim.status FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE execution.parent_claim_id=$1 AND claim.claim_type='review_fix'",
          [redClaimId])).rows[0];
        fixClaimId = fix?.id;
        return fix?.status === 'completed';
      }, 30000);
      const red = await db.getVerificationResultByClaim(orgId, redClaimId);
      expect(red).toMatchObject({ phase: 'red', outcome: 'PASS', redBaseSha: headSha });
      expect(red.matrix.requirements[0].red.outcomes[0].status).toBe('assertion-fail');
      expect(gitAt(bare.bare, ['rev-parse', `${red.artifactSha}^`])).toBe(headSha);
      const hashes = Object.fromEntries(red.testHashes.map(({ path, sha256 }) => [path, sha256]));
      for (const path of ['package.json', 'test/calculator-add.test.js']) {
        const bytes = execFileSync('git', ['--git-dir', bare.bare, 'show', `${red.artifactSha}:${path}`]);
        expect(hashes[path]).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      const fixedHead = gitAt(bare.bare, ['rev-parse', `refs/heads/${taskBranch}`]);
      expect(gitAt(bare.bare, ['rev-parse', `${fixedHead}^`])).toBe(red.artifactSha);
      expect(gitAt(bare.bare, ['diff', '--name-only', red.artifactSha, fixedHead])).toBe('src/calculator.js');
      const delivery = (await db.getPool().query(
        'SELECT link.head_sha,token.claim_id FROM collab_delivery_links link JOIN collab_scoped_tokens token ON token.id=link.producer_binding_id WHERE link.id=$1',
        [linkRow[0].id])).rows[0];
      expect(delivery).toEqual({ head_sha: fixedHead, claim_id: fixClaimId });
      const fixedCheck = { ...checkRun, id: checkRun.id + 1, head_sha: fixedHead };
      github.checks.set(fixedCheck.id, fixedCheck);
      expect(await signedWebhook('check_run', { action: 'completed', check_run: fixedCheck })).toBe(200);
      let greenClaimId;
      await until(async () => {
        expect(verificationErrors).toEqual([]);
        const green = (await db.getPool().query(
          "SELECT claim.id,claim.status FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE execution.parent_claim_id=$1 AND claim.claim_type='verify' AND claim.payload->>'phase'='green'",
          [fixClaimId])).rows[0];
        greenClaimId = green?.id;
        return green?.status === 'completed';
      }, 30000);
      await verifier.shutdown();
      await runningVerifier;
      const green = await db.getVerificationResultByClaim(orgId, greenClaimId);
      expect(green).toMatchObject({ phase: 'green', outcome: 'PASS', greenSha: fixedHead, redBaseSha: headSha });
      expect(green.matrix.requirements[0]).toMatchObject({ status: 'PASS', red: { status: 'PASS' } });
      expect(green.matrix.requirements[0].green.outcomes[0].status).toBe('pass');
      expect(traceEntries(verificationTracePath, 'process_start')).toHaveLength(2);
      const rereview = (await db.getPool().query(
        "SELECT claim.id,claim.status,claim.head_sha FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE execution.parent_claim_id=$1 AND claim.claim_type='review'",
        [greenClaimId])).rows[0];
      expect(rereview).toMatchObject({ status: 'pending', head_sha: fixedHead });
      const finalLineage = (await db.getPool().query(
        'SELECT claim_id,parent_claim_id,root_claim_id,task_id,delivery_link_id,created_by_principal_id,created_by_session_version FROM collab_claim_executions WHERE claim_id=ANY($1)',
        [[redClaimId, fixClaimId, greenClaimId, rereview.id]])).rows;
      for (const [child, parent] of [[redClaimId, reviewClaimId], [fixClaimId, redClaimId], [greenClaimId, fixClaimId], [rereview.id, greenClaimId]]) {
        expect(finalLineage.find((row) => row.claim_id === child)).toEqual({
          claim_id: child, parent_claim_id: parent, root_claim_id: chatClaimId, task_id: task.id,
          delivery_link_id: linkRow[0].id, created_by_principal_id: owner.id, created_by_session_version: owner.sessionVersion,
        });
      }
      expect(chatErrors).toEqual([]);
      expect(workErrors).toEqual([]);
      expect(reviewErrors).toEqual([]);
      expect(verificationErrors).toEqual([]);
    } finally {
      await chatRunner.shutdown();
      await runningChat;
      await workRunner.shutdown();
      await runningWork;
      if (reviewer) await reviewer.shutdown();
      if (runningReviewer) await runningReviewer;
      if (verifier) await verifier.shutdown();
      if (runningVerifier) await runningVerifier;
    }
  }, 90000);
});
