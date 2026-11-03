// Password sign-in view parity against a real dashboard, NextAuth, mounted
// Express createApp() collaboration API and PostgreSQL. No HTTP mocks.
// Resets and seeds ONLY the dedicated database in FF_VIEW_PARITY_DATABASE_URL,
// serves the API on FF_VIEW_PARITY_API_PORT, then signs in through the normal
// login form of an already running dashboard at FF_UI_TEST_ORIGIN.
// GitHub OAuth is not performed here; OAuth/password equality is covered by
// view-parity.test.tsx using the real callbacks.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Preflight runs before any database import or connection. This script drops
// the schema, so only names that are clearly disposable test databases pass.
const databaseUrl = process.env.FF_VIEW_PARITY_DATABASE_URL;
if (!databaseUrl) throw new Error('FF_VIEW_PARITY_DATABASE_URL is required');
const parsedDatabaseUrl = new URL(databaseUrl);
// pg accepts target overrides in query parameters and gives socket: a different
// database meaning. Keep the validated URL identical to the connection target.
if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) || databaseUrl.includes('?') || databaseUrl.includes('#')) {
  console.error('view-parity: refusing database URL; use postgres:// or postgresql:// without query parameters or fragments');
  process.exit(2);
}
const dbName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!/^ff_[a-z0-9_]+_test$/.test(dbName) || /(^|_)(demo|prod|production)(_|$)/.test(dbName)) {
  console.error(`view-parity: refusing to reset database "${dbName}"; use a dedicated ff_*_test database`);
  process.exit(2);
}
const authSecret = process.env.FF_COLLAB_AUTH_SECRET;
if (!authSecret || authSecret.length < 32) throw new Error('FF_COLLAB_AUTH_SECRET (same value as the dashboard) is required');

const { assertDedicatedCollabTestDatabaseUrl, resetCollabSchema } = await import('../../../db/tests/helpers/collab-db.ts');
assertDedicatedCollabTestDatabaseUrl(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL ??= 'warn';
const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3190';
const apiPort = Number(process.env.FF_VIEW_PARITY_API_PORT ?? 3191);
const shots = process.env.FF_VIEW_PARITY_SCREENSHOT_DIR;
const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);

await resetCollabSchema(databaseUrl);
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { chromium } = await import('@playwright/test');
await db.runMigrations();

const owner = { email: 'owner+pw@example.test', login: 'parity-owner', password: `owner-${randomBytes(12).toString('hex')}` };
const external = { email: 'external@example.test', name: 'External Collaborator', password: `external-${randomBytes(12).toString('hex')}` };
const names = { workspace: 'Parity Client', project: 'Parity Project', task: 'Parity seeded task' };
const pool = db.getPool();

await pool.query(`INSERT INTO orgs (id, name) VALUES ('parity-org', 'Parity Org')`);
const { rows: [user] } = await pool.query(
  `INSERT INTO users (github_id, login, email, avatar_url) VALUES (424242, $1, 'owner@example.test', NULL) RETURNING id`,
  [owner.login],
);
await pool.query(`INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, 'parity-org', 'admin')`, [user.id]);
// Same principal a GitHub sign-in materializes; the password is provisioned for it directly.
const linked = await db.ensureGithubPrincipal({ legacyUserId: user.id, displayName: 'Owner via password', email: owner.email });
await pool.query('INSERT INTO collab_password_credentials (principal_id, password_hash) VALUES ($1, $2)', [linked.id, await db.hashPassword(owner.password)]);
// FK semantics: a linked legacy user cannot be deleted out from under its principal.
await assert.rejects(pool.query('DELETE FROM users WHERE id = $1', [user.id]), (e) => e.code === '23503');

const actor = { principalId: linked.id, sessionVersion: linked.sessionVersion };
const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: 'parity-org', name: names.workspace, idempotencyKey: 'view-parity-workspace' });
const project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: names.project });
await db.createCollabTask({ actor, projectId: project.id, title: names.task });

