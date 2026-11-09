import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const statePath = process.env.PREVIEW_UAT_STATE;
const screenshotDir = process.env.PREVIEW_UAT_SCREENSHOTS;
const origin = process.env.PREVIEW_UAT_ORIGIN;
const apiOrigin = process.env.PREVIEW_UAT_API_ORIGIN;
if (!statePath || !screenshotDir || !origin || !apiOrigin) throw new Error('Preview UAT environment is incomplete');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const executablePath = process.env.PREVIEW_UAT_CHROMIUM ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
const runnerCli = new URL('../packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js', import.meta.url).pathname;
const fakeAgent = new URL('../packages/fluent-flow-agent-server/tests/unit/fake-acp-agent.js', import.meta.url).pathname;
const runnerCwd = mkdtempSync(join(tmpdir(), 'ff-preview-uat-'));
const marker = join(runnerCwd, '.claim-browser-follow-up-queued');
mkdirSync(screenshotDir, { recursive: true });

let browser;
let runner;
let runnerExit;
let runnerStderr = '';
const pageErrors = [];
const badResponses = [];

function redact(value) {
  return String(value).replaceAll(state.password, '[REDACTED]').replaceAll(state.token, '[REDACTED]');
}

async function shot(page, name) {
  await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
}

async function stopRunner() {
  if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
  runner.kill('SIGTERM');
  const result = await Promise.race([
    runnerExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  if (result === null && runner.exitCode === null && runner.signalCode === null) {
    runner.kill('SIGKILL');
    await runnerExit;
  }
}

function launchRunner() {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  env.FAKE_ACP_SCENARIO = 'claim-browser-uat';
  env.LOG_LEVEL = 'warn';
  runner = spawn(process.execPath, [
    runnerCli,
    '--server', apiOrigin,
    '--token', state.token,
    '--acp-command', process.execPath,
    '--acp-arg', fakeAgent,
    '--cwd', runnerCwd,
  ], {
    cwd: runnerCwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  runner.stderr.on('data', (chunk) => {
    runnerStderr = `${runnerStderr}${chunk.toString('utf8')}`.slice(-16 * 1024);
  });
  runnerExit = new Promise((resolve) => {
    runner.once('exit', (code, signal) => resolve({ code, signal }));
    runner.once('error', (error) => resolve({ error }));
  });
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname.endsWith('preview.fluentflow.tech') && response.status() >= 400) {
      badResponses.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    }
  });

  const taskUrl = `${origin}/tasks/${state.taskId}`;
  await page.goto(`${origin}/login?callbackUrl=${encodeURIComponent(`/tasks/${state.taskId}`)}`);
  await page.getByPlaceholder('Email', { exact: true }).fill(state.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(state.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(taskUrl, { timeout: 30_000 });
  await page.getByText(state.taskTitle, { exact: true }).waitFor({ timeout: 30_000 });
  await shot(page, '00-authenticated-task');

  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start execution', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start execution', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start execution', exact: true });
  await start.getByLabel('Phase', { exact: true }).selectOption('spec');
  await start.getByLabel('Repository', { exact: true }).fill(state.repo);
  await start.getByLabel('Instructions', { exact: true }).fill('Exercise the deployed preview runner and interaction path.');
  const startResponse = page.waitForResponse((response) => response.url().includes(`/api/collab/v1/tasks/${state.taskId}/claim-executions`) && response.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  assert.equal((await startResponse).status(), 202);

  const detail = page.getByRole('region', { name: 'Execution detail', exact: true });
  await expect(detail.locator('[data-claim-status]')).toHaveText('Pending', { timeout: 30_000 });
  await shot(page, '01-claim-queued');
  launchRunner();

  await expect(detail.getByText('Deterministic claim execution started.', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(detail.getByText('Allow deterministic UAT action?', { exact: true })).toBeVisible({ timeout: 30_000 });
  await shot(page, '02-runner-streaming-permission');

  const permissionResponse = page.waitForResponse((response) => response.url().endsWith('/commands') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Allow once', exact: true }).click();
  assert.ok([200, 202].includes((await permissionResponse).status()));
  await expect(detail.getByText('Resolved', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText('Choose a deterministic value.', { exact: true })).toBeVisible({ timeout: 10_000 });

  await detail.getByLabel('Choice', { exact: true }).fill('preview-uat');
  const elicitationResponse = page.waitForResponse((response) => response.url().endsWith('/commands') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Accept response', exact: true }).click();
  assert.ok([200, 202].includes((await elicitationResponse).status()));
  await shot(page, '03-permission-and-elicitation-resolved');

  await detail.getByLabel('Prompt', { exact: true }).fill('Continue with the deployed preview follow-up.');
  const promptResponse = page.waitForResponse((response) => response.url().endsWith('/commands') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Send prompt', exact: true }).click();
  assert.ok([200, 202].includes((await promptResponse).status()));
  writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
  await expect(detail.getByText('Follow-up ACP turn is running.', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByText(state.taskTitle, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Execution', exact: true }).click();
  const refreshed = page.getByRole('region', { name: 'Execution detail', exact: true });
  await expect(refreshed.getByText('Deterministic claim execution started.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(refreshed.getByText('Follow-up ACP turn is running.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await shot(page, '04-persisted-execution-history');

  const cancelResponse = page.waitForResponse((response) => response.url().endsWith('/commands') && response.request().method() === 'POST');
  await refreshed.getByRole('button', { name: 'Cancel execution', exact: true }).click();
  assert.ok([200, 202].includes((await cancelResponse).status()));
  await expect(refreshed.locator('[data-claim-status]')).toHaveText('Cancelled', { timeout: 30_000 });
  await shot(page, '05-cancelled-execution');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Collapse', { exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot(page, '06-mobile-cancelled-execution');

  assert.deepEqual(pageErrors, []);
  const ignored = badResponses.filter((entry) => !entry.endsWith(' 404'));
  assert.deepEqual(ignored, []);
  writeFileSync(join(screenshotDir, 'browser-result.json'), `${JSON.stringify({
    authenticated: true,
    queued: true,
    runnerConnected: true,
    permissionAnswered: true,
    elicitationAnswered: true,
    followUpPersisted: true,
    cancelled: true,
    responsive: true,
  }, null, 2)}\n`);
} catch (error) {
  const detail = runnerStderr ? `\nRunner stderr:\n${redact(runnerStderr)}` : '';
  throw new Error(`${redact(error.stack ?? error.message)}${detail}`);
} finally {
  await stopRunner();
  await browser?.close();
  rmSync(runnerCwd, { recursive: true, force: true });
}
