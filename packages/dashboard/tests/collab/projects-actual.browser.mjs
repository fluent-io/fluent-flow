import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

const databaseUrl = process.env.FF_PROJECTS_DATABASE_URL;
if (!databaseUrl) throw new Error('FF_PROJECTS_DATABASE_URL is required');
const parsed = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || databaseUrl.includes('?') || databaseUrl.includes('#')) {
  console.error('projects-actual: refusing database URL; use postgres:// or postgresql:// without query parameters or fragments');
  process.exit(2);
}
const dbName = parsed.pathname.replace(/^\//, '');
if (!/^ff_[a-z0-9_]+_test$/.test(dbName) || /(^|_)(demo|prod|production)(_|$)/.test(dbName)) {
  console.error(`projects-actual: refusing to reset database "${dbName}"; use a dedicated ff_*_test database`);
  process.exit(2);
}
const authSecret = process.env.FF_COLLAB_AUTH_SECRET;
if (!authSecret || authSecret.length < 32) throw new Error('FF_COLLAB_AUTH_SECRET (same value as the dashboard) is required');

const { assertDedicatedCollabTestDatabaseUrl, resetCollabSchema } = await import('../../../db/tests/helpers/collab-db.ts');
assertDedicatedCollabTestDatabaseUrl(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL ??= 'warn';
const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3192';
const apiPort = Number(process.env.FF_PROJECTS_API_PORT ?? 3193);
const shots = process.env.FF_PROJECTS_SCREENSHOT_DIR;
const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);

await resetCollabSchema(databaseUrl);
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { chromium } = await import('@playwright/test');
await db.runMigrations();

const owner = { email: 'projects-owner+pw@example.test', login: 'projects-owner', password: `owner-${randomBytes(12).toString('hex')}` };
const collaborator = { email: 'projects-collab@example.test', name: 'Projects Collaborator', password: `collab-${randomBytes(12).toString('hex')}` };
const pool = db.getPool();
await pool.query(`INSERT INTO orgs (id, name) VALUES ('projects-org', 'Projects Org')`);
const { rows: [user] } = await pool.query(`INSERT INTO users (github_id, login, email, avatar_url) VALUES (525252, $1, 'projects-owner@example.test', NULL) RETURNING id`, [owner.login]);
await pool.query(`INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, 'projects-org', 'admin')`, [user.id]);
const linked = await db.ensureGithubPrincipal({ userId: user.id, displayName: 'Projects owner', email: owner.email });
await pool.query('INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)', [linked.id, await db.hashPassword(owner.password)]);
const actor = { principalId: linked.id, sessionVersion: linked.sessionVersion };

const clientA = await db.bootstrapCollaborationWorkspace({ actor, orgId: 'projects-org', name: 'Client A', idempotencyKey: 'projects-client-a' });
const clientB = await db.bootstrapCollaborationWorkspace({ actor, orgId: 'projects-org', name: 'Client B', idempotencyKey: 'projects-client-b' });
const A1 = await db.createCollabProject({ actor, workspaceId: clientA.id, name: 'Project A1' });
const A2 = await db.createCollabProject({ actor, workspaceId: clientA.id, name: 'Project A2' });
const B1 = await db.createCollabProject({ actor, workspaceId: clientB.id, name: 'Project B1' });
const tasks = {
  A1: await db.createCollabTask({ actor, projectId: A1.id, title: 'A1 seeded task' }),
  A2: await db.createCollabTask({ actor, projectId: A2.id, title: 'A2 seeded task' }),
  B1: await db.createCollabTask({ actor, projectId: B1.id, title: 'B1 seeded task' }),
};

process.env.FF_COLLAB_AUTH_SECRET = authSecret;
const server = createApp().listen(apiPort, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const apiBase = `http://127.0.0.1:${apiPort}/api/collab/v1`;
async function api(method, path, body, as = actor) {
  const headers = { 'x-fluent-flow-actor': db.signCollaborationActor(as, authSecret), ...(body ? { 'content-type': 'application/json' } : {}) };
  const response = await fetch(`${apiBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path} -> ${response.status} ${text}`);
  return text ? JSON.parse(text).data : null;
}
await api('PATCH', `/projects/${A1.id}/overview`, { expectedVersion: (await api('GET', `/projects/${A1.id}`)).version, description: 'Seeded arithmetic demo overview', testInstructions: 'npm test' });

const writer = await api('POST', `/workspaces/${clientA.id}/roles`, { name: 'Projects writer', capabilities: ['task.read', 'task.write', 'comment.write'] });
const viewer = await api('POST', `/workspaces/${clientA.id}/roles`, { name: 'Projects A2 editor', capabilities: ['task.read', 'project.admin'] });
const invitation = await api('POST', `/projects/${A1.id}/invitations`, { email: collaborator.email, roleId: writer.id, expiresInHours: 1 });
const acceptedResponse = await fetch(`${apiBase}/invitations/accept`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: invitation.url.split('token=')[1], displayName: collaborator.name, password: collaborator.password }),
});
assert.equal(acceptedResponse.status, 201, 'invitation accept');
const collaboratorPrincipal = (await acceptedResponse.json()).data.principal;
await api('POST', `/projects/${A2.id}/members`, { principalId: collaboratorPrincipal.id, roleId: viewer.id });
const collaboratorActor = { principalId: collaboratorPrincipal.id, sessionVersion: collaboratorPrincipal.sessionVersion };
await api('POST', `/tasks/${tasks.A1.id}/comments`, { body: 'Collaborator update for attention', visibility: 'client' }, collaboratorActor);
const savedKey = (principal) => `fluent-flow:current-project:${principal.id}:${principal.sessionVersion}`;

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const badCollab = [];
const attentionQueries = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => {
  const url = new URL(r.url());
  if (url.pathname === '/api/collab/v1/attention') attentionQueries.push(url.searchParams.get('projectId'));
  if (url.pathname.startsWith('/api/collab/v1') && r.status() >= 400) badCollab.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
});
const results = {};
const step = (name) => console.error(`projects-actual: ${name}`);
const header = () => page.getByRole('combobox', { name: 'Current project', exact: true });
const main = () => page.locator('main');
async function shot(name) { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); } }
async function noOverflow() { return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); }
async function signIn(email, password) {
  await page.goto(`${origin}/login?callbackUrl=/board`);
  await page.getByPlaceholder('Email', { exact: true }).fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/board**`, { timeout: 30000 });
}
async function headerIs(value) {
  return page.waitForFunction((v) => { const el = document.querySelector('select[aria-label="Current project"]'); return el && !el.disabled && el.value === v; }, value, { timeout: 10000 }).then(() => true, () => false);
}
async function headerOptions() {
  return header().evaluate((select) => [...select.querySelectorAll('optgroup')].map((g) => ({ label: g.label, projects: [...g.querySelectorAll('option')].map((o) => o.textContent) })));
}

try {
  step('owner sign-in and Projects list');
  await signIn(owner.email, owner.password);
  await header().waitFor({ timeout: 30000 });
  await page.locator('aside nav').getByText('Projects', { exact: true }).click();
  await page.waitForURL(`${origin}/projects`, { timeout: 30000 });
  await main().getByRole('link', { name: 'Project B1', exact: true }).waitFor({ timeout: 30000 });
  results.ownerList = {
    groups: await main().getByRole('heading', { level: 2 }).allInnerTexts(),
    projects: await main().getByRole('link', { name: /^Project / }).allInnerTexts(),
  };
  results.ownerHeaderGroups = await headerOptions();
  await main().getByRole('region', { name: 'Client A', exact: true }).getByPlaceholder('New project name').fill('Project A3 created in browser');
  await main().getByRole('region', { name: 'Client A', exact: true }).getByRole('button', { name: 'Create project' }).click();
  await main().getByRole('link', { name: 'Project A3 created in browser', exact: true }).waitFor({ timeout: 30000 });
  results.createdInList = true;
  await shot('owner-projects-desktop');

  step('owner edits overview and reloads');
  await main().getByRole('link', { name: 'Project A1', exact: true }).click();
  await page.waitForURL(`${origin}/projects/${A1.id}`);
  await main().getByText('Seeded arithmetic demo overview').waitFor({ timeout: 30000 });
  results.detailHeaderFollowsRoute = await headerIs(A1.id);
  await main().getByRole('button', { name: 'Edit overview' }).click();
  await main().getByLabel('Description', { exact: true }).fill('Edited in the browser');
  await main().getByLabel('How to run', { exact: true }).fill('No server. Run node directly.');
  await main().getByRole('button', { name: 'Save overview' }).click();
  await main().getByText('No server. Run node directly.').waitFor({ timeout: 30000 });
  await page.reload();
  await main().getByText('Edited in the browser').waitFor({ timeout: 30000 });
  results.editPersistedAfterReload = await main().getByText('No server. Run node directly.').isVisible();
  await shot('owner-project-detail-desktop');

  step('rename reaches header and list without reload');
  await main().getByRole('button', { name: 'Edit overview' }).click();
  await main().getByLabel('Name', { exact: true }).fill('Project A1 renamed');
  await main().getByRole('button', { name: 'Save overview' }).click();
  await main().getByRole('heading', { name: 'Project A1 renamed', level: 1 }).waitFor({ timeout: 30000 });
  const renamedInHeader = await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Current project"] option')].some((o) => o.textContent === 'Project A1 renamed'), null, { timeout: 10000 }).then(() => true, () => false);
  await main().getByRole('link', { name: 'Projects', exact: true }).click();
  await page.waitForURL(`${origin}/projects`);
  const renamedInList = await main().getByRole('link', { name: 'Project A1 renamed', exact: true }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  results.rename = { header: renamedInHeader, list: renamedInList };
  await page.goto(`${origin}/projects/${A1.id}`);
  await main().getByRole('button', { name: 'Edit overview' }).click();
  await main().getByLabel('Name', { exact: true }).fill('Project A1');
  await main().getByRole('button', { name: 'Save overview' }).click();
  await main().getByRole('heading', { name: 'Project A1', level: 1 }).waitFor({ timeout: 30000 });

  step('catalog 503 keeps the draft; catalog 403 clears it and a late save cannot revive it');
  await main().getByRole('button', { name: 'Edit overview' }).click();
  const testField = main().getByLabel('How to test', { exact: true });
  await testField.fill('Draft kept through a 503');
  let meMode = 'fail503';
  await page.route('**/api/collab/v1/me', async (route) => {
    if (meMode === 'fail503') return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Temporarily unavailable.' } } });
    if (meMode === 'deny403') return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Forbidden.' } } });
    return route.continue();
  });
  await page.waitForTimeout(7000); // more than one shared catalog poll
  const draftAfter503 = (await testField.count()) ? await testField.inputValue() : null;
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  await page.route(`**/api/collab/v1/projects/${A1.id}/overview`, async (route) => { await saveGate; await route.continue(); });
  await main().getByRole('button', { name: 'Save overview' }).click();
  meMode = 'deny403';
  const clearedOn403 = await main().getByText('Project not found').waitFor({ timeout: 20000 }).then(() => true, () => false);
  releaseSave();
  await page.waitForTimeout(2000);
  results.authLoss = {
    draftAfter503,
    clearedOn403,
    draftGone: await testField.count() === 0,
    revivedBySave: await main().getByRole('heading', { name: 'Project A1', level: 1 }).count(),
  };
  await page.unroute(`**/api/collab/v1/projects/${A1.id}/overview`);
  await page.unroute('**/api/collab/v1/me');
  await page.goto(`${origin}/projects/${A1.id}`);
  await main().getByRole('heading', { name: 'Project A1', level: 1 }).waitFor({ timeout: 30000 });

  step('stale overview edit');
  await main().getByRole('button', { name: 'Edit overview' }).click();
  await main().getByLabel('Description', { exact: true }).fill('Stale browser draft');
  const current = await api('GET', `/projects/${A1.id}`);
  await api('PATCH', `/projects/${A1.id}/overview`, { expectedVersion: current.version, description: 'Changed elsewhere' });
  await main().getByRole('button', { name: 'Save overview' }).click();
  await main().getByRole('alert').filter({ hasText: 'changed' }).waitFor({ timeout: 30000 });
  const afterConflict = await api('GET', `/projects/${A1.id}`);
  results.conflict = { shown: true, serverDescription: afterConflict.description, name: afterConflict.name, version: afterConflict.version - current.version };
  await shot('owner-project-conflict');
  await main().getByRole('button', { name: 'Reload project' }).click();
  await main().getByText('Changed elsewhere').waitFor({ timeout: 30000 });

  step('header switching on detail and stale responses');
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/projects/${A2.id}`);
  await main().getByRole('heading', { name: 'Project A2', level: 1 }).waitFor({ timeout: 30000 });
  let releaseA1;
  const delayed = new Promise((resolve) => { releaseA1 = resolve; });
  await page.route(`**/api/collab/v1/projects/${A1.id}`, async (route) => { await delayed; await route.continue(); });
  await header().selectOption(A1.id);
  await page.waitForURL(`${origin}/projects/${A1.id}`);
  await header().selectOption(B1.id);
  await page.waitForURL(`${origin}/projects/${B1.id}`);
  await main().getByRole('heading', { name: 'Project B1', level: 1 }).waitFor({ timeout: 30000 });
  releaseA1();
  await page.waitForTimeout(1500);
  await page.unroute(`**/api/collab/v1/projects/${A1.id}`);
  results.lateResponseIgnored = !(await main().innerText()).includes('Changed elsewhere') && await main().getByRole('heading', { name: 'Project B1', level: 1 }).isVisible();

  step('board uses remembered selection and deep links win');
  await page.goto(`${origin}/board`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 });
  results.boardUsesRemembered = { header: await headerIs(B1.id), showsA1: await main().getByText('A1 seeded task').count() };
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  await page.reload();
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  results.boardAfterReload = { header: await headerIs(A2.id), showsB1: await main().getByText('B1 seeded task').count() };
  await page.goto(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  results.deepLink = { header: await headerIs(A1.id), showsA2: await main().getByText('A2 seeded task').count() };

  step('workspace-only board link overrides a saved project');
  await page.goto(`${origin}/board?workspaceId=${clientB.id}`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 });
  await main().getByRole('button', { name: 'New task' }).click();
  results.workspaceLink = {
    header: await headerIs(''),
    showsA1: await main().getByText('A1 seeded task').count(),
    dialog: await page.getByRole('dialog', { name: 'Create task' }).getByRole('combobox', { name: 'Project' }).locator('option').allInnerTexts(),
  };
  await page.getByRole('dialog', { name: 'Create task' }).getByRole('button', { name: 'Cancel' }).click();

  step('back and forward between project and workspace board links');
  async function dialogChoices() {
    await main().getByRole('button', { name: 'New task' }).click();
    const choices = await page.getByRole('dialog', { name: 'Create task' }).getByRole('combobox', { name: 'Project' }).locator('option').allInnerTexts();
    await page.getByRole('dialog', { name: 'Create task' }).getByRole('button', { name: 'Cancel' }).click();
    return choices;
  }
  await header().selectOption(A1.id);
  await page.waitForURL(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  await page.goBack();
  await page.waitForURL(`${origin}/board?workspaceId=${clientB.id}`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 });
  const back1 = { header: await headerIs(''), dialog: await dialogChoices() };
  await page.goForward();
  await page.waitForURL(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  const forward = { header: await headerIs(A1.id), dialog: await dialogChoices() };
  await page.goBack();
  await page.waitForURL(`${origin}/board?workspaceId=${clientB.id}`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 });
  const back2 = { header: await headerIs(''), dialog: await dialogChoices() };
  results.history = { back1, forward, back2 };
  await page.goto(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });

  step('task creation follows selection and a switch discards the draft');
  await main().getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create task' });
  results.dialogProjects = await dialog.getByRole('combobox', { name: 'Project' }).locator('option').allInnerTexts();
  await dialog.getByPlaceholder('Title').fill('Draft that must not be created');
  await header().selectOption(B1.id);
  await page.waitForURL(`${origin}/board?projectId=${B1.id}`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 });
  results.dialogClosedOnSwitch = await dialog.count() === 0;
  await main().getByRole('button', { name: 'New task' }).click();
  results.dialogProjectsAfterSwitch = await dialog.getByRole('combobox', { name: 'Project' }).locator('option').allInnerTexts();
  await dialog.getByPlaceholder('Title').fill('Created for B1 in browser');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await main().getByText('Created for B1 in browser').waitFor({ timeout: 30000 });
  const allTasks = (await api('GET', '/tasks?limit=100'));
  results.createdTaskProject = allTasks.find((t) => t.title === 'Created for B1 in browser')?.projectId === B1.id;
  results.staleDraftCreated = allTasks.some((t) => t.title === 'Draft that must not be created');
  await shot('owner-board-desktop');

  step('late create success after a switch stays out of the new board');
  await page.goto(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  await page.route(`**/api/collab/v1/projects/${A1.id}/tasks`, async (route) => { if (route.request().method() === 'POST') await createGate; await route.continue(); });
  await main().getByRole('button', { name: 'New task' }).click();
  await dialog.getByPlaceholder('Title').fill('Late A1 task');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  releaseCreate();
  await page.waitForTimeout(2000);
  await page.unroute(`**/api/collab/v1/projects/${A1.id}/tasks`);
  results.lateCreate = {
    shownOnA2: await main().getByText('Late A1 task').count(),
    createdInA1: (await api('GET', '/tasks?limit=100')).find((t) => t.title === 'Late A1 task')?.projectId === A1.id,
  };

  step('late move failure after a switch does not restore the old card');
  await page.goto(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  let releaseMove;
  const moveGate = new Promise((resolve) => { releaseMove = resolve; });
  await page.route(`**/api/collab/v1/tasks/${tasks.A1.id}/moves`, async (route) => {
    await moveGate;
    await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Injected move failure.' } } });
  });
  const card = main().locator('article', { hasText: 'A1 seeded task' });
  await card.getByRole('button', { name: 'Move task A1 seeded task' }).click();
  await card.locator('div.justify-between.gap-1', { hasText: 'Ready' }).getByRole('button', { name: 'top' }).click();
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  const loadedWhileMovePending = await main().getByText('A2 seeded task').waitFor({ timeout: 15000 }).then(() => true, () => false);
  releaseMove();
  await page.waitForTimeout(2000);
  await page.unroute(`**/api/collab/v1/tasks/${tasks.A1.id}/moves`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  results.lateMove = { loadedWhileMovePending, showsA1: await main().getByText('A1 seeded task').count(), alerts: await main().getByRole('alert').count() };

  step('A-B-A: an abandoned move failure stays out of the returned view');
  await page.goto(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  let releaseAbaMove;
  const abaMoveGate = new Promise((resolve) => { releaseAbaMove = resolve; });
  await page.route(`**/api/collab/v1/tasks/${tasks.A1.id}/moves`, async (route) => {
    await abaMoveGate;
    await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Injected move failure.' } } });
  });
  const abaCard = main().locator('article', { hasText: 'A1 seeded task' });
  await abaCard.getByRole('button', { name: 'Move task A1 seeded task' }).click();
  await abaCard.locator('div.justify-between.gap-1', { hasText: 'Ready' }).getByRole('button', { name: 'top' }).click();
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  const freshTask = await api('GET', `/tasks/${tasks.A1.id}`);
  const freshProject = await api('GET', `/projects/${A1.id}`);
  await api('POST', `/tasks/${tasks.A1.id}/moves`, { expectedVersion: freshTask.version, expectedBoardVersion: freshProject.boardVersion, status: 'review', beforeTaskId: null, afterTaskId: null });
  await header().selectOption(A1.id);
  await page.waitForURL(`${origin}/board?projectId=${A1.id}`);
  await main().getByRole('region', { name: 'Review', exact: true }).getByText('A1 seeded task').waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    const flags = new Set();
    window.__abaFlags = flags;
    const root = document.querySelector('main');
    new MutationObserver(() => {
      for (const lane of root.querySelectorAll('section[aria-label]')) {
        if (lane.getAttribute('aria-label') !== 'Review' && [...lane.querySelectorAll('article')].some((a) => a.textContent.includes('A1 seeded task'))) flags.add(`card in ${lane.getAttribute('aria-label')}`);
      }
      if (root.querySelector('[role="alert"]')) flags.add('alert');
    }).observe(root, { subtree: true, childList: true, characterData: true });
  });
  releaseAbaMove();
  await page.waitForTimeout(2000);
  await page.unroute(`**/api/collab/v1/tasks/${tasks.A1.id}/moves`);
  results.abaMove = {
    flags: await page.evaluate(() => [...window.__abaFlags]),
    inReview: await main().getByRole('region', { name: 'Review', exact: true }).getByText('A1 seeded task').count(),
  };

  step('A-B-A: an abandoned create success cannot close the new dialog');
  let releaseAbaCreate;
  const abaCreateGate = new Promise((resolve) => { releaseAbaCreate = resolve; });
  await page.route(`**/api/collab/v1/projects/${A1.id}/tasks`, async (route) => { if (route.request().method() === 'POST') await abaCreateGate; await route.continue(); });
  await main().getByRole('button', { name: 'New task' }).click();
  await dialog.getByPlaceholder('Title').fill('ABA late create');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  await header().selectOption(A1.id);
  await page.waitForURL(`${origin}/board?projectId=${A1.id}`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  await main().getByRole('button', { name: 'New task' }).click();
  await dialog.getByPlaceholder('Title').fill('Second dialog draft');
  releaseAbaCreate();
  await page.waitForTimeout(2000);
  await page.unroute(`**/api/collab/v1/projects/${A1.id}/tasks`);
  results.abaCreate = {
    dialogOpen: await dialog.count(),
    draft: (await dialog.count()) ? await dialog.getByPlaceholder('Title').inputValue() : null,
  };
  if (await dialog.count()) await dialog.getByRole('button', { name: 'Cancel' }).click();

  step('task detail has the header and switching leaves the task');
  await page.goto(`${origin}/tasks/${tasks.A1.id}`);
  await main().getByRole('heading', { name: 'A1 seeded task' }).waitFor({ timeout: 30000 });
  await page.waitForFunction((id) => document.querySelector('select[aria-label="Current project"]')?.value === id, A1.id, { timeout: 30000 });
  results.taskHeaderSynced = true;
  await shot('owner-task-detail');
  await header().selectOption(A2.id);
  await page.waitForURL(`${origin}/board?projectId=${A2.id}`);
  results.taskSwitchWentToBoard = true;

  step('attention filters by selection');
  attentionQueries.length = 0;
  await page.goto(`${origin}/attention`);
  await main().getByRole('heading', { name: 'Needs attention' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  results.attentionScoped = attentionQueries.includes(A2.id) && !attentionQueries.includes(null);
  attentionQueries.length = 0;
  await header().selectOption('');
  await page.waitForTimeout(1000);
  results.attentionAllAfterSwitch = attentionQueries.includes(null);

  step('late mark-read after a switch does not reload the old scope');
  await header().selectOption(A1.id);
  const attentionItem = main().locator('li', { hasText: 'A1 seeded task' });
  await attentionItem.waitFor({ timeout: 30000 });
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  await page.route(`**/api/collab/v1/tasks/${tasks.A1.id}/read-cursor`, async (route) => { await readGate; await route.continue(); });
  await attentionItem.getByRole('button', { name: 'Mark read' }).click();
  await header().selectOption(A2.id);
  await main().getByText('Nothing needs your attention right now.').waitFor({ timeout: 30000 });
  attentionQueries.length = 0;
  releaseRead();
  await page.waitForTimeout(2000);
  await page.unroute(`**/api/collab/v1/tasks/${tasks.A1.id}/read-cursor`);
  results.lateRead = {
    showsA1: await main().getByText('A1 seeded task').count(),
    oldScopeFetches: attentionQueries.filter((id) => id !== A2.id).length,
  };

  step('initial catalog failure on attention recovers');
  let failMe = true;
  await page.route('**/api/collab/v1/me', async (route) => { if (failMe) await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Temporarily unavailable.' } } }); else await route.continue(); });
  await page.goto(`${origin}/attention`);
  const meAlert = main().getByRole('alert').filter({ hasText: 'Could not load your projects' });
  const meErrorShown = await meAlert.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const retryShown = await main().getByRole('button', { name: 'Try again' }).count();
  failMe = false;
  if (await main().getByRole('button', { name: 'Try again' }).count()) await main().getByRole('button', { name: 'Try again' }).click();
  const recovered = await meAlert.waitFor({ state: 'detached', timeout: 30000 }).then(() => true, () => false);
  await page.unroute('**/api/collab/v1/me');
  await page.waitForTimeout(500);
  results.meFailure = { errorShown: meErrorShown, retryShown, recovered, headerEnabled: await header().isEnabled(), loadingOnly: (await main().innerText()).trim().endsWith('Loading…') };

  step('invalid saved selection');
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: savedKey(linked), value: randomUUID() });
  await page.goto(`${origin}/board`);
  await main().getByText('B1 seeded task').waitFor({ timeout: 30000 }).catch(() => {}); // recorded through showsAll below
  results.invalidSaved = {
    header: (await headerIs('')) ? '' : await header().inputValue(),
    showsAll: (await main().getByText('A1 seeded task').count()) > 0 && (await main().getByText('A2 seeded task').count()) > 0,
    cleared: await page.evaluate((key) => localStorage.getItem(key), savedKey(linked)),
  };

  step('narrow layout (owner)');
  await header().selectOption(B1.id);
  await page.setViewportSize({ width: 390, height: 844 });
  results.narrow = {};
  await page.goto(`${origin}/projects`);
  await header().waitFor({ timeout: 30000 });
  results.narrowNamedLinks = {
    projects: await page.locator('aside nav').getByRole('link', { name: 'Projects', exact: true }).count(),
    board: await page.locator('aside nav').getByRole('link', { name: 'Board', exact: true }).count(),
    labelsHidden: !(await page.locator('aside nav').getByText('Projects', { exact: true }).isVisible()),
  };
  for (const [name, path] of [['projects', '/projects'], ['detail', `/projects/${A1.id}`], ['board', `/board?projectId=${A1.id}`], ['task', `/tasks/${tasks.A1.id}`]]) {
    await page.goto(`${origin}${path}`);
    await header().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    results.narrow[name] = await noOverflow();
    await shot(`owner-${name}-narrow`);
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  step('account switch to collaborator');
  await page.goto(`${origin}/projects`);
  await header().selectOption(B1.id);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${origin}/login**`, { timeout: 30000 });
  await signIn(collaborator.email, collaborator.password);
  await header().waitFor({ timeout: 30000 });
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  results.collaborator = {
    headerValue: (await headerIs('')) ? '' : await header().inputValue(),
    headerGroups: await headerOptions(),
    boardShowsB1: await main().getByText('B1 seeded task').count(),
  };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: savedKey(collaboratorPrincipal), value: B1.id });
  await page.reload();
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  results.collaborator.foreignSavedIgnored = await headerIs('') && await main().getByText('B1 seeded task').count() === 0;
  await page.locator('aside nav').getByText('Projects', { exact: true }).click();
  await main().getByRole('link', { name: 'Project A1', exact: true }).waitFor({ timeout: 30000 });
  results.collaborator.list = await main().getByRole('link', { name: /^Project / }).allInnerTexts();
  results.collaborator.canCreate = await main().getByRole('button', { name: 'Create project' }).count();
  await main().getByRole('link', { name: 'Project A1', exact: true }).click();
  await main().getByText('Changed elsewhere').waitFor({ timeout: 30000 });
  results.collaborator.editButton = await main().getByRole('button', { name: 'Edit overview' }).count();
  results.collaborator.settingsLink = await main().getByRole('link', { name: 'Settings' }).count();
  results.collaborator.patchStatus = await page.evaluate(async (id) => (await fetch(`/api/collab/v1/projects/${id}/overview`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, description: 'collaborator write' }) })).status, A1.id);
  await shot('collaborator-project-detail');
  await page.goto(`${origin}/projects/${B1.id}`);
  await main().getByText('Project not found').waitFor({ timeout: 30000 });
  results.collaborator.foreignDetail = { notFound: true, leaksName: (await main().innerText()).includes('Project B1') };
  await page.goto(`${origin}/board?projectId=${A2.id}`);
  await main().getByText('A2 seeded task').waitFor({ timeout: 30000 });
  await main().getByText(/can't add tasks to Project A2/).waitFor({ timeout: 30000 });
  results.collaborator.readOnlyBoard = {
    newTask: await main().getByRole('button', { name: 'New task' }).count(),
    refusal: await main().getByText(/can't add tasks to Project A2/).count(),
  };
  await shot('collaborator-board-readonly');

  step('mounted project detail with a draft is cleared on revocation');
  await page.goto(`${origin}/projects/${A2.id}`);
  await main().getByRole('heading', { name: 'Project A2', level: 1 }).waitFor({ timeout: 30000 });
  await main().getByRole('button', { name: 'Edit overview' }).click();
  await main().getByLabel('Description', { exact: true }).fill('Collaborator draft before revocation');
  await api('DELETE', `/projects/${A2.id}/members/${collaboratorPrincipal.id}`);
  const detailCleared = await main().getByText('Project not found').waitFor({ timeout: 20000 }).then(() => true, () => false);
  results.collaborator.mountedRevocation = {
    detailCleared,
    draftGone: await main().getByLabel('Description', { exact: true }).count() === 0,
    header: await headerIs(''),
    headerListsA2: await header().evaluate((select) => [...select.options].some((o) => o.textContent === 'Project A2')),
  };
  await main().getByRole('link', { name: 'Projects', exact: true }).click();
  await page.waitForURL(`${origin}/projects`);
  await main().getByRole('link', { name: 'Project A1', exact: true }).waitFor({ timeout: 30000 });
  results.collaborator.mountedRevocation.listShowsA2 = await main().getByRole('link', { name: 'Project A2', exact: true }).count();

  step('revocation clears the saved selection');
  await page.goto(`${origin}/board`);
  await main().getByText('A1 seeded task').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  results.collaborator.afterRevocation = { header: (await headerIs('')) ? '' : await header().inputValue(), showsA2: await main().getByText('A2 seeded task').count() };
  results.pageErrors = pageErrors;
  results.badCollab = badCollab;
} catch (error) {
  await shot('failure').catch(() => {}); // diagnostics only; the original error is rethrown below
  console.log(JSON.stringify(results, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
}

console.log(JSON.stringify(results, null, 2));
assert.deepEqual(results.ownerList.groups, ['Client A', 'Client B']);
assert.deepEqual(results.ownerList.projects, ['Project A1', 'Project A2', 'Project B1']);
assert.deepEqual(results.ownerHeaderGroups.map((g) => g.label), ['Client A', 'Client B']);
assert.equal(results.detailHeaderFollowsRoute, true);
assert.equal(results.editPersistedAfterReload, true);
assert.deepEqual(results.rename, { header: true, list: true });
assert.deepEqual(results.workspaceLink, { header: true, showsA1: 0, dialog: ['Project B1'] });
assert.deepEqual(results.lateCreate, { shownOnA2: 0, createdInA1: true });
assert.deepEqual(results.lateMove, { loadedWhileMovePending: true, showsA1: 0, alerts: 0 });
assert.deepEqual(results.lateRead, { showsA1: 0, oldScopeFetches: 0 });
assert.deepEqual(results.authLoss, { draftAfter503: 'Draft kept through a 503', clearedOn403: true, draftGone: true, revivedBySave: 0 });
assert.deepEqual(results.history, {
  back1: { header: true, dialog: ['Project B1'] },
  forward: { header: true, dialog: ['Project A1'] },
  back2: { header: true, dialog: ['Project B1'] },
});
assert.deepEqual(results.abaMove, { flags: [], inReview: 1 });
assert.deepEqual(results.abaCreate, { dialogOpen: 1, draft: 'Second dialog draft' });
assert.deepEqual(results.meFailure, { errorShown: true, retryShown: 1, recovered: true, headerEnabled: true, loadingOnly: false });
assert.deepEqual(results.narrowNamedLinks, { projects: 1, board: 1, labelsHidden: true });
assert.deepEqual(results.collaborator.mountedRevocation, { detailCleared: true, draftGone: true, header: true, headerListsA2: false, listShowsA2: 0 });
assert.deepEqual(results.conflict, { shown: true, serverDescription: 'Changed elsewhere', name: 'Project A1', version: 1 });
assert.equal(results.lateResponseIgnored, true);
assert.deepEqual(results.boardUsesRemembered, { header: true, showsA1: 0 });
assert.deepEqual(results.boardAfterReload, { header: true, showsB1: 0 });
assert.deepEqual(results.deepLink, { header: true, showsA2: 0 });
assert.deepEqual(results.dialogProjects, ['Project A1']);
assert.equal(results.dialogClosedOnSwitch, true);
assert.deepEqual(results.dialogProjectsAfterSwitch, ['Project B1']);
assert.equal(results.createdTaskProject, true);
assert.equal(results.staleDraftCreated, false);
assert.equal(results.taskSwitchWentToBoard, true);
assert.equal(results.attentionScoped, true);
assert.equal(results.attentionAllAfterSwitch, true);
assert.deepEqual(results.invalidSaved, { header: '', showsAll: true, cleared: null });
assert.deepEqual(results.narrow, { projects: true, detail: true, board: true, task: true });
assert.equal(results.collaborator.headerValue, '');
assert.deepEqual(results.collaborator.headerGroups, [{ label: 'Client A', projects: ['Project A1', 'Project A2'] }]);
assert.equal(results.collaborator.boardShowsB1, 0);
assert.equal(results.collaborator.foreignSavedIgnored, true);
assert.deepEqual(results.collaborator.list, ['Project A1', 'Project A2']);
assert.equal(results.collaborator.canCreate, 0);
assert.equal(results.collaborator.editButton, 0);
assert.equal(results.collaborator.settingsLink, 0);
assert.equal(results.collaborator.patchStatus, 403);
assert.deepEqual(results.collaborator.foreignDetail, { notFound: true, leaksName: false });
assert.deepEqual(results.collaborator.readOnlyBoard, { newTask: 0, refusal: 1 });
assert.deepEqual(results.collaborator.afterRevocation, { header: '', showsA2: 0 });
assert.deepEqual(results.pageErrors, []);
const expectedBad = [
  `PATCH /api/collab/v1/projects/${A1.id}/overview 409`,
  `PATCH /api/collab/v1/projects/${A1.id}/overview 403`,
  `GET /api/collab/v1/projects/${B1.id} 404`,
  'GET /api/collab/v1/me 503',
  'GET /api/collab/v1/me 403',
  `POST /api/collab/v1/tasks/${tasks.A1.id}/moves 500`,
];
assert.deepEqual(results.badCollab.filter((entry) => !expectedBad.includes(entry)), []);
console.log('projects actual browser: PASS');
process.exit(0);
