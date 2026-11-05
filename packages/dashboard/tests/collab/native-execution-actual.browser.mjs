import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const databaseUrl = process.env.FF_NATIVE_UI_DATABASE_URL;
if (!databaseUrl) throw new Error('FF_NATIVE_UI_DATABASE_URL is required');
const parsed = new URL(databaseUrl);
const dbName = parsed.pathname.replace(/^\//, '');
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || databaseUrl.includes('?') || databaseUrl.includes('#')
  || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  || !/^ff_[a-z0-9_]+_test$/.test(dbName) || /(^|_)(demo|prod|production)(_|$)/.test(dbName)) {
  console.error('native-execution-actual: refusing database; use a loopback postgres:// ff_*_test database without query or fragment');
  process.exit(2);
}
const authSecret = process.env.FF_COLLAB_AUTH_SECRET;
if (!authSecret || authSecret.length < 32) throw new Error('FF_COLLAB_AUTH_SECRET (same value as the dashboard) is required');

const { assertDedicatedCollabTestDatabaseUrl, resetCollabSchema } = await import('../../../db/tests/helpers/collab-db.ts');
assertDedicatedCollabTestDatabaseUrl(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL ??= 'warn';
const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3194';
const apiPort = Number(process.env.FF_NATIVE_UI_API_PORT ?? 3195);
const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);

await resetCollabSchema(databaseUrl);
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { chromium } = await import('@playwright/test');
await db.runMigrations();
const pool = db.getPool();

const FIXTURE_PATH = '/home/owner/.codex/config.toml';
const COPY = {
  signIn: 'Sign in to the selected tool on the execution host, then try again.',
  unavailable: 'This execution profile is unavailable. Contact the execution host owner.',
  slot: 'Waiting for an execution slot.',
  requestUnavailable: 'This request is no longer available. Refresh the session.',
};
const CAPS = {
  'claude-code': ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'],
  codex: ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting', 'secret_questions'],
};
const profile = (id, backend, model, state, policy) => ({
  id, name: id, backend, model, revision: `${id}-rev-1`, capabilities: CAPS[backend], readiness: { state },
  harness: { name: backend, version: backend === 'codex' ? '0.162.1' : '2.1.317' }, policy,
  authExpectation: backend === 'codex' ? 'chatgpt-subscription' : 'claude-subscription', limits: { maxActiveSessions: 1 },
});
const catalog = {
  formatVersion: 2,
  capacity: { 'claude-code': 1, codex: 2 },
  repositories: [{ key: 'native/repo' }],
  profiles: [
    profile('cc-main', 'claude-code', 'claude-ui-model', 'ready', { permissionMode: 'manual' }),
    profile('cc-login', 'claude-code', 'claude-ui-review', 'sign_in_required', null),
    profile('cx-main', 'codex', 'codex-ui-model', 'ready', { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false, configPath: FIXTURE_PATH }),
    profile('cx-missing', 'codex', 'codex-ui-missing', 'not_installed', null),
  ],
};

const owner = { email: 'native-owner+pw@example.test', password: `owner-${randomBytes(12).toString('hex')}` };
const starter = { email: 'native-starter@example.test', name: 'Start-only collaborator', password: `starter-${randomBytes(12).toString('hex')}` };
await pool.query(`INSERT INTO orgs (id, name) VALUES ('native-ui-org', 'Native UI Org')`);
const { rows: [user] } = await pool.query(`INSERT INTO users (github_id, login, email, avatar_url) VALUES (626262, 'native-owner', 'native-owner@example.test', NULL) RETURNING id`);
await pool.query(`INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, 'native-ui-org', 'admin')`, [user.id]);
const linked = await db.ensureGithubPrincipal({ legacyUserId: user.id, displayName: 'Native owner', email: owner.email });
await pool.query('INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)', [linked.id, await db.hashPassword(owner.password)]);
const actor = { principalId: linked.id, sessionVersion: linked.sessionVersion };
const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: 'native-ui-org', name: 'Native client', idempotencyKey: 'native-ui-ws' });
const project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Native project' });
const ownerTask = await db.createCollabTask({ actor, projectId: project.id, title: 'Owner native task' });
const starterTask = await db.createCollabTask({ actor, projectId: project.id, title: 'Start-only native task' });
const host = await db.createExecutionHost({ actor, name: 'Native UI PC' });
const hostToken = host.token;
const mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'native/repo', profileIds: catalog.profiles.map((p) => p.id), defaultProfileId: 'cc-main' });