process.env.FF_COLLAB_AUTH_SECRET = authSecret;
const server = createApp().listen(apiPort, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const apiBase = `http://127.0.0.1:${apiPort}/api/collab/v1`;
async function api(method, path, body) {
  const headers = { 'x-fluent-flow-actor': db.signCollaborationActor(actor, authSecret), ...(body ? { 'content-type': 'application/json' } : {}) };
  const response = await fetch(`${apiBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json();
  assert.ok(response.ok, `${method} ${path} -> ${response.status}`);
  return json.data;
}
// External collaborator joins the project through the real invitation flow.
const role = await api('POST', `/workspaces/${workspace.id}/roles`, { name: 'Parity viewer', capabilities: ['task.read'] });
const invitation = await api('POST', `/projects/${project.id}/invitations`, { email: external.email, roleId: role.id, expiresInHours: 1 });
const accepted = await fetch(`${apiBase}/invitations/accept`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: invitation.url.split('token=')[1], displayName: external.name, password: external.password }),
});
assert.equal(accepted.status, 201, 'invitation accept');

const NAV = ['Board', 'Needs attention', 'Agents', 'Repos', 'Pipelines', 'Settings'];
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results = {};

async function signIn(email, password) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const badCollab = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/collab/v1') && r.status() >= 400) badCollab.push(`${r.request().method()} ${path} ${r.status()}`);
  });
  await page.goto(`${origin}/login?callbackUrl=/board`);
  await page.getByPlaceholder('Email', { exact: true }).fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/board`, { timeout: 30000 });
  await page.getByText(names.task, { exact: true }).waitFor({ timeout: 30000 });
  const nav = page.locator('aside nav');
  const visibleNav = [];
  for (const label of NAV) if (await nav.getByText(label, { exact: true }).count()) visibleNav.push(label);
  const session = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
  return {
    context, page, pageErrors, badCollab, visibleNav,
    topBar: await page.locator('header').innerText(),
    scope: { idIsNumber: typeof session.user.id === 'number', login: session.user.login, isSuperadmin: session.user.isSuperadmin, orgIds: session.user.orgs.map((o) => o.org_id) },
  };
}

async function finalText(page) {
  const text = await page.locator('main').innerText();
  return { configurationError: text.includes('Configuration error'), loadingOnly: text.trim() === 'Loading…' || text.trim() === 'Loading...' };
}

try {
  const o = await signIn(owner.email, owner.password);
  if (shots) { mkdirSync(shots, { recursive: true }); await o.page.screenshot({ path: `${shots}/linkedOwner-board.png` }); }
  await o.page.locator('aside nav').getByText('Settings', { exact: true }).click();
  await o.page.waitForURL(`${origin}/settings`, { timeout: 30000 });
  await o.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ timeout: 30000 });
  const workspaces = o.page.getByRole('region', { name: 'Client workspaces', exact: true });
  await workspaces.getByText(names.workspace, { exact: true }).waitFor({ timeout: 30000 });
  await o.page.getByRole('combobox', { name: 'Settings scope', exact: true }).selectOption(`project:${project.id}`);
  const members = o.page.getByRole('region', { name: 'Members', exact: true });
  await members.getByText(external.name).first().waitFor({ timeout: 30000 });
  if (shots) await o.page.screenshot({ path: `${shots}/linkedOwner-settings.png`, fullPage: true });
  results.linkedOwner = {
    visibleNav: o.visibleNav, scope: o.scope,
    topBarShowsLoginAndOrg: o.topBar.includes(owner.login) && o.topBar.includes('parity-org'),
    boardShowedSeededTask: true, settingsShowedWorkspace: true, settingsShowedProjectMember: true,
    settingsFinal: await finalText(o.page), pageErrors: o.pageErrors, badCollabResponses: o.badCollab,
  };
  await o.context.close();

  const x = await signIn(external.email, external.password);
  if (shots) await x.page.screenshot({ path: `${shots}/external-board.png` });
  const boardFinal = await finalText(x.page);
  await x.page.goto(`${origin}/agents`);
  await x.page.waitForURL(`${origin}/board`, { timeout: 30000 });
  results.external = {
    visibleNav: x.visibleNav, scope: x.scope,
    topBarShowsOrg: x.topBar.includes('parity-org'),
    boardShowedSeededTask: true, boardFinal, agentsRedirectedToBoard: true,
    pageErrors: x.pageErrors, badCollabResponses: x.badCollab,
  };
  await x.context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
}

console.log(JSON.stringify(results, null, 2));
const clean = { configurationError: false, loadingOnly: false };
assert.deepEqual(results.linkedOwner.visibleNav, NAV);
assert.deepEqual(results.linkedOwner.scope, { idIsNumber: true, login: owner.login, isSuperadmin: false, orgIds: ['parity-org'] });
assert.equal(results.linkedOwner.topBarShowsLoginAndOrg, true);
assert.deepEqual(results.linkedOwner.settingsFinal, clean);
assert.deepEqual(results.linkedOwner.pageErrors, []);
assert.deepEqual(results.linkedOwner.badCollabResponses, []);
assert.deepEqual(results.external.visibleNav, ['Board', 'Needs attention']);
assert.deepEqual(results.external.scope, { idIsNumber: false, login: external.name, isSuperadmin: false, orgIds: [] });
assert.equal(results.external.topBarShowsOrg, false);
assert.deepEqual(results.external.boardFinal, clean);
assert.deepEqual(results.external.pageErrors, []);
assert.deepEqual(results.external.badCollabResponses, []);
console.log('view parity browser smoke: PASS');
process.exit(0);
