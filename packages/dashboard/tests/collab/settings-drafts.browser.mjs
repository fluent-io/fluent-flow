import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';

const fixturePath = process.env.FF_SETTINGS_BROWSER_FIXTURE_PATH;
if (!fixturePath) throw new Error('FF_SETTINGS_BROWSER_FIXTURE_PATH is required');
assert.equal(statSync(fixturePath).mode & 0o077, 0, 'fixture credentials must be private');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const parsed = new URL(fixture.databaseUrl);
const dbName = parsed.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/^ff_[a-z0-9_]+_test$/.test(dbName) || /(^|_)(demo|prod|production)(_|$)/.test(dbName)) {
  console.error('settings-drafts: refusing fixture database; use a loopback ff_*_test database');
  process.exit(2);
}
process.env.DATABASE_URL = fixture.databaseUrl;
process.env.FF_COLLAB_AUTH_SECRET = fixture.authSecret;
process.env.LOG_LEVEL ??= 'warn';
const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3192';
const apiPort = Number(process.env.FF_SETTINGS_DRAFTS_API_PORT ?? 3193);
const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);

const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { chromium } = await import('@playwright/test');
const server = createApp().listen(apiPort, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const { rows: [ownerRow] } = await db.getPool().query('SELECT id, session_version FROM collab_principals WHERE email=$1', [fixture.emails.legacyAdmin]);
const owner = { principalId: ownerRow.id, sessionVersion: ownerRow.session_version };
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/collab/v1${path}`, {
    method,
    headers: { 'x-fluent-flow-actor': db.signCollaborationActor(owner, fixture.authSecret), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path} -> ${response.status}`);
  return text ? JSON.parse(text).data : null;
}
async function savedProject() {
  const me = await api('GET', '/me');
  return me.workspaces.flatMap((w) => w.projects).find((p) => p.id === fixture.projectId);
}

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const pageErrors = [];
const patchStatuses = [];
let meResponses = 0;
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => {
  const path = new URL(r.url()).pathname;
  if (path === '/api/collab/v1/me' && r.ok()) meResponses++;
  if (path === `/api/collab/v1/projects/${fixture.projectId}` && r.request().method() === 'PATCH') patchStatuses.push(r.status());
});
const step = (name) => console.error(`settings-drafts: ${name}`);
const results = {};
async function catalogPolls(count) {
  const target = meResponses + count;
  await page.waitForFunction(() => true, null, { timeout: 1000 });
  const deadline = Date.now() + 30000;
  while (meResponses < target && Date.now() < deadline) await page.waitForTimeout(250);
  return meResponses >= target;
}

try {
  step('sign in as the execution configuration admin');
  await page.goto(`${origin}/login?callbackUrl=/settings`);
  await page.getByPlaceholder('Email', { exact: true }).fill(fixture.emails.config);
  await page.getByPlaceholder('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/settings`);
  await page.getByRole('combobox', { name: 'Settings scope' }).selectOption(`project:${fixture.projectId}`);
  const execution = page.getByRole('region', { name: 'Execution defaults', exact: true });
  const instructions = execution.getByLabel('Default instructions', { exact: true });
  await instructions.waitFor({ timeout: 30000 });
  const original = await instructions.inputValue();

  step('dirty draft survives unchanged catalog polls');
  await instructions.fill('Unsaved draft kept through polling');
  results.pollsObserved = await catalogPolls(2);
  results.draftAfterUnchangedPolls = await instructions.inputValue();

  step('competing writer updates the saved defaults');
  const before = await savedProject();
  await api('PATCH', `/projects/${fixture.projectId}`, { expectedVersion: before.version, executionDefaults: { ...before.executionDefaults, instructions: 'Competing writer instructions' } });
  results.pollsAfterCompetingWrite = await catalogPolls(2);
  results.draftAfterCompetingWrite = await instructions.inputValue();

  step('saving the old-base draft is refused');
  await execution.getByRole('button', { name: 'Save defaults', exact: true }).click();
  await page.waitForTimeout(1500);
  results.saveStatuses = [...patchStatuses];
  results.conflictShown = await execution.getByRole('alert').filter({ hasText: 'changed' }).count() > 0;
  results.serverInstructionsAfterSave = (await savedProject()).executionDefaults.instructions;

  step('explicit reload shows the competing values, then a fresh save works');
  const reloadButton = execution.getByRole('button', { name: 'Reload defaults', exact: true });
  results.reloadOffered = await reloadButton.count() > 0;
  if (results.reloadOffered) {
    await reloadButton.click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Default instructions"]')?.value === 'Competing writer instructions', null, { timeout: 10000 }).catch(() => {}); // recorded below
    results.afterReload = await instructions.inputValue();
    await instructions.fill('Saved after explicit reload');
    const saved = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === `/api/collab/v1/projects/${fixture.projectId}` && r.request().method() === 'PATCH'),
      execution.getByRole('button', { name: 'Save defaults', exact: true }).click(),
    ]);
    results.freshSaveStatus = saved[0].status();
    await catalogPolls(1);
    results.afterFreshSave = { field: await instructions.inputValue(), server: (await savedProject()).executionDefaults.instructions };
  }
  results.originalWasDifferent = original !== 'Unsaved draft kept through polling';
  results.pageErrors = pageErrors;
} catch (error) {
  console.log(JSON.stringify(results, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
}

console.log(JSON.stringify(results, null, 2));
assert.equal(results.pollsObserved, true);
assert.equal(results.draftAfterUnchangedPolls, 'Unsaved draft kept through polling');
assert.equal(results.pollsAfterCompetingWrite, true);
assert.equal(results.draftAfterCompetingWrite, 'Unsaved draft kept through polling');
assert.deepEqual(results.saveStatuses, [409]);
assert.equal(results.conflictShown, true);
assert.equal(results.serverInstructionsAfterSave, 'Competing writer instructions');
assert.equal(results.reloadOffered, true);
assert.equal(results.afterReload, 'Competing writer instructions');
assert.equal(results.freshSaveStatus, 200);
assert.deepEqual(results.afterFreshSave, { field: 'Saved after explicit reload', server: 'Saved after explicit reload' });
assert.deepEqual(results.pageErrors, []);
console.log('settings drafts browser: PASS');
process.exit(0);
