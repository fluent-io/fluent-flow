import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const runnerCli = fileURLToPath(new URL('../../../fluent-flow-agent-server/bin/fluent-flow-agent-server.js', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../../../fluent-flow-agent-server/tests/unit/fake-acp-agent.js', import.meta.url));
const runnerCwd = mkdtempSync(join(tmpdir(), 'ff-claim-browser-'));
const recoveredRunnerCwd = mkdtempSync(join(tmpdir(), 'ff-claim-browser-recovered-'));
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

async function noHorizontalOverflow() {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
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
    rmSync(recoveredRunnerCwd, { recursive: true, force: true });
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
  const principal = await db.ensureGithubPrincipal({ userId: legacyUser.id, displayName: 'Claim browser owner', email: owner.email });
  await pool.query('INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)', [principal.id, await db.hashPassword(owner.password)]);
  const actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Claim Browser Client', idempotencyKey: 'claim-browser-workspace' });
  const project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Claim Browser Project' });
  const task = await db.createCollabTask({ actor, projectId: project.id, title: 'Deterministic ACP claim task', description: 'Disposable actual-browser acceptance task.' });
  for(let index=0;index<24;index++)await db.createCollabTask({actor,projectId:project.id,title:`Deterministic supporting task ${index+1}`});
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
  writeFileSync(join(runnerCwd,'runner-token'),token.plaintext,{mode:0o600});
  runnerEnv.FLUENT_FLOW_TOKEN_FILE=join(runnerCwd,'runner-token');
  writeFileSync(join(runnerCwd,'chat-profiles.json'),JSON.stringify([{id:'design',permission:{configId:'approval',value:'ask'},models:['small','large'],modelConfigId:'model',defaultModel:'small'}]),{mode:0o600});

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const launchRunner = async (scenario, extraArgs=[]) => {
    const processCwd = scenario === 'accepted-loss-resume-running' ? recoveredRunnerCwd : runnerCwd;
    const { rows: [priorSession] } = await pool.query(
      'SELECT COALESCE(MAX(id), 0)::integer AS id FROM agent_sessions WHERE org_id = $1 AND agent_id = $2',
      [orgId, agentId],
    );
    const tracePath = join(processCwd, `${scenario}-${priorSession.id + 1}.jsonl`);
    runnerSpawnError = null;
    runnerStderr = Buffer.alloc(0);
    runnerEnv.FAKE_ACP_SCENARIO = scenario;
    runnerEnv.FAKE_ACP_TRACE = tracePath;
    runner = spawn(process.execPath, [
      runnerCli,
      '--server', apiOrigin,
      '--provider', 'claude-code',
      '--acp-command', process.execPath,
      '--acp-arg', fakeAgent,
      '--acp-arg', '--scenario', '--acp-arg', scenario,
      '--acp-arg', '--distinct-turns', '--acp-arg', 'yes',
      '--acp-arg', '--trace', '--acp-arg', tracePath,
      ...extraArgs.flatMap(value=>['--acp-arg',value]),
      '--work-dir', join(processCwd,'work'),
      '--state-dir', join(processCwd,'state'),
      '--health-port', '3867',
      '--capacity', '2',
      '--chat-profiles-file', join(runnerCwd,'chat-profiles.json'),
    ], {
      cwd: processCwd,
      env: runnerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runner.stdout.on('data', appendRunnerStderr);
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
    const session = await waitFor('runner session registration', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM agent_sessions
         WHERE org_id = $1 AND agent_id = $2 AND id > $3
           AND status <> 'offline' AND expires_at > NOW()`,
        [orgId, agentId, priorSession.id],
      );
      if (rows[0]) return rows[0];
      if (runnerSpawnError) {
        const spawnDetail = runnerSpawnError.code ?? runnerSpawnError.message ?? 'unknown error';
        throw new Error(`Runner failed to start: ${redactDiagnostic(spawnDetail)}`);
      }
      if (runner.exitCode !== null || runner.signalCode !== null) throw new Error('Runner exited before registering');
      return null;
    });
    return { session, tracePath };
  };



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

  const launched=await launchRunner('chat-policy');
  await waitFor('advertised catalog',async()=>{
    const settings=await db.getProjectChatSettings({actor,projectId:project.id});return settings.agents.find(a=>a.id===agentId)?.profiles.length;
  });
  const initialSettings=await db.getProjectChatSettings({actor,projectId:project.id});
  await db.updateProjectChatSettings({actor,projectId:project.id,expectedVersion:initialSettings.version,executionMode:'chat',defaultAgentId:agentId,defaults:{profileId:'design',model:'large',instructions:'Use the project conventions.'}});
  const boardPath=`/board?projectId=${project.id}&q=Deterministic`;
  const taskPath=`${boardPath}&taskId=${task.id}`;
  const mutations=[];
  page.on('request',request=>{if(request.url().includes('/api/collab/v1/')&&request.method()!=='GET')mutations.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await waitFor('production dashboard readiness',async()=>{
    try {
      const response=await fetch(`${origin}/login`,{signal:AbortSignal.timeout(2000)});
      if(response.status!==200)throw new Error(`Dashboard readiness returned ${response.status}`);
      return true;
    } catch(error) {
      if(error.cause?.code==='ECONNREFUSED')return false;
      throw error;
    }
  });
  await page.goto(`${origin}/login?callbackUrl=${encodeURIComponent(boardPath)}`);
  await page.getByPlaceholder('Email',{exact:true}).fill(owner.email);
  await page.getByPlaceholder('Password',{exact:true}).fill(owner.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(`${origin}${boardPath}`,{timeout:30000});
  await page.getByRole('link',{name:task.title,exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'Task details'});
  await expect(drawer.getByRole('heading',{name:task.title,exact:true})).toBeVisible();
  assert.equal(await page.getByRole('navigation',{name:'Task sections'}).count(),0);
  assert.equal(mutations.length,0);
  await shot('01-task-desktop');
  await drawer.getByRole('textbox',{name:'Comment',exact:true}).fill('Human discussion only.');
  await drawer.getByRole('button',{name:'Comment',exact:true}).click();
  await expect(drawer.getByText('Human discussion only.',{exact:true})).toBeVisible();
  assert.equal(mutations.length,1);assert.ok(mutations[0].path.endsWith('/comments'));
  await drawer.getByRole('button',{name:'Open session',exact:true}).click();
  await expect(drawer.getByRole('button',{name:'Send to agent',exact:true})).toBeVisible({timeout:30000});
  const selected=new URL(page.url()).searchParams.get('claimId');const claimId=Number(selected);assert.ok(claimId>0);
  const {rows:[claimRow]}=await pool.query('SELECT payload,status,repo,target_agent_id FROM agent_claims WHERE id=$1',[claimId]);
  assert.equal(claimRow.repo,null);assert.equal(claimRow.target_agent_id,agentId);assert.equal(claimRow.payload.profile,'design');assert.equal(claimRow.payload.model,'large');
  assert.equal((await pool.query('SELECT status FROM collab_tasks WHERE id=$1',[task.id])).rows[0].status,'backlog');
  const timings=[];
  for(let turn=1;turn<=5;turn++){
    await drawer.getByRole('textbox',{name:'Prompt',exact:true}).fill(`Design turn ${turn}`);
    const before=await drawer.getByText(/Deterministic ACP response/).allTextContents();
    const start=performance.now();
    await drawer.getByRole('button',{name:'Send to agent',exact:true}).click();
    await expect.poll(async()=>JSON.stringify(await drawer.getByText(/Deterministic ACP response/).allTextContents()),{timeout:10000}).not.toBe(JSON.stringify(before));
    timings.push(Math.round(performance.now()-start));
    await expect(drawer.getByText('Accepted by agent.',{exact:true})).toBeVisible();
    await expect(drawer.locator('[data-runner-state]')).toHaveText('Idle');
  }
  const trace=readFileSync(launched.tracePath,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const actualPrompts=trace.filter(e=>e.kind==='session_prompt');
  assert.ok(JSON.stringify(actualPrompts[0].params).includes('Use the project conventions.'));
  assert.ok(trace.some(e=>e.kind==='set_config_option'&&e.params.configId==='model'&&e.params.value==='large'));
  await expect(drawer.getByText('Design turn 5',{exact:true})).toBeVisible();
  await shot('02-session-desktop');
  await waitFor('rendered transcript read cursor',async()=>{
    const {rows:[cursor]}=await pool.query(`SELECT cursor.last_seq,
      (SELECT max(seq) FROM agent_claim_events WHERE claim_id=$1) AS max_seq
      FROM collab_claim_read_cursors cursor WHERE claim_id=$1 AND principal_id=$2`,[claimId,principal.id]);
    return cursor?.last_seq>0&&cursor.last_seq<=cursor.max_seq;
  });
  await page.goto(`${origin}/agents/${agentId}`);
  await expect(page.getByRole('heading',{name:agentId,exact:true})).toBeVisible();
  await expect(page.getByText('Busy: 1 (chat 1 / work 0)',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Max chat slots',exact:true}).fill('0');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('[data-chat-capacity]')).toHaveText('chats disabled · configured 0');
  assert.equal((await pool.query('SELECT max_chat_slots FROM agents WHERE org_id=$1 AND id=$2',[orgId,agentId])).rows[0].max_chat_slots,0);
  assert.equal((await pool.query('SELECT status FROM agent_claims WHERE id=$1',[claimId])).rows[0].status,'claimed');
  await page.getByRole('textbox',{name:'Max chat slots',exact:true}).fill('default');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('[data-chat-capacity]')).toHaveText('1 effective of 2 · configured default');
  await page.goto(`${origin}${taskPath}&claimId=${claimId}`);
  await expect(drawer.getByText('Design turn 5',{exact:true})).toBeVisible();
  await drawer.getByRole('textbox',{name:'Prompt',exact:true}).fill('HOLD_CHAT_RESPONSE');
  await drawer.getByRole('button',{name:'Send to agent',exact:true}).click();
  await expect(drawer.locator('[data-runner-state]')).toHaveText('Streaming');
  await drawer.getByRole('button',{name:'Stop response',exact:true}).click();
  await waitFor('cancel acknowledged',async()=>(await pool.query("SELECT 1 FROM agent_claim_commands WHERE claim_id=$1 AND kind='cancel' AND status='acked'",[claimId])).rows[0]);
  assert.equal((await pool.query('SELECT status FROM agent_claims WHERE id=$1',[claimId])).rows[0].status,'claimed');
  await drawer.getByRole('button',{name:'Back to task',exact:true}).click();
  await expect(drawer.getByRole('heading',{name:'Agent sessions',exact:true})).toBeVisible();
  await page.goBack();await expect(drawer.getByRole('button',{name:'Back to task',exact:true})).toBeVisible();
  await page.goForward();await expect(drawer.getByRole('heading',{name:'Agent sessions',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(drawer).not.toBeVisible();
  assert.equal(new URL(page.url()).searchParams.get('q'),'Deterministic');
  const scrollBefore=await page.evaluate(()=>{
    const main=document.querySelector('main');const grid=main.querySelector('.grid.flex-1');
    grid.scrollTop=180;main.scrollTop=120;const done=main.querySelector('details');done.open=true;
    return {grid:grid.scrollTop,main:main.scrollTop};
  });
  assert.ok(scrollBefore.grid>0||scrollBefore.main>0);
  await page.getByRole('link',{name:task.title,exact:true}).evaluate(node=>node.click());
  await expect(drawer.getByRole('heading',{name:'Agent sessions',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(drawer).not.toBeVisible();
  const scrollAfter=await page.evaluate(()=>{const main=document.querySelector('main');return {grid:main.querySelector('.grid.flex-1').scrollTop,main:main.scrollTop};});
  assert.deepEqual(scrollAfter,scrollBefore);assert.equal(await page.locator('main details').first().getAttribute('open'),'');
  assert.equal((await pool.query('SELECT status FROM agent_claims WHERE id=$1',[claimId])).rows[0].status,'claimed');
  await page.goto(`${origin}${taskPath}&claimId=${claimId}`);
  await expect(drawer.getByRole('button',{name:'Back to task',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(drawer.getByRole('textbox',{name:'Prompt',exact:true})).toBeVisible();
  assert.ok(await noHorizontalOverflow());
  const transcriptScroll=drawer.getByRole('log',{name:'Execution transcript'}).locator('..');
  await transcriptScroll.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}));});
  await expect(drawer.getByRole('button',{name:'Jump to latest',exact:true})).toBeVisible();
  await drawer.getByRole('button',{name:'Jump to latest',exact:true}).click();
  await expect(drawer.getByRole('button',{name:'Jump to latest',exact:true})).not.toBeVisible();
  await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>Boolean(document.activeElement?.closest('[role="dialog"]'))));
  await shot('03-session-mobile');
  await drawer.getByRole('button',{name:'End session',exact:true}).click();
  await waitFor('user end and released slot',async()=>{
    const {rows:[row]}=await pool.query('SELECT status,end_reason FROM agent_claims WHERE id=$1',[claimId]);return row.status==='cancelled'&&row.end_reason==='user';
  });
  await expect(drawer.getByText(/Session ended · user/)).toBeVisible({timeout:10000});
  await drawer.getByRole('button',{name:'Back to task',exact:true}).click();await expect(drawer.getByRole('heading',{name:'Agent sessions',exact:true})).toBeVisible();await shot('04-task-mobile');
  await expect(drawer.getByRole('region',{name:'Retained work'})).toContainText(`Session ${claimId}: last reported retained on agent ${agentId} (session notes).`,{timeout:10000});
  await drawer.getByRole('button',{name:'Close task',exact:true}).click();
  await page.goto(`${origin}/tasks/${task.id}`);await expect(drawer).toBeVisible();assert.ok(new URL(page.url()).pathname==='/board');
  await drawer.getByRole('button',{name:'Close task',exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});
  await stopRunner();await launchRunner('chat-policy',['--permission','yes','--elicitation','yes']);
  await page.getByRole('button',{name:'New session',exact:true}).click();
  const create=page.getByRole('dialog',{name:'New session',exact:true});
  await create.getByRole('textbox',{name:'Session title'}).fill('A fresh design session');
  await create.getByRole('button',{name:'Create session'}).click();
  await expect(drawer.getByRole('button',{name:'Send to agent',exact:true})).toBeVisible({timeout:30000});
  const newTaskId=new URL(page.url()).searchParams.get('taskId');assert.notEqual(newTaskId,task.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM collab_tasks WHERE title='A fresh design session'")).rows[0].n,1);
  await drawer.getByRole('textbox',{name:'Prompt',exact:true}).fill('Exercise structured requests');
  await drawer.getByRole('button',{name:'Send to agent',exact:true}).click();
  await expect(drawer.getByText('Allow deterministic write?',{exact:true})).toBeVisible({timeout:15000});
  await drawer.getByRole('button',{name:'Back to task',exact:true}).click();
  await expect(drawer.getByRole('button',{name:'Needs your input — view session',exact:true})).toBeVisible({timeout:10000});
  await drawer.getByRole('button',{name:'Needs your input — view session',exact:true}).click();
  await drawer.getByRole('button',{name:'Allow once',exact:true}).click();
  await drawer.getByRole('textbox',{name:'Choice',exact:true}).fill('Approved option');
  await drawer.getByRole('button',{name:'Accept response',exact:true}).click();
  await expect(drawer.getByText('Deterministic ACP response.',{exact:true})).toBeVisible({timeout:10000});
  const answers=mutations.filter(m=>m.body?.kind==='permission'||m.body?.kind==='elicitation');
  assert.deepEqual(answers.map(m=>m.body.kind),['permission','elicitation']);
  assert.deepEqual(answers[0].body.payload.answer,{outcome:{outcome:'selected',optionId:'allow-once'}});
  assert.deepEqual(answers[1].body.payload.answer,{action:'accept',content:{choice:'Approved option'}});
  await shot('07-structured-session');
  await drawer.getByRole('button',{name:'End session',exact:true}).click();
  await expect(drawer.getByText(/Session ended · user/)).toBeVisible({timeout:10000});
  await drawer.getByRole('button',{name:'Close task',exact:true}).click();
  await page.goto(`${origin}/settings?projectId=${project.id}`);
  await expect(page.getByRole('combobox',{name:'Default agent',exact:true})).toHaveValue(agentId);
  await page.getByRole('combobox',{name:'Model override',exact:true}).selectOption('small');
  await page.getByRole('button',{name:'Save execution settings',exact:true}).click();
  await expect.poll(async()=>(await db.getProjectChatSettings({actor,projectId:project.id})).defaults.model).toBe('small');
  await shot('05-settings-desktop');
  await page.getByRole('textbox',{name:'Default instructions',exact:true}).fill('Preserve my unsaved draft');
  await pool.query('UPDATE collab_projects SET version=version+1 WHERE id=$1',[project.id]);
  await page.getByRole('button',{name:'Save execution settings',exact:true}).click();
  await expect(page.getByText(/Your draft is preserved/).first()).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Default instructions',exact:true})).toHaveValue('Preserve my unsaved draft');
  await page.getByRole('button',{name:'Reload defaults',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Default instructions',exact:true})).toHaveValue('Use the project conventions.');
  let releaseLateEvents;
  const lateGate=new Promise(resolve=>{releaseLateEvents=resolve;});
  let capturedLateEvents;
  const lateCaptured=new Promise(resolve=>{capturedLateEvents=resolve;});
  const oldEventsPattern=new RegExp(`/api/collab/v1/claim-executions/${claimId}/events\\?`);
  await page.route(oldEventsPattern,async route=>{
    const response=await route.fetch();assert.equal(response.status(),200);
    capturedLateEvents();await lateGate;await route.fulfill({response});
  },{times:1});
  await page.goto(`${origin}${taskPath}&claimId=${claimId}`);
  await runBounded('capturing real delayed events',()=>lateCaptured,10000);
  await page.goto(`${origin}${boardPath}&taskId=${newTaskId}`);
  await expect(drawer.getByRole('heading',{name:'A fresh design session',exact:true})).toBeVisible();
  releaseLateEvents();await page.waitForTimeout(1200);
  assert.equal(await drawer.getByText('Design turn 5',{exact:true}).count(),0);
  await page.unroute(oldEventsPattern);
  await page.goto(`${origin}${taskPath}&claimId=${claimId}`);
  await expect(drawer.getByText('Design turn 5',{exact:true})).toBeVisible();
  const membership=(await pool.query('SELECT id,role_id FROM collab_memberships WHERE workspace_id=$1 AND principal_id=$2 AND project_id IS NULL',[workspace.id,principal.id])).rows[0];
  const clientRole=(await pool.query("SELECT id FROM collab_roles WHERE workspace_id=$1 AND name='collaborator'",[workspace.id])).rows[0];
  assert.ok(clientRole);
  await pool.query('UPDATE collab_memberships SET role_id=$2 WHERE id=$1',[membership.id,clientRole.id]);
  await expect(drawer.getByText('Design turn 5',{exact:true})).not.toBeVisible({timeout:12000});
  await expect(drawer.getByText('Internal transcript and controls require operator permissions.',{exact:true})).toBeVisible({timeout:12000});
  let privateReadsAfterRevocation=0;
  const countRevokedReads=request=>{if(/\/claim-executions\/\d+\/(events|requests|prompts)(\?|$)/.test(request.url()))privateReadsAfterRevocation++;};
  page.on('request',countRevokedReads);await page.waitForTimeout(2200);page.off('request',countRevokedReads);
  assert.equal(privateReadsAfterRevocation,0);
  await shot('06-revoked-session');
  await pool.query('UPDATE collab_memberships SET role_id=$2 WHERE id=$1',[membership.id,membership.role_id]);
  await stopRunner();
  await page.goto(`${origin}${boardPath}`);
  const article=page.getByRole('link',{name:task.title,exact:true}).locator('xpath=ancestor::article');
  await article.getByRole('button',{name:`Move task ${task.title}`,exact:true}).click();
  const beforeMove=mutations.length;
  await article.getByText('Ready',{exact:true}).locator('..').getByRole('button',{name:'top',exact:true}).click();
  await expect.poll(async()=>(await pool.query('SELECT status FROM collab_tasks WHERE id=$1',[task.id])).rows[0].status).toBe('ready');
  assert.equal(mutations.slice(beforeMove).filter(m=>m.path.endsWith('/claim-executions')).length,0);
  await page.getByRole('link',{name:task.title,exact:true}).click();
  await drawer.getByRole('textbox',{name:'Work repository',exact:true}).fill(repo);
  await drawer.getByRole('button',{name:'Start',exact:true}).click();
  await expect(drawer.locator('[data-claim-status]')).toHaveText('Pending');
  const workClaim=Number(new URL(page.url()).searchParams.get('claimId'));
  assert.equal((await pool.query('SELECT claim_type FROM agent_claims WHERE id=$1',[workClaim])).rows[0].claim_type,'spec');
  const designTask = await db.createCollabTask({ actor, projectId: project.id, title: 'Reviewed handoff design' });
  const chat = await db.startCollabClaimExecution({ actor, taskId: designTask.id, expectedVersion: designTask.version,
    idempotencyKey: randomUUID(), repo, targetAgentId: agentId, claimType: 'chat' });
  const runnerPost = async (path, body) => {
    const response = await fetch(`${apiOrigin}/api/agent-server${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token.plaintext}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.ok, true, JSON.stringify(payload));
    return payload;
  };
  const externalSlot = await runnerPost('/register', { meta: { capacity: 2, supported_claim_types: ['chat'],
    profiles: [{ id: 'design', models: ['small','large'], default_model: 'small' }] } });
  await pool.query(`UPDATE agent_claims SET status='claimed',session_id=$2,expires_at=now()+interval '1 hour' WHERE id=$1`, [chat.claim.id,externalSlot.session_id]);
  await page.goto(`${origin}${boardPath}&taskId=${designTask.id}&claimId=${chat.claim.id}`);
  await drawer.getByRole('button',{name:'Build this',exact:true}).click();
  const handoffCommand = await waitFor('handoff command',async()=>(await pool.query(`SELECT id FROM agent_claim_commands WHERE claim_id=$1 AND kind='handoff'`,[chat.claim.id])).rows[0]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collab_claim_executions e JOIN agent_claims c ON c.id=e.claim_id WHERE e.task_id=$1 AND c.claim_type='spec'`,[designTask.id])).rows[0].n,0);
  const leasedHandoff = await runnerPost(`/claims/${chat.claim.id}/commands/poll`, { session_id: externalSlot.session_id });
  assert.equal(leasedHandoff.commands[0].id,handoffCommand.id);
  await runnerPost(`/claims/${chat.claim.id}/commands/${handoffCommand.id}/ack`, { session_id: externalSlot.session_id,
    status: 'acked', result: { branch: `ff/task-${designTask.id}`, headSha: 'c'.repeat(40), digest: {
      goal: 'Build the browser-reviewed feature', decisions: ['Reuse the existing API'], acceptanceCriteria: ['Reviewed design reaches the unattended pipeline'],
      openQuestions: [], filesTouched: ['docs/design.md'],
    } } });
  await expect(drawer.getByRole('heading',{name:'Review build summary',exact:true})).toBeVisible({timeout:10000});
  await expect(drawer.getByText('Reviewed design reaches the unattended pipeline',{exact:true})).toBeVisible();
  await page.route(`**/api/collab/v1/claim-executions/${chat.claim.id}/handoffs/${handoffCommand.id}`, async route => {
    const response = await route.fetch();
    assert.equal(response.status(),202);
    await route.abort('failed');
  }, { times: 1 });
  await drawer.getByRole('button',{name:'Confirm build',exact:true}).click();
  await expect(drawer.getByText(/Unattended build queued/)).toBeVisible({timeout:10000});
  await expect(drawer.locator('section[aria-label="Build handoff"]').getByRole('alert')).toHaveCount(0);
  const handedOff = (await pool.query(`SELECT c.*,e.root_claim_id FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE e.task_id=$1 AND c.claim_type='spec'`,[designTask.id])).rows;
  assert.equal(handedOff.length,1);
  assert.equal(handedOff[0].root_claim_id,chat.claim.id);
  assert.equal(handedOff[0].payload.handed_off_from,chat.claim.id);
  assert.equal((await pool.query('SELECT status FROM agent_claims WHERE id=$1',[chat.claim.id])).rows[0].status,'claimed');
  results.handoffScope='Actual dashboard/proxy/HTTP/PostgreSQL with an external-runner protocol fixture; live-context summary generation and real Git snapshot checks have separate runtime tests.';
  assert.deepEqual(pageErrors,[]);
  assert.ok(badCollab.every(entry=>entry.endsWith(' 409')||entry.endsWith(' 403')));

  results.flow=['board task drawer','human comment isolated','explicit existing-task chat','five sticky turns','authoritative acceptance','Stop keeps session','Back and Forward','Escape preserves scope','pasted session deep link','mobile composer and no overflow','End closes session','legacy task redirect','atomic New session','real settings save and readback','real settings conflict preserves draft','structured permission and elicitation answers','overview needs-input action','real delayed transcript cannot restore prior task','expanded transcript revocation','zero private reads after authority settles','Ready movement is non-executing','Start queues unattended spec only','validated model and instructions observed by ACP child'];
  results.flow.push('rendered per-reader cursor persisted','actual agent busy split','admin capacity save and default restore','capacity shrink preserves live chat','retained scratch work surfaced','reviewed handoff survives lost confirmation response');
  results.fixtureSendToVisibleMs=timings;results.latencyScope='Five deterministic local ACP turns; not a statistically supported p95 or provider measurement.';
  results.pageErrors=pageErrors;results.badCollabResponses=badCollab;
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
console.log('chat drawer actual browser: PASS');
process.exit(0);
