import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const github = vi.hoisted(() => ({ prs: new Map() }));
vi.mock('../../../fluent-flow/src/providers/github/rest.js', async () => {
  const actual = await vi.importActual('../../../fluent-flow/src/providers/github/rest.js');
  return { ...actual,
    getPR: async (_owner, _name, number) => {
      const pullRequest = github.prs.get(number);
      if (!pullRequest) throw new Error('Fixture pull request does not exist');
      return structuredClone(pullRequest);
    },
    findPullRequestsByHead: async (_owner, _name, branch) => [...github.prs.values()]
      .filter((pullRequest) => pullRequest.head.ref === branch && pullRequest.state === 'open')
      .map((pullRequest) => structuredClone(pullRequest)),
  };
});

const databaseUrl = process.env.COLLAB_REPORTING_MCP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_REPORTING_MCP_TEST_DATABASE_URL must name a dedicated loopback ff_reporting_mcp_* database.');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname) || !/^\/ff_reporting_mcp_[a-z0-9_]+$/.test(parsedDatabaseUrl.pathname)) {
  throw new Error('Unsafe reporting MCP integration database.');
}
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'runner-native-pr-secret-0123456789abcdef0123456789abcdef';

const { resetCollabSchema, seedUser, seedOrgMembership } = await import('../../../fluent-flow/tests/helpers/collab-db.js');
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { createRunner } = await import('../../src/runner.js');
const { createClient } = await import('../../src/client.js');
const { createLogger } = await import('../../src/logger.js');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const orgId = 'runner-native-pr-org';
const repo = 'acme/runner-native-pr';
const agentId = 'runner-native-pr-agent';

let server;
let base;
let owner;
let projectId;
let prNumber = 7600;

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

async function agentRequest(token, path, body) {
  const response = await fetch(`${base}/api/agent-server${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function until(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for runner native PR state');
}

async function buildWork(label) {
  const task = await db.createCollabTask({ actor: asActor(owner), projectId, title: label });
  const branch = `ff/task-${task.id}`;
  const started = await db.startCollabClaimExecution({
    actor: asActor(owner),
    taskId: task.id,
    expectedVersion: task.version,
    idempotencyKey: `runner-native-pr-${randomUUID()}`,
    repo,
    claimType: 'spec',
    instructions: 'Chain to build.',
  });
  const token = await db.createToken({ orgId, agentId, label: `${label} spec completion` });
  const registered = await agentRequest(token.plaintext, '/register', {
    meta: { instance_id: 'runner-native-pr-spec', slot_id: 1, capacity: 4, supported_claim_types: ['spec'] },
  });
  expect(registered.status).toBe(200);
  const sessionId = registered.body.session_id;
  const spec = (await agentRequest(token.plaintext, '/poll', { session_id: sessionId })).body.work;
  expect(spec.claim_id).toBe(started.claim.id);
  const completed = await agentRequest(token.plaintext, '/claim', {
    session_id: sessionId, claim_id: spec.claim_id, repo, pr_number: null, attempt: spec.attempt, status: 'completed',
  });
  expect(completed.status).toBe(200);
  return { taskId: task.id, branch };
}

function gitAt(cwd, args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Runner Native PR Fixture', '-c', 'user.email=runner-native-pr@example.test', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function seedOrigin(root, branch) {
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  gitAt(root, ['init', '--bare', origin]);
  gitAt(root, ['clone', origin, seed]);
  writeFileSync(join(seed, 'app.txt'), 'seed content\n');
  gitAt(seed, ['add', 'app.txt']);
  gitAt(seed, ['commit', '-m', 'Seed fixture']);
  gitAt(seed, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  gitAt(origin, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  return { origin, head: gitAt(seed, ['rev-parse', 'HEAD']) };
}

function seedBase(workDir, origin) {
  const baseDir = join(workDir, '.fluent-flow', 'repos', ...repo.split('/'));
  mkdirSync(dirname(baseDir), { recursive: true });
  gitAt(workDir, ['clone', origin, baseDir]);
  gitAt(baseDir, ['config', `url.${origin}.insteadOf`, `https://github.com/${repo}.git`]);
  return baseDir;
}

function pullRequestFixture({ number, branch, sha }) {
  const repository = { id: 9002, node_id: 'R_runner_native_pr_fixture', full_name: repo, owner: { login: orgId } };
  return {
    id: number + 100000,
    node_id: `PR_runner_native_pr_${number}`,
    number,
    state: 'open',
    body: '',
    title: 'Runner native build output',
    created_at: new Date().toISOString(),
    html_url: `https://github.com/${repo}/pull/${number}`,
    user: { login: 'runner-native-pr-owner' },
    base: { repo: repository, ref: 'main' },
    head: { repo: repository, ref: branch, sha },
  };
}

async function startRunner({ workDir, tracePath, errors }) {
  const token = await db.createToken({ orgId, agentId, label: `runner-${randomUUID()}` });
  const runner = createRunner({
    client: createClient({ serverUrl: base, token: token.plaintext }),
    log: createLogger(false, 'error', { write: (chunk) => errors.push(JSON.parse(chunk)) }),
    cwd: workDir,
    childEnvironment: { PATH: process.env.PATH },
    runnerToken: token.plaintext,
    meta: { instance_id: 'runner-native-pr', slot_id: 0, capacity: 1, supported_claim_types: ['spec', 'build'] },
    acpCommand: process.execPath,
    acpArgs: [fakeAgent, '--scenario', 'normal', '--trace', tracePath],
    heartbeatIntervalMs: 1000,
    commandPollMs: 25,
    eventFlushMs: 10,
    executionTimeoutMs: 20000,
  });
  return { runner, running: runner.start() };
}

async function buildClaimRow(taskId) {
  return (await db.getPool().query(`SELECT claim.id,claim.attempt,claim.status FROM agent_claims claim
    JOIN collab_claim_executions execution ON execution.claim_id=claim.id
    WHERE execution.task_id=$1 AND claim.claim_type='build' ORDER BY claim.id LIMIT 1`, [taskId])).rows[0];
}

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await db.runMigrations();
  const ownerUserId = await seedUser(databaseUrl, { githubId: 9972, login: 'runner-native-pr-owner' });
  await seedOrgMembership(databaseUrl, ownerUserId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId: ownerUserId, displayName: 'Runner Native PR Owner', email: 'runner-native-pr-owner@example.test' });
  owner = { id: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor: asActor(owner), orgId, name: 'Runner Native PR', idempotencyKey: 'runner-native-pr-workspace' });
  projectId = (await db.createCollabProject({ actor: asActor(owner), workspaceId: workspace.id, name: 'Runner Native PR Project' })).id;
  await db.getPool().query(`INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`, [randomUUID(), orgId, repo]);
  await db.createAgent({ id: agentId, orgId, agentType: 'claude', transport: 'long_poll', repos: [repo] });
  await listen();
}, 30000);