process.env.FF_COLLAB_AUTH_SECRET = authSecret;
const server = createApp().listen(apiPort, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const apiRoot = `http://127.0.0.1:${apiPort}/api`;
const evidence = {};
async function api(method, path, body, as = actor) {
  const headers = { 'x-fluent-flow-actor': db.signCollaborationActor(as, authSecret), ...(body ? { 'content-type': 'application/json' } : {}) };
  const response = await fetch(`${apiRoot}/collab/v1${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  evidence.lastApi = { channel: 'collaboration', method, status: response.status };
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path} -> ${response.status}`);
  return text ? JSON.parse(text).data : null;
}
async function connector(path, body) {
  const response = await fetch(`${apiRoot}/connector/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  evidence.lastApi = { channel: 'connector', method: 'POST', status: response.status };
  const text = await response.text();
  assert.ok(response.ok, `connector ${path} -> ${response.status}`);
  return text ? JSON.parse(text).data : null;
}

const registration = await connector('/register', { instanceId: 'native-ui-inst', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog });
const fence = { connectorSessionId: registration.connectorSessionId, leaseEpoch: registration.leaseEpoch };
const heartbeat = () => connector('/heartbeat', { ...fence, activeRunIds: [], observedAt: new Date().toISOString() });
await connector('/poll', { ...fence, waitMs: 0, limit: 10, availableSlots: { 'claude-code': 0, codex: 2 } });
await heartbeat();

const current = await api('GET', `/projects/${project.id}`);
await api('PATCH', `/projects/${project.id}`, { expectedVersion: current.version, executionDefaults: { mappingId: mapping.id, profileId: 'cc-main', model: null, instructions: '', summary: { enabled: false, profileId: null, model: null } } });
const startRole = await api('POST', `/workspaces/${workspace.id}/roles`, { name: 'Start only', capabilities: ['task.read', 'run.start'] });
const invitation = await api('POST', `/projects/${project.id}/invitations`, { email: starter.email, roleId: startRole.id, expiresInHours: 1 });
const accepted = await fetch(`${apiRoot}/collab/v1/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invitation.url.split('token=')[1], displayName: starter.name, password: starter.password }) });
assert.equal(accepted.status, 201, 'invitation accept');

