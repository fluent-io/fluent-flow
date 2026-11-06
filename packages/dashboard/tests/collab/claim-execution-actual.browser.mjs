import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.FF_CLAIM_EXECUTION_DATABASE_URL;
if (!databaseUrl) throw new Error('FF_CLAIM_EXECUTION_DATABASE_URL is required');
if (process.env.FF_COLLAB_TEST_DB_OPTIN !== '1') throw new Error('FF_COLLAB_TEST_DB_OPTIN=1 is required');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) || databaseUrl.includes('?') || databaseUrl.includes('#')) {
  throw new Error('claim-execution actual browser requires postgres:// or postgresql:// without query parameters or fragments');
}
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!/^ff_[a-z0-9_]+_test$/.test(databaseName) || /(^|_)(demo|prod|production)(_|$)/.test(databaseName)) {
  throw new Error('claim-execution actual browser requires a dedicated ff_*_test database');
}
const authSecret = process.env.FF_COLLAB_AUTH_SECRET;
if (!authSecret || authSecret.length < 32) throw new Error('FF_COLLAB_AUTH_SECRET (same value as the dashboard) is required');

const { assertDedicatedCollabTestDatabaseUrl, resetCollabSchema } = await import('../../../db/tests/helpers/collab-db.ts');
assertDedicatedCollabTestDatabaseUrl(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL ??= 'warn';
const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3194';
const apiPort = Number(process.env.FF_CLAIM_EXECUTION_API_PORT ?? 3195);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const screenshots = process.env.FF_CLAIM_EXECUTION_SCREENSHOT_DIR;
const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
const runnerCli = fileURLToPath(new URL('../../../fluent-flow-runner/bin/fluent-flow-runner.js', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../../../fluent-flow-runner/tests/unit/fake-acp-agent.js', import.meta.url));
const runnerCwd = mkdtempSync(join(tmpdir(), 'ff-claim-browser-'));
const followUpMarker = join(runnerCwd, '.claim-browser-follow-up-queued');
const runnerStderrLimitBytes = 16 * 1024;

let db;
let server;
let runner;
let runnerExit;
let runnerSpawnError;
let runnerStderr = Buffer.alloc(0);
let browser;
let context;
let page;
const pageErrors = [];
const badCollab = [];
const results = {};
const diagnosticSecrets = new Set([authSecret, databaseUrl]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runBounded(label, operation, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopRunner() {
  if (!runner || runnerSpawnError || runner.exitCode !== null || runner.signalCode !== null) return;
  runner.kill('SIGTERM');
  const stopped = await Promise.race([runnerExit.then(() => true), wait(10_000).then(() => false)]);
  if (stopped || runner.exitCode !== null || runner.signalCode !== null) return;
  runner.kill('SIGKILL');
  const killed = await Promise.race([runnerExit.then(() => true), wait(5_000).then(() => false)]);
  if (!killed) throw new Error('Timed out stopping runner process');
}

async function shot(name) {
  if (!screenshots || !page || page.isClosed()) return;
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

function appendRunnerStderr(chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes.length >= runnerStderrLimitBytes) {
    runnerStderr = Buffer.from(bytes.subarray(bytes.length - runnerStderrLimitBytes));
    return;
  }
  const excess = runnerStderr.length + bytes.length - runnerStderrLimitBytes;
  const previous = excess > 0 ? runnerStderr.subarray(excess) : runnerStderr;
  runnerStderr = Buffer.concat([previous, bytes]);
}

function redactDiagnostic(value) {
  let redacted = String(value ?? '');
  for (const secret of diagnosticSecrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join('[REDACTED]');
  }
  return redacted
    .replace(/(--token(?:=|\s+))\S+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[REDACTED]');
}

function redactError(error) {
  if (!(error instanceof Error)) return new Error(redactDiagnostic(error));
  error.message = redactDiagnostic(error.message);
  if (typeof error.stack === 'string') error.stack = redactDiagnostic(error.stack);
  return error;
}

async function captureFailureScreenshot() {
  if (!screenshots || !page || page.isClosed()) return {};
  try {
    await runBounded('capturing failure screenshot', () => shot('failure'));
    return { file: 'failure.png' };
  } catch (error) {
    return { error: redactDiagnostic(error instanceof Error ? error.message : error) };
  }
}

function reportFailure(error, screenshot) {
  const stderr = redactDiagnostic(runnerStderr.toString('utf8').trim());
  console.error(JSON.stringify({
    result: 'FAIL',
    message: redactDiagnostic(error instanceof Error ? error.message : error),
    ...(screenshot?.file ? { failureScreenshot: screenshot.file } : {}),
    ...(screenshot?.error ? { failureScreenshotError: screenshot.error } : {}),
    ...(stderr ? { runnerStderr: stderr } : {}),
  }));
}

async function closeServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      let error = new Error('Timed out closing API server');
      try {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      } catch (closeError) {
        error = closeError;
      }
      finish(error);
    }, 5_000);
    try {
      server.close((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

async function cleanupAll() {
  let failed = false;
  let firstError;
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  };
  await attempt(async () => {
    if (context) await runBounded('closing browser context', () => context.close());
  });
  await attempt(async () => {
    if (browser) await runBounded('closing browser', () => browser.close());
  });
  await attempt(stopRunner);
  await attempt(closeServer);
  await attempt(async () => {
    if (db) await runBounded('closing database pool', () => db.closePool());
  });
  await attempt(async () => {
    rmSync(runnerCwd, { recursive: true, force: true });
  });
  return { failed, error: firstError };
}

let hasOriginalError = false;
let originalError;
let failureScreenshot;
let cleanupFailure;

try {
  await resetCollabSchema(databaseUrl);
  db = await import('@fluent-flow/db');
  const { createApp } = await import('../../../fluent-flow/src/app.js');
  const { chromium, expect } = await import('@playwright/test');
  await db.runMigrations();

  const orgId = 'claim-browser-org';
  const repo = 'fixture/claim-browser';
  const agentId = 'claim-browser-runner';
  const owner = {
    email: 'claim-browser-owner+pw@example.test',
    login: 'claim-browser-owner',
    password: `owner-${randomBytes(16).toString('hex')}`,
  };
  diagnosticSecrets.add(owner.password);
  const pool = db.getPool();
  await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [orgId, 'Claim Browser Org']);
  const { rows: [legacyUser] } = await pool.query(
    `INSERT INTO users (github_id, login, email, avatar_url)
     VALUES ($1, $2, $3, NULL) RETURNING id`,
    [737373, owner.login, 'claim-browser-owner@example.test'],
  );
  await pool.query('INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, $2, $3)', [legacyUser.id, orgId, 'admin']);
  const principal = await db.ensureGithubPrincipal({ legacyUserId: legacyUser.id, displayName: 'Claim browser owner', email: owner.email });
  await pool.query('INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)', [principal.id, await db.hashPassword(owner.password)]);
  const actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Claim Browser Client', idempotencyKey: 'claim-browser-workspace' });
  const project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Claim Browser Project' });
  const task = await db.createCollabTask({ actor, projectId: project.id, title: 'Deterministic ACP claim task', description: 'Disposable actual-browser acceptance task.' });
  await pool.query(`INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`, [randomUUID(), orgId, repo]);
  await db.createAgent({ id: agentId, orgId, agentType: 'test-acp', transport: 'long_poll', transportMeta: {}, repos: [repo] });
  const token = await db.createToken({ orgId, agentId, label: 'actual-browser', expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  diagnosticSecrets.add(token.plaintext);

  process.env.FF_COLLAB_AUTH_SECRET = authSecret;
  server = createApp().listen(apiPort, '127.0.0.1');
  const runnerEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  runnerEnv.FAKE_ACP_SCENARIO = 'claim-browser-uat';
  runnerEnv.LOG_LEVEL = 'warn';

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  runner = spawn(process.execPath, [
    runnerCli,
    '--server', apiOrigin,
    '--token', token.plaintext,
    '--acp-command', process.execPath,
    '--acp-arg', fakeAgent,
    '--cwd', runnerCwd,
  ], {
    cwd: runnerCwd,
    env: runnerEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  runner.stderr.on('data', appendRunnerStderr);
  runnerExit = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    runner.once('error', (error) => {
      runnerSpawnError = error;
      finish({ error });
    });
    runner.once('exit', (code, signal) => finish({ code, signal }));
  });
  await waitFor('runner session registration', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM agent_sessions
       WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()`,
      [orgId, agentId],
    );
    if (rows[0]) return rows[0];
    if (runnerSpawnError) {
      const detail = runnerSpawnError.code ?? runnerSpawnError.message ?? 'unknown error';
      throw new Error(`Runner failed to start: ${redactDiagnostic(detail)}`);
    }
    if (runner.exitCode !== null || runner.signalCode !== null) throw new Error('Runner exited before registering');
    return null;
  });

  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/collab/v1') && response.status() >= 400) {
      badCollab.push(`${response.request().method()} ${path} ${response.status()}`);
    }
  });

  const taskUrl = `${origin}/tasks/${task.id}`;
  await page.goto(`${origin}/login?callbackUrl=${encodeURIComponent(`/tasks/${task.id}`)}`);
  await page.getByPlaceholder('Email', { exact: true }).fill(owner.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(taskUrl, { timeout: 30_000 });
  await page.getByText(task.title, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Execution', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Start execution', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start execution', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start execution', exact: true });
  await start.getByLabel('Phase', { exact: true }).selectOption('spec');
  await start.getByLabel('Repository', { exact: true }).fill(repo);
  await start.getByLabel('Instructions', { exact: true }).fill('Exercise deterministic ACP browser acceptance.');
  const startResponse = page.waitForResponse((response) => response.url().includes(`/api/collab/v1/tasks/${task.id}/claim-executions`) && response.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  assert.equal((await startResponse).status(), 202);

  const detail = page.getByRole('region', { name: 'Execution detail', exact: true });
  await expect(detail.getByText('Deterministic claim execution started.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByText('Inspect deterministic fixture', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText('Wait for operator approval', { exact: true })).toBeVisible();
  await expect(detail.getByText('Allow deterministic UAT action?', { exact: true })).toBeVisible({ timeout: 30_000 });
  await shot('01-streaming-permission');

  const answerResponse = page.waitForResponse((response) => response.url().includes('/api/collab/v1/claim-executions/') && response.url().endsWith('/commands') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Allow once', exact: true }).click();
  assert.ok([200, 202].includes((await answerResponse).status()));
  await expect(detail.getByText('Resolved', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText('Permission accepted.', { exact: false })).toBeVisible({ timeout: 10_000 });
  await shot('02-permission-answered');

  await detail.getByLabel('Prompt', { exact: true }).fill('Continue with the deterministic follow-up and wait.');
  const promptResponse = page.waitForResponse((response) => response.url().includes('/api/collab/v1/claim-executions/') && response.url().endsWith('/commands') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Send prompt', exact: true }).click();
  assert.ok([200, 202].includes((await promptResponse).status()));
  writeFileSync(followUpMarker, '', { flag: 'wx', mode: 0o600 });
  await expect(detail.getByText('Follow-up ACP turn is running.', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByText(task.title, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  const refreshedDetail = page.getByRole('region', { name: 'Execution detail', exact: true });
  await expect(refreshedDetail.getByText('Deterministic claim execution started.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(refreshedDetail.getByText('Follow-up ACP turn is running.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(refreshedDetail.getByText('Allow deterministic UAT action?', { exact: true })).toBeVisible();
  await expect(refreshedDetail.getByText('Resolved', { exact: true })).toBeVisible();
  await shot('03-refreshed-history');

  const cancelResponse = page.waitForResponse((response) => response.url().includes('/api/collab/v1/claim-executions/') && response.url().endsWith('/commands') && response.request().method() === 'POST');
  await refreshedDetail.getByRole('button', { name: 'Cancel execution', exact: true }).click();
  assert.ok([200, 202].includes((await cancelResponse).status()));
  await expect(refreshedDetail.locator('[data-claim-status]')).toHaveText('Cancelled', { timeout: 30_000 });
  await shot('04-cancelled');

  const { rows: claims } = await pool.query(
    `SELECT claim.id, claim.org_id, claim.repo, claim.pr_number, claim.attempt,
            claim.claim_type, claim.status, claim.session_id, session.agent_id
     FROM agent_claims claim
     JOIN agent_sessions session ON session.id = claim.session_id
     WHERE claim.org_id = $1 AND claim.repo = $2
     ORDER BY claim.id`,
    [orgId, repo],
  );
  assert.equal(claims.length, 1);
  assert.deepEqual(
    {
      orgId: claims[0].org_id,
      repo: claims[0].repo,
      prNumber: claims[0].pr_number,
      attempt: claims[0].attempt,
      claimType: claims[0].claim_type,
      status: claims[0].status,
      agentId: claims[0].agent_id,
    },
    { orgId, repo, prNumber: null, attempt: 1, claimType: 'spec', status: 'cancelled', agentId },
  );
  const claimId = claims[0].id;
  const { rows: eventSummary } = await pool.query(
    `SELECT COUNT(*)::integer AS count,
            COUNT(DISTINCT seq)::integer AS distinct_sequences,
            ARRAY_AGG(DISTINCT kind ORDER BY kind) AS kinds
     FROM agent_claim_events WHERE org_id = $1 AND claim_id = $2`,
    [orgId, claimId],
  );
  assert.ok(eventSummary[0].count >= 10);
  assert.equal(eventSummary[0].distinct_sequences, eventSummary[0].count);
  for (const kind of ['agent_message', 'plan', 'state', 'tool_call']) assert.ok(eventSummary[0].kinds.includes(kind), `missing ${kind} event`);

  const { rows: requests } = await pool.query(
    `SELECT kind, status, response IS NOT NULL AS has_response
     FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2 ORDER BY created_at, request_key`,
    [orgId, claimId],
  );
  assert.deepEqual(requests, [{ kind: 'permission', status: 'resolved', has_response: true }]);

  const { rows: commands } = await pool.query(
    `SELECT kind, status, result IS NOT NULL AS has_result
     FROM agent_claim_commands WHERE org_id = $1 AND claim_id = $2 ORDER BY id`,
    [orgId, claimId],
  );
  assert.deepEqual(commands.map(({ kind }) => kind), ['permission', 'prompt', 'cancel']);
  assert.deepEqual(commands.map(({ status }) => status), ['acked', 'acked', 'acked']);
  assert.ok(commands.every(({ has_result }) => has_result));

  const { rows: links } = await pool.query(
    `SELECT task_id, project_id, claim_id, root_claim_id
     FROM collab_claim_executions WHERE claim_id = $1`,
    [claimId],
  );
  assert.deepEqual(links, [{ task_id: task.id, project_id: project.id, claim_id: claimId, root_claim_id: claimId }]);
  const { rows: agentRows } = await pool.query('SELECT agent_type FROM agents WHERE org_id = $1 AND id = $2', [orgId, agentId]);
  assert.deepEqual(agentRows, [{ agent_type: 'test-acp' }]);

  results.flow = ['task selected', 'spec claim started', 'message tool and plan streamed', 'permission answered', 'follow-up prompted', 'history refreshed', 'foreground cancelled'];
  results.database = {
    claims: claims.length,
    events: eventSummary[0].count,
    eventKinds: eventSummary[0].kinds,
    requests: requests.length,
    commands: commands.map(({ kind, status }) => ({ kind, status })),
    links: links.length,
  };
  results.pageErrors = pageErrors;
  results.badCollabResponses = badCollab;
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(badCollab, []);
} catch (error) {
  hasOriginalError = true;
  originalError = redactError(error);
  failureScreenshot = await captureFailureScreenshot();
} finally {
  cleanupFailure = await cleanupAll();
}

if (hasOriginalError) {
  reportFailure(originalError, failureScreenshot);
  throw originalError;
}
if (cleanupFailure.failed) {
  const cleanupError = redactError(cleanupFailure.error);
  reportFailure(cleanupError);
  throw cleanupError;
}

console.log(JSON.stringify(results, null, 2));
console.log('claim execution actual browser: PASS');
process.exit(0);