afterAll(async () => {
  if (server) await stop(server);
  await db.closePool();
});

describe('native build runner pull request binding', () => {
  it('binds the native pull request before worktree removal and completion', async () => {
    const work = await buildWork('Runner binds output PR');
    const number = prNumber++;
    const root = mkdtempSync(join(tmpdir(), 'ff-runner-native-pr-'));
    const workDir = join(root, 'work');
    mkdirSync(workDir);
    const origin = seedOrigin(root, work.branch);
    const baseDir = seedBase(workDir, origin.origin);
    github.prs.set(number, pullRequestFixture({ number, branch: work.branch, sha: origin.head }));
    const tracePath = join(root, 'runner-trace.jsonl');
    const errors = [];
    const { runner, running } = await startRunner({ workDir, tracePath, errors });
    try {
      await until(async () => {
        return (await buildClaimRow(work.taskId))?.status === 'completed' || errors.length > 0;
      }, 20000);
      await runner.shutdown();
      await running;
      const claim = await buildClaimRow(work.taskId);
      const links = (await db.getPool().query('SELECT repo,pr_number,head_branch,head_sha,claim_id,native_binding_id,producer_binding_id FROM collab_delivery_links WHERE task_id=$1', [work.taskId])).rows;
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        repo,
        pr_number: number,
        head_branch: work.branch,
        head_sha: origin.head,
        claim_id: String(claim.id),
        producer_binding_id: links[0].native_binding_id,
      });
      const state = (await db.getPool().query('SELECT state,dirty,final,head_commit,task_branch,task_branch_head,repository FROM collab_claim_workspace_state WHERE reporting_binding_id=$1', [links[0].native_binding_id])).rows[0];
      expect(state).toMatchObject({
        state: 'known',
        dirty: false,
        final: true,
        head_commit: origin.head,
        task_branch: work.branch,
        task_branch_head: origin.head,
        repository: repo,
      });
      expect(existsSync(join(baseDir, '.worktrees', `claim-${claim.id}`))).toBe(false);
      expect(claim.status).toBe('completed');
      expect(errors).toEqual([]);
    } finally {
      await runner.shutdown();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('fails the build instead of reporting success when no pull request covers the task branch', async () => {
    const work = await buildWork('Runner fails without PR');
    const root = mkdtempSync(join(tmpdir(), 'ff-runner-native-pr-'));
    const workDir = join(root, 'work');
    mkdirSync(workDir);
    const origin = seedOrigin(root, work.branch);
    seedBase(workDir, origin.origin);
    const tracePath = join(root, 'runner-trace.jsonl');
    const errors = [];
    const { runner, running } = await startRunner({ workDir, tracePath, errors });
    try {
      await until(async () => {
        const claim = await buildClaimRow(work.taskId);
        return Boolean(claim) && (claim.status === 'completed' || claim.status === 'failed' || errors.length > 0);
      }, 20000);
      await runner.shutdown();
      await running;
      const claim = await buildClaimRow(work.taskId);
      expect(claim.status, JSON.stringify(errors)).toBe('failed');
      const links = (await db.getPool().query('SELECT id FROM collab_delivery_links WHERE task_id=$1', [work.taskId])).rows;
      expect(links).toEqual([]);
      const state = (await db.getPool().query(`SELECT workspace.state,workspace.final,workspace.head_commit,workspace.task_branch_head
        FROM collab_claim_workspace_state workspace JOIN collab_scoped_tokens binding ON binding.id=workspace.reporting_binding_id
        WHERE binding.claim_id=$1`, [claim.id])).rows[0];
      expect(state, JSON.stringify(errors)).toMatchObject({
        state: 'known', final: true, head_commit: origin.head, task_branch_head: origin.head,
      });
    } finally {
      await runner.shutdown();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