const ffRequestId = (sessionId, nativeRequestId) => createHash('sha256').update(`${sessionId}|claude-code|1|${nativeRequestId}`).digest('hex').slice(0, 32);
const fingerprint = createHash('sha256').update('native-ui-duplicate').digest('hex');
async function observe(runId, sessionId, events) {
  const result = await connector('/observations', { ...fence, events: events.map((e) => ({ runId, sessionId, ...e })) });
  assert.deepEqual(result.rejectedEventIds, []);
}

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results = {};
let currentStep = 'browser setup';
let captureRecoveryState = null;
const step = (name) => { currentStep = name; console.error(`native-execution-actual: ${name}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, tries = 150) {
  for (let i = 0; i < tries; i++) { if (await predicate()) return; await wait(100); }
  assert.fail(message);
}
async function signedIn(account) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const requested = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => { const url = new URL(r.url()); if (url.pathname.startsWith('/api/collab/v1')) requested.push(`${r.method()} ${url.pathname}`); });
  await page.goto(`${origin}/login?callbackUrl=/board`);
  await page.getByPlaceholder('Email', { exact: true }).fill(account.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/board**`, { timeout: 30000 });
  return { context, page, pageErrors, requested };
}
async function startFromDialog(page, taskId) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/api/collab/v1/tasks/${taskId}/runs` && r.request().method() === 'POST', { timeout: 30000 }),
    page.getByRole('dialog', { name: 'Start AI work' }).getByRole('button', { name: 'Queue run', exact: true }).click(),
  ]);
  assert.ok(response.ok(), `Start -> ${response.status()}`);
  const { rows } = await pool.query('SELECT id FROM collab_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1', [taskId]);
  return rows[0].id;
}

let exitCode = 0;
try {
  step('owner: Settings readiness, backend grouping and capacity from the actual mapping projection');
  const ownerView = await signedIn(owner);
  let page = ownerView.page;
  await page.goto(`${origin}/settings?projectId=${project.id}`);
  const claude = page.locator('[data-backend="claude-code"]').first();
  const codex = page.locator('[data-backend="codex"]').first();
  await claude.waitFor({ timeout: 30000 });
  const claudeText = await claude.innerText();
  const codexText = await codex.innerText();
  results.settings = {
    claudeReady: /Ready/.test(await claude.locator('[data-profile-id="cc-main"]').innerText()),
    claudeSignIn: (await claude.locator('[data-profile-id="cc-login"]').innerText()).includes('Sign-in needed') && claudeText.includes(COPY.signIn),
    claudeCapacity: claudeText.includes('Capacity: 1 slot, 0 available'),
    codexReady: /Ready/.test(await codex.locator('[data-profile-id="cx-main"]').innerText()),
    codexMissing: (await codex.locator('[data-profile-id="cx-missing"]').innerText()).includes('Tool not installed') && codexText.includes(COPY.unavailable),
    codexCapacity: codexText.includes('Capacity: 2 slots, 2 available'),
    noPrivatePath: !(await page.content()).includes(FIXTURE_PATH),
  };
  assert.ok(Object.values(results.settings).every(Boolean), JSON.stringify(results.settings));

  step('owner: Start shows backend, model, policy and readiness; a non-ready profile cannot be queued');
  await page.goto(`${origin}/tasks/${ownerTask.id}`);
  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  await page.getByRole('button', { name: 'Start AI work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start AI work' });
  await dialog.getByText('Backend: Claude Code').waitFor({ timeout: 30000 });
  const queue = dialog.getByRole('button', { name: 'Queue run', exact: true });
  const startText = await dialog.innerText();
  await dialog.getByLabel('Agent profile').selectOption('cc-login');
  await dialog.getByText('Sign-in needed').waitFor();
  const signInBlocked = await queue.isDisabled();
  await dialog.getByLabel('Agent profile').selectOption('cx-main');
  await dialog.getByText('Backend: Codex').waitFor();
  const codexStart = await dialog.innerText();
  await dialog.getByLabel('Agent profile').selectOption('cc-main');
  results.start = {
    claude: /Model: claude-ui-model/.test(startText) && /Policy: permission mode manual/.test(startText),
    codex: /Model: codex-ui-model/.test(codexStart) && /Policy: approval on-request, sandbox workspace-write, network access off/.test(codexStart) && !codexStart.includes(FIXTURE_PATH),
    signInBlocked,
  };
  assert.ok(Object.values(results.start).every(Boolean), JSON.stringify(results.start));
  const ownerRunId = await startFromDialog(page, ownerTask.id);

  step('owner: own queued time and capacity copy from the actual run read');
  await heartbeat();
  const ownerRead = await api('GET', `/runs/${ownerRunId}`);
  assert.equal(ownerRead.queue?.reason, 'capacity', `actual queue ${JSON.stringify(ownerRead.queue)}`);
  const status = page.getByLabel('Run status');
  await status.getByText(COPY.slot, { exact: false }).waitFor({ timeout: 30000 });
  results.ownerQueue = {
    queuedAt: (await status.locator(`time[datetime="${ownerRead.queue.queuedAt}"]`).count()) === 1,
    frozenExecution: /Backend: Claude Code/.test(await status.innerText()) && /Policy: permission mode manual/.test(await status.innerText()),
  };
  assert.ok(Object.values(results.ownerQueue).every(Boolean), JSON.stringify(results.ownerQueue));

  step('owner: equal redacted labels answered by exact optionIds; a lost response shows no success and is never resent as new');
  const { rows: [session] } = await pool.query('SELECT id FROM collab_sessions WHERE run_id = $1', [ownerRunId]);
  const t0 = Date.now();
  await observe(ownerRunId, session.id, [{ eventId: 'native-ui-bound', kind: 'session_bound', observedAt: new Date(t0).toISOString(), payload: { backend: 'claude-code', nativeSessionId: 'native-ui-session', generation: 1 } }]);
  await observe(ownerRunId, session.id, [{
    eventId: `claude-code:${session.id}:1:request:dup-1`, kind: 'attention', observedAt: new Date(t0 + 1000).toISOString(),
    payload: {
      nativeRequestId: 'dup-1', kind: 'question', fingerprint, secret: false, state: 'pending', attention: 'permission', requestId: 'dup-1',
      choices: [{ id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
      questions: [{ id: 'q0', header: 'Pick', question: 'Pick one', options: [{ label: '[local answer]', description: null }, { label: '[local answer]', description: null }, { label: 'Red', description: null }], multiSelect: false, allowOther: false, secret: false }],
      tool: { name: 'AskUserQuestion', displayName: 'AskUserQuestion', description: null, input: {} },
      source: { backend: 'claude-code', generation: 1, nativeEventId: 'request:dup-1', seq: 1 },
    },
  }]);
  const requestId = ffRequestId(session.id, 'dup-1');
  const card = page.locator(`[data-request-id="${requestId}"]`);
  await card.waitFor({ timeout: 30000 });
  assert.equal(await card.getByText('[local answer]', { exact: true }).count(), 2);
  await card.locator('input[value="o1"]').check();
  let dropped = 0;
  await page.route(`**/api/collab/v1/sessions/${session.id}/commands`, async (route) => {
    if (dropped > 0) return route.continue();
    dropped++;
    await route.fetch();
    return route.abort('failed');
  });
  await card.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await page.getByLabel('Sessions').getByRole('alert').waitFor({ timeout: 30000 });
  const stored = async () => (await pool.query(`SELECT payload FROM collab_connector_commands WHERE session_id = $1 AND kind = 'permission'`, [session.id])).rows;
  await until(async () => (await stored()).length === 1, 'the answer did not reach the actual server');
  const [command] = await stored();
  const afterLoss = { stillListed: (await card.count()) === 1, choiceKept: await card.locator('input[value="o1"]').isChecked(), noSuccess: !/answer (sent|submitted)|success/i.test(await page.getByLabel('Sessions').innerText()) };
  await card.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await page.getByText(COPY.requestUnavailable, { exact: true }).waitFor({ timeout: 30000 });
  results.answer = {
    ...afterLoss,
    exactOptionIds: JSON.stringify(command.payload.response?.selections) === JSON.stringify({ q0: { optionIds: ['o1'] } }) && command.payload.requestId === requestId,
    retryRefusedNotDuplicated: (await stored()).length === 1,
  };
  assert.ok(Object.values(results.answer).every(Boolean), JSON.stringify(results.answer));
  await page.unroute(`**/api/collab/v1/sessions/${session.id}/commands`);
  step('recovery: publish first uncertainty through connector observations');
  const QUEUED = 'Request queued. The execution host has not confirmed it yet.';
  const NEW_TEXT = 'Continue from the last green test';
  const expectedPrompt = { kind: 'prompt', text: NEW_TEXT, behavior: 'interrupt' };
  const commandsOf = async (kind) => (await pool.query(`SELECT payload FROM collab_connector_commands WHERE session_id = $1 AND kind = $2 ORDER BY created_at`, [session.id, kind])).rows;
  const sessionState = async () => (await pool.query('SELECT state FROM collab_sessions WHERE id = $1', [session.id])).rows[0].state;
  captureRecoveryState = async () => {
    const { rows: [state] } = await pool.query(
      `SELECT s.state AS session_state, r.state AS run_state,
        (SELECT count(*)::int FROM collab_connector_commands WHERE session_id = s.id AND kind = 'prompt') AS prompt_count,
        (SELECT count(*)::int FROM collab_connector_commands WHERE session_id = s.id AND kind = 'cancel') AS cancel_count
       FROM collab_sessions s JOIN collab_runs r ON r.id = s.run_id WHERE s.id = $1`,
      [session.id],
    );
    evidence.recoveryState = state;
  };
  const originalLaunches = JSON.stringify(await commandsOf('launch'));
  await observe(ownerRunId, session.id, [{ eventId: 'native-ui-uncertain-1', kind: 'state', observedAt: new Date(t0 + 2000).toISOString(), payload: { state: 'reconciling' } }]);
  await captureRecoveryState();
  step('recovery: show uncertainty controls from normal polling');
  const sessions = page.getByLabel('Sessions');
  const recoverySend = sessions.getByRole('button', { name: 'Send new instructions', exact: true });
  await recoverySend.waitFor({ timeout: 30000 });
  const promptInput = sessions.getByPlaceholder(/^(New instructions to continue…|Send a follow-up instruction…)$/);
  const recoveryShape = { noTurnCancel: (await page.getByRole('button', { name: 'Cancel current turn', exact: true }).count()) === 0, noSteer: (await page.getByLabel('Prompt behavior').count()) === 0 };
  assert.ok(Object.values(recoveryShape).every(Boolean), 'uncertainty must offer only explicit recovery controls');
  let droppedPrompt = 0;
  const recoveryRequests = [];
  await page.route(`**/api/collab/v1/sessions/${session.id}/commands`, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    const key = request.headers()['idempotency-key'];
    recoveryRequests.push({ body, key });
    if (droppedPrompt > 0 || body.kind !== 'prompt' || body.text !== NEW_TEXT) return route.continue();
    const response = await route.fetch();
    evidence.lostPromptStatus = response.status();
    if (!response.ok()) return route.fulfill({ response });
    droppedPrompt++;
    evidence.droppedPromptResponses = droppedPrompt;
    return route.abort('failed');
  });
  step('recovery: submit new instructions and drop only the accepted response');
  await promptInput.fill(NEW_TEXT);
  await recoverySend.click();
  await sessions.getByRole('alert').filter({ hasNotText: COPY.requestUnavailable }).waitFor({ timeout: 30000 });
  await captureRecoveryState();
  assert.equal(droppedPrompt, 1, 'the fault must drop one actually accepted prompt response');
  assert.ok([200, 202].includes(evidence.lostPromptStatus), 'the dropped response must confirm API acceptance');
  await until(async () => (await commandsOf('prompt')).length === 1, 'the recovery prompt did not reach the actual server');
  const afterLostPrompt = { textKept: (await promptInput.inputValue()) === NEW_TEXT, noQueuedClaim: (await page.getByText(QUEUED).count()) === 0, serverStateAfterLost: await sessionState() };
  evidence.afterLostPrompt = afterLostPrompt;
  step('recovery: lost response retains text and makes no acceptance or recovery claim');
  assert.ok(afterLostPrompt.textKept, 'lost response must preserve the typed instructions');
  assert.ok(afterLostPrompt.noQueuedClaim, 'lost response must not claim queued acceptance');
  assert.equal(afterLostPrompt.serverStateAfterLost, 'queued', 'accepted prompt must move the actual session to queued');
  assert.equal(await page.getByText(/recovered|stopped|succeeded/i).count(), 0, 'lost response must not claim recovery');

  step('recovery: normal polling visibly advances the session to queued before retry');
  await sessions.getByRole('button', { name: 'Work session · queued', exact: true }).waitFor({ timeout: 30000 });
  await captureRecoveryState();
  evidence.queuedVisibleBeforeRetry = true;
  evidence.textKeptAfterPolling = (await promptInput.inputValue()) === NEW_TEXT;
  assert.ok(evidence.textKeptAfterPolling, 'normal queued polling must preserve the unconfirmed instructions');
  assert.equal(await page.getByText(QUEUED).count(), 0, 'polling queued must not imply this command response was confirmed');
  assert.equal(await page.getByText(/recovered|stopped|succeeded/i).count(), 0, 'polling queued must not claim recovery');
  assert.equal(recoveryRequests.length, 1, 'polling must not automatically replay the old prompt');

  step('recovery: retry the retained intent using the currently visible send control');
  const [retryResponse] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/api/collab/v1/sessions/${session.id}/commands` && r.request().method() === 'POST'),
    sessions.getByRole('button', { name: /^(Send|Send new instructions)$/ }).click(),
  ]);
  evidence.retryStatus = retryResponse.status();
  await captureRecoveryState();
  const prompts = await commandsOf('prompt');
  const promptRequests = recoveryRequests.filter((request) => request.body.kind === 'prompt');
  evidence.retry = {
    requestCount: promptRequests.length,
    firstKeyPresent: typeof promptRequests[0]?.key === 'string' && promptRequests[0].key.length > 0,
    sameKey: promptRequests[1]?.key === promptRequests[0]?.key,
    sameBody: JSON.stringify(promptRequests[1]?.body) === JSON.stringify(promptRequests[0]?.body),
    initialBodyCorrect: JSON.stringify(promptRequests[0]?.body) === JSON.stringify(expectedPrompt),
    promptRows: prompts.length,
  };
  step('recovery: retry preserves the same idempotency key after queued polling');
  assert.equal(promptRequests.length, 2, 'one explicit retry must issue exactly one additional request');
  assert.ok(evidence.retry.firstKeyPresent, 'initial recovery intent must have an idempotency key');
  assert.ok(evidence.retry.sameKey, 'retry after queued polling must reuse the original idempotency key');
  step('recovery: retry preserves the exact interrupt prompt body');
  assert.ok(evidence.retry.initialBodyCorrect, 'recovery must send only the new interrupt instructions');
  assert.ok(evidence.retry.sameBody, 'retry after queued polling must preserve the original command body');
  step('recovery: confirmed retry is accepted once without old prompt replay');
  assert.ok([200, 202].includes(retryResponse.status()), 'retry must confirm acceptance');
  assert.equal(prompts.length, 1, 'retry must not store a second prompt');
  assert.equal(JSON.stringify(await commandsOf('launch')) === originalLaunches, true, 'recovery must not replay or replace the original launch');
  await page.getByText(QUEUED, { exact: true }).waitFor({ timeout: 30000 });
  step('recovery: confirmed acceptance clears text and shows only truthful queued copy');
  await until(async () => (await promptInput.inputValue()) === '', 'the typed text was not cleared after the queued response');
  const stateAfterPrompt = await sessionState();
  await sessions.getByRole('button', { name: `Work session · ${stateAfterPrompt}` }).waitFor({ timeout: 30000 });
  const promptResults = {
    ...recoveryShape,
    ...afterLostPrompt,
    retryStatus: retryResponse.status(),
    retrySameKey: evidence.retry.sameKey,
    retrySameBody: evidence.retry.sameBody,
    retryReplayedNotDuplicated: prompts.length === 1,
    onlyNewText: prompts[0].payload.text === NEW_TEXT && prompts[0].payload.behavior === 'interrupt' && !Object.hasOwn(prompts[0].payload, 'prompt'),
    uiFollowsServer: stateAfterPrompt === 'reconciling' ? (await recoverySend.count()) === 1 : (await recoverySend.count()) === 0,
    noRecoveryClaim: (await page.getByText(/recovered|stopped|succeeded/i).count()) === 0,
  };

  step('recovery: publish a second uncertainty for explicit Cancel');
  await observe(ownerRunId, session.id, [{ eventId: 'native-ui-uncertain-2', kind: 'state', observedAt: new Date(Date.now()).toISOString(), payload: { state: 'reconciling' } }]);
  await captureRecoveryState();
  step('recovery: show explicit Cancel through normal polling');
  const recoveryCancel = page.getByRole('button', { name: 'Cancel uncertain execution', exact: true });
  await recoveryCancel.waitFor({ timeout: 30000 });
  step('recovery: submit explicit Cancel to the actual API');
  const [cancelResponse] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/api/collab/v1/sessions/${session.id}/commands` && r.request().method() === 'POST'),
    recoveryCancel.click(),
  ]);
  evidence.cancelStatus = cancelResponse.status();
  await captureRecoveryState();
  step('recovery: Cancel is accepted and stored as a distinct intent');
  assert.ok([200, 202].includes(cancelResponse.status()), 'explicit Cancel must be accepted');
  const cancels = await commandsOf('cancel');
  assert.equal(cancels.length, 1, 'explicit Cancel must store exactly one cancel command');
  const cancelRequests = recoveryRequests.filter((request) => request.body.kind === 'cancel');
  assert.equal(cancelRequests.length, 1, 'explicit Cancel must issue exactly one request');
  assert.ok(typeof cancelRequests[0].key === 'string' && cancelRequests[0].key.length > 0 && cancelRequests[0].key !== promptRequests[0].key, 'Cancel must have a distinct idempotency key');
  assert.equal(JSON.stringify(cancelRequests[0].body) === JSON.stringify({ kind: 'cancel' }), true, 'Cancel must not include old prompt instructions');
  assert.equal((await commandsOf('prompt')).length, 1, 'Cancel must not replay the prompt');
  step('recovery: accepted Cancel shows queued without claiming stopped or recovered');
  await page.getByText(QUEUED, { exact: true }).waitFor({ timeout: 30000 });
  await page.unroute(`**/api/collab/v1/sessions/${session.id}/commands`);
  results.recovery = {
    ...promptResults,
    cancelStatus: cancelResponse.status(),
    cancelStored: cancels.length === 1,
    cancelNoRecoveryClaim: (await page.getByText(/recovered|stopped|succeeded/i).count()) === 0,
  };
  results.recoveryServer = { serverStateAfterLost: afterLostPrompt.serverStateAfterLost, stateAfterPrompt, stateAfterCancel: await sessionState() };
  const { retryStatus, cancelStatus, serverStateAfterLost, ...checks } = results.recovery;
  void serverStateAfterLost;
  assert.ok([200, 202].includes(retryStatus), `retry status ${retryStatus}`);
  assert.ok([200, 202].includes(cancelStatus), `recovery cancel status ${cancelStatus}`);
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(results.recovery));
  results.ownerPageErrors = ownerView.pageErrors.length;
  assert.equal(ownerView.pageErrors.length, 0, ownerView.pageErrors.join(';'));
  await ownerView.context.close();

  step('start-only: generic Start, own wait only, no profile/model/policy/session detail');
  const starterView = await signedIn(starter);
  page = starterView.page;
  await page.goto(`${origin}/tasks/${starterTask.id}`);
  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  await page.getByRole('button', { name: 'Start AI work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Start AI work' }).getByText(/configured execution settings/).waitFor({ timeout: 30000 });
  const starterRunId = await startFromDialog(page, starterTask.id);
  await heartbeat();
  const starterStatus = page.getByLabel('Run status');
  await starterStatus.getByText(COPY.slot, { exact: false }).waitFor({ timeout: 30000 });
  const starterRead = await (await page.request.get(`${origin}/api/collab/v1/runs/${starterRunId}`)).json();
  const body = await page.locator('body').innerText();
  const { rows: [starterSession] } = await pool.query('SELECT id FROM collab_sessions WHERE run_id = $1', [starterRunId]);
  results.startOnly = {
    actualBadge: starterRead.data.execution === null && starterRead.data.sessions.length === 0 && starterRead.data.queue?.reason === 'capacity',
    queuedAt: (await starterStatus.locator(`time[datetime="${starterRead.data.queue.queuedAt}"]`).count()) === 1,
    noDetails: !['Backend:', 'Model:', 'Policy:', 'cc-main', 'claude-ui-model', 'permission mode', starterSession.id].some((s) => body.includes(s)),
    noPrivateRequests: !starterView.requested.some((r) => r.includes('/mappings') || r.includes('/sessions/')),
  };
  assert.ok(Object.values(results.startOnly).every(Boolean), JSON.stringify(results.startOnly));
  step('offline: a stale fixture heartbeat changes the queue reason without changing its timestamp');
  await pool.query("UPDATE collab_hosts SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [host.id]);
  await starterStatus.getByText('The execution host is offline.', { exact: false }).waitFor({ timeout: 30000 });
  const offlineRead = await (await page.request.get(`${origin}/api/collab/v1/runs/${starterRunId}`)).json();
  results.offline = {
    actualReason: offlineRead.data.queue?.reason === 'host_offline',
    queuedAtUnchanged: offlineRead.data.queue?.queuedAt === starterRead.data.queue.queuedAt,
    ownTimestampVisible: (await starterStatus.locator(`time[datetime="${starterRead.data.queue.queuedAt}"]`).count()) === 1,
    noCapacityClaim: (await starterStatus.getByText(COPY.slot, { exact: false }).count()) === 0,
  };
  assert.ok(Object.values(results.offline).every(Boolean), JSON.stringify(results.offline));
  await heartbeat();
  await starterStatus.getByText(COPY.slot, { exact: false }).waitFor({ timeout: 30000 });
  assert.equal(starterView.pageErrors.length, 0, starterView.pageErrors.join(';'));
  await starterView.context.close();

  console.log(JSON.stringify({ result: 'PASS', scope: 'actual dashboard/API/PG with synthetic connector observations; no native worker or model', results }));
} catch (error) {
  if (captureRecoveryState) {
    try {
      await captureRecoveryState();
    } catch {
      evidence.recoveryStateCapture = 'unavailable; preserving the original failing substep';
    }
  }
  console.error(JSON.stringify({ result: 'FAIL', step: currentStep, results, evidence, message: error instanceof assert.AssertionError ? 'Assertion failed at the named substep.' : 'Browser or API operation failed at the named substep.' }));
  exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
  process.exitCode = exitCode;
}
