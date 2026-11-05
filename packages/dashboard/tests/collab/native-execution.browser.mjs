import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = process.env.FF_UI_TEST_ORIGIN ?? 'http://127.0.0.1:3100';
const ids = {
  task: '11111111-1111-4111-8111-111111111111', project: '22222222-2222-4222-8222-222222222222', workspace: '33333333-3333-4333-8333-333333333333',
  principal: '44444444-4444-4444-8444-444444444444', run: '55555555-5555-4555-8555-555555555555', session: '66666666-6666-4666-8666-666666666666',
  host: '77777777-7777-4777-8777-777777777777', mapping: '88888888-8888-4888-8888-888888888888',
};
const now = new Date().toISOString();
const queuedAt = new Date(Date.now() - 90_000).toISOString();
const FIXTURE_PATH = '/home/owner/.codex/config.toml';
const FIXTURE_TOKEN = 'sk-fixture-9f8e7d6c';
const COPY = {
  signIn: 'Sign in to the selected tool on the execution host, then try again.',
  unavailable: 'This execution profile is unavailable. Contact the execution host owner.',
  slot: 'Waiting for an execution slot.',
  reconciling: 'Execution status is uncertain. Review recovery before continuing.',
  disabled: 'This run requires an integration that is not enabled.',
  host: 'Answer this request on the execution host.',
};
const INTERNAL = ['task.read', 'task.write', 'internal.read', 'run.start', 'run.steer', 'run.cancel', 'project.admin'];
const START_ONLY = ['task.read', 'run.start'];

const profiles = [
  { id: 'cc-main', name: 'Claude main', provider: null, model: 'claude-opus-5-5', modeId: null, thinkingOptionId: null, backend: 'claude-code', readiness: { state: 'ready' }, policy: { permissionMode: 'default' } },
  { id: 'cc-login', name: 'Claude review', provider: null, model: 'claude-sonnet-5-5', modeId: null, thinkingOptionId: null, backend: 'claude-code', readiness: { state: 'sign_in_required' }, policy: null },
  { id: 'cx-main', name: 'Codex main', provider: null, model: 'gpt-codex', modeId: null, thinkingOptionId: null, backend: 'codex', readiness: { state: 'not_installed' }, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false } },
  { id: 'legacy', name: 'Paseo agent', provider: 'claude', model: null, modeId: null, thinkingOptionId: null, backend: 'paseo', readiness: null, policy: null },
];
const mapping = {
  id: ids.mapping, projectId: ids.project, hostId: ids.host, repositoryKey: 'org/repo', baseRef: null, profileIds: profiles.map((p) => p.id), defaultProfileId: 'cc-main',
  hostName: 'Build box', hostReachability: 'online', hostLastSeenAt: now, profiles, allowedModels: null,
  capacity: { 'claude-code': { limit: 1, available: 0, observedAt: now }, codex: { limit: 1, available: null, observedAt: null } },
};
const fullRun = () => ({
  id: ids.run, taskId: ids.task, projectId: ids.project, hostId: ids.host, mappingId: ids.mapping, profileId: 'cx-main', model: 'gpt-codex', instructions: '',
  state: state.runState, stage: 'development', version: 1, workspaceId: 'wks_fixture', lastObservedAt: now, headCommit: null, retryOfRunId: null,
  errorCode: state.runError, createdAt: now, updatedAt: now, hostName: 'Build box', hostReachability: 'online', hostLastSeenAt: now,
});
const badgeRun = () => ({ id: ids.run, taskId: ids.task, state: state.runState, stage: 'development', hostName: 'Build box', hostReachability: 'online', hostLastSeenAt: now, lastObservedAt: now });
const execution = { backend: 'codex', profileId: 'cx-main', model: 'gpt-codex', harness: { name: 'codex', version: '0.162.1' }, policy: { approvalPolicy: 'on-request', configPath: FIXTURE_PATH, apiKey: FIXTURE_TOKEN } };
const session = () => ({ id: ids.session, runId: ids.run, role: 'work', title: 'Work session', state: state.sessionState, lastObservedAt: now, paseoAgentId: null, providerSessionId: null, capabilities: {} });
const base = { inputSchema: null, expiresAt: null, observedAt: now };
const duplicate = {
  ...base, requestId: 'a'.repeat(32), kind: 'question', backend: 'claude-code', generation: 3, fingerprint: 'b'.repeat(64), promptText: 'Which secret?', hostOnly: false,
  choices: [{ id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
  questions: [{ id: 'q0', header: 'Secret', question: 'Which value?', options: [{ id: 'o0', label: '[redacted]', description: null }, { id: 'o1', label: '[redacted]', description: null }], multiSelect: false, allowOther: false, secret: false }],
};
const hostOnly = {
  ...base, requestId: 'c'.repeat(32), kind: 'question', backend: 'codex', generation: 2, fingerprint: 'd'.repeat(64), promptText: 'Paste the token', hostOnly: true,
  choices: [{ id: 'decline', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
  questions: [{ id: 'token', header: 'Token', question: 'Paste the token', options: null, multiSelect: false, allowOther: true, secret: true }],
};
const historyOnly = [
  { eventId: 'history-native', kind: 'attention', observedAt: now, payload: { attention: 'permission', requestId: 'history-native-request', choices: [{ id: 'allow_once', label: 'Allow once', behavior: 'allow' }], state: 'pending' } },
];

const state = { caps: INTERNAL, runState: 'queued', runError: null, queue: { queuedAt, reason: 'capacity' }, pending: [], timeline: [], loseCommands: false, loseStart: false, sessionState: 'needs_input' };
const commandKeys = [];
const commands = [];
const startPosts = [];
const storedRecoveryCommands = new Map();
let queueRecoveryPrompts = false;
const seenPaths = new Set();

const executablePath = process.env.FF_UI_TEST_CHROMIUM_PATH ?? (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

async function openPage() {
  const page = await browser.newPage();
  const unhandled = [];
  page.on('pageerror', (error) => unhandled.push(error.message));
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: { user: { id: null, principalId: ids.principal, sessionVersion: 1, login: 'Fixture operator', email: null, image: null, orgs: [], isSuperadmin: false }, expires: new Date(Date.now() + 3600000).toISOString() } }));
  await page.route('**/api/collab/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/collab/v1', '');
    const method = route.request().method();
    seenPaths.add(`${method} ${path}`);
    const internal = state.caps.includes('internal.read');
    const json = (data, extra = {}) => route.fulfill({ json: { data, nextCursor: null, ...extra } });
    if (path === '/me') {
      return json({
        principal: { id: ids.principal, displayName: 'Fixture operator', email: null, legacyUserId: null, disabledAt: null, sessionVersion: 1 },
        workspaces: [{ id: ids.workspace, name: 'Fixture client', projects: [{ id: ids.project, workspaceId: ids.workspace, name: 'Fixture project', version: 1, boardVersion: 1, executionDefaults: internal ? { mappingId: ids.mapping, profileId: 'cc-main', model: null, instructions: '' } : null }] }],
        capabilities: { [ids.project]: state.caps }, workspaceCapabilities: { [ids.workspace]: [] }, bootstrap: { eligible: internal, legacyOrgIds: [] },
      });
    }
    if (path === `/tasks/${ids.task}`) {
      const run = internal ? fullRun() : badgeRun();
      return json({ id: ids.task, projectId: ids.project, title: 'Native execution', description: '', status: 'in_progress', priority: 'normal', assigneeId: null, version: 1, position: '1000', blockedReason: null, createdAt: now, updatedAt: now, capabilities: state.caps, execution: { latestRun: run, hostReachability: 'online', progress: null, attentionCount: 0 } });
    }
    if (path === `/tasks/${ids.task}/runs` && method === 'POST') {
      startPosts.push(route.request().postDataJSON());
      if (state.loseStart) return route.abort('failed');
      return route.fulfill({ status: 201, json: { data: fullRun() } });
    }
    if (path === `/tasks/${ids.task}/runs`) return json([internal ? fullRun() : badgeRun()]);
    if (path === `/runs/${ids.run}`) {
      return internal
        ? json({ run: fullRun(), execution, sessions: [session()], unresolvedCommands: [], queue: state.queue })
        : json({ run: badgeRun(), execution: null, sessions: [], unresolvedCommands: [], queue: state.queue });
    }
    if (!internal && (path.startsWith('/sessions/') || path.includes('/mappings') || path.startsWith('/hosts'))) {
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } });
    }
    if (path === `/projects/${ids.project}/mappings`) return json([mapping]);
    if (path === '/hosts') return json([{ id: ids.host, name: 'Build box', reachability: 'online', lastHeartbeatAt: now, revokedAt: null }]);
    if (path === `/hosts/${ids.host}/catalog`) return json({ hostId: ids.host, repositories: [{ key: 'org/repo' }], profiles, capacity: mapping.capacity });
    if (path === `/projects/${ids.project}/insights`) {
      return json({ range: { from: now, to: now }, tasks: { createdCount: 1, acceptedCount: 0 }, runs: { totalCount: 1, failedCount: 0 }, usage: { available: true, reason: null, tokensIn: null, tokensOut: 1200, costUsd: null, coverage: { samples: 1, tokensIn: 0, tokensOut: 1, costUsd: 0 } } });
    }
    if (path === `/sessions/${ids.session}/pending-requests`) return json(state.pending);
    if (path === `/sessions/${ids.session}/timeline`) return json(url.searchParams.has('cursor') ? state.timeline : [{ eventId: 'first-output', kind: 'timeline', payload: { text: 'Recorded execution output' }, observedAt: now }], { cursor: 'fixture-watermark' });
    if (path === `/sessions/${ids.session}/commands` && method === 'POST') {
      commands.push(route.request().postDataJSON());
      commandKeys.push(route.request().headers()['idempotency-key'] ?? null);
      if (queueRecoveryPrompts && commands.at(-1).kind === 'prompt') {
        const key = commandKeys.at(-1);
        const created = !storedRecoveryCommands.has(key);
        if (created) storedRecoveryCommands.set(key, commands.at(-1));
        state.runState = 'queued';
        state.sessionState = 'queued';
        state.queue = { queuedAt, reason: 'capacity' };
        if (state.loseCommands) return route.abort('failed');
        return route.fulfill({ status: 202, json: { data: { commandId: '99999999-9999-4999-8999-999999999999', created } } });
      }
      if (state.loseCommands) return route.abort('failed');
      return route.fulfill({ status: 202, json: { data: { commandId: '99999999-9999-4999-8999-999999999999', created: true } } });
    }
    return json([]);
  });
  return { page, unhandled };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (locator) => locator.waitFor({ state: 'visible', timeout: 15000 });
const until = async (predicate, message, tries = 80) => {
  for (let i = 0; i < tries; i++) { if (await predicate()) return; await wait(100); }
  assert.fail(message);
};
const scenarios = [];

try {
  {
    const { page, unhandled } = await openPage();
    await page.goto(`${origin}/settings?projectId=${ids.project}`);
    const claude = page.locator('[data-backend="claude-code"]').first();
    const codex = page.locator('[data-backend="codex"]').first();
    const paseo = page.locator('[data-backend="paseo"]').first();
    await visible(claude);
    const claudeText = await claude.innerText();
    assert.match(claudeText, /Claude Code/);
    assert.match(await claude.locator('[data-profile-id="cc-main"]').innerText(), /Ready/);
    assert.match(await claude.locator('[data-profile-id="cc-login"]').innerText(), /Sign-in needed/);
    assert.ok(claudeText.includes(COPY.signIn));
    assert.ok(claudeText.includes('Capacity: 1 slot, 0 available'));
    const codexText = await codex.innerText();
    assert.match(codexText, /Tool not installed/);
    assert.ok(codexText.includes(COPY.unavailable));
    assert.ok(codexText.includes('Capacity: 1 slot, availability unknown'));
    const paseoText = await paseo.innerText();
    assert.match(paseoText, /Paseo agent/);
    assert.doesNotMatch(paseoText, /Ready|Capacity/);
    await visible(page.getByText('in Unavailable', { exact: false }));
    assert.match(await page.getByLabel('Project insights').innerText(), /Estimated cost: Unavailable/);
    const html = await page.content();
    assert.ok(!html.includes(FIXTURE_PATH) && !html.includes(FIXTURE_TOKEN));
    assert.equal(unhandled.length, 0, unhandled.join(';'));
    await page.close();
    scenarios.push('settings: profiles grouped by backend, readiness labels/messages, read-only capacity, Unavailable usage, estimated cost');
  }

  {
    const { page, unhandled } = await openPage();
    await page.goto(`${origin}/tasks/${ids.task}`);
    await page.getByRole('button', { name: 'Execution', exact: true }).click();
    await page.getByRole('button', { name: 'Start AI work', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Start AI work' });
    await visible(dialog.getByText('Backend: Claude Code'));
    assert.match(await dialog.innerText(), /Model: claude-opus-5-5/);
    assert.match(await dialog.innerText(), /Policy: permission mode default/);
    await dialog.getByLabel('Agent profile').selectOption('cc-login');
    await visible(dialog.getByText('Sign-in needed'));
    assert.ok((await dialog.innerText()).includes(COPY.signIn));
    assert.equal(await dialog.getByRole('button', { name: 'Queue run' }).isDisabled(), true, 'a non-ready profile can be queued');
    await dialog.getByLabel('Agent profile').selectOption('cc-main');
    state.loseStart = true;
    await dialog.getByRole('button', { name: 'Queue run' }).click();
    await visible(dialog.getByRole('alert'));
    assert.equal(await dialog.count(), 1, 'a lost Start response closed the dialog as if it succeeded');
    const firstKey = startPosts.length;
    assert.equal(firstKey, 1);
    state.loseStart = false;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    scenarios.push('Start: backend/model/policy and readiness of the selected profile; non-ready blocked; lost Start response shows no success');

    const status = page.getByLabel('Run status');
    await visible(status.getByText(COPY.slot, { exact: false }));
    assert.equal(await status.locator(`time[datetime="${queuedAt}"]`).count(), 1, 'own queuedAt not shown');
    assert.match(await status.innerText(), /Backend: Codex/);
    assert.match(await status.innerText(), /Policy: approval on-request/);
    scenarios.push('run: own queued time with capacity copy; frozen backend/model/policy for internal.read');

    state.pending = [duplicate, hostOnly];
    const dup = page.locator(`[data-request-id="${duplicate.requestId}"]`);
    const host = page.locator(`[data-request-id="${hostOnly.requestId}"]`);
    await visible(dup);
    await visible(host);
    assert.ok((await host.innerText()).includes(COPY.host));
    assert.equal(await host.locator('input,textarea,select').count(), 0, 'host-only request offers a value field');
    assert.equal(await dup.getByText('[redacted]', { exact: true }).count(), 2);
    await dup.locator('input[value="o1"]').check();
    state.loseCommands = true;
    await dup.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await until(async () => commands.length === 1, 'answer was not posted');
    assert.deepEqual(commands[0], { kind: 'permission', requestId: duplicate.requestId, generation: 3, fingerprint: duplicate.fingerprint, response: { behavior: 'allow', selections: { q0: { optionIds: ['o1'] } } } });
    await visible(page.getByLabel('Sessions').getByRole('alert'));
    assert.equal(await dup.count(), 1, 'a lost answer response removed the request as if it was answered');
    assert.equal(await dup.locator('input[value="o1"]').isChecked(), true, 'the chosen option moved after a lost answer response');
    assert.equal(await dup.locator('input[value="o0"]').isChecked(), false);
    state.loseCommands = false;
    scenarios.push('requests: duplicate redacted labels answered by exact optionIds; host-only has no value field; lost answer response shows no success and keeps the request');

    state.pending = [];
    state.timeline = historyOnly;
    await until(async () => (await page.getByLabel('Session timeline').innerText()).includes('history-native-request'), 'timeline history not shown');
    await wait(4200);
    assert.equal(await page.locator('[data-request-id]').count(), 0, 'actions were manufactured from timeline history');
    assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).count(), 0);
    scenarios.push('empty plural list with timeline attention: history only, no fallback actions');

    state.queue = null;
    state.runState = 'reconciling';
    await visible(status.getByText(COPY.reconciling));
    assert.doesNotMatch(await status.innerText(), /succeeded|completed/i);
    scenarios.push('reconciling: uncertain copy, no success');

    state.sessionState = 'reconciling';
    queueRecoveryPrompts = true;
    const sessions = page.getByLabel('Sessions', { exact: true });
    const promptInput = sessions.locator('input[placeholder="New instructions to continue…"]:visible, input[placeholder="Send a follow-up instruction…"]:visible');
    const promptSubmit = sessions.getByRole('button', { name: /^(Send new instructions|Send)$/ });
    await visible(sessions.getByRole('button', { name: 'Work session · reconciling', exact: true }));
    await visible(promptInput);
    const pollingBefore = commands.length;
    const pollingText = 'Continue after the queued-state poll';
    state.loseCommands = true;
    await promptInput.fill(pollingText);
    await promptSubmit.click();
    await until(async () => commands.length === pollingBefore + 1, 'polling recovery prompt not posted');
    await visible(sessions.getByRole('alert'));
    await visible(sessions.getByRole('button', { name: 'Work session · queued', exact: true }));
    assert.equal(await promptInput.inputValue(), pollingText, 'typed recovery text lost when polling showed queued after a lost response');
    assert.equal(await sessions.getByText(/Request queued|has not confirmed|recovered|stopped|succeeded/i).count(), 0, 'a lost response looked accepted after polling showed queued');
    assert.deepEqual(commands[pollingBefore], { kind: 'prompt', text: pollingText, behavior: 'interrupt' });
    assert.ok(commandKeys[pollingBefore], 'recovery prompt omitted its idempotency key');
    assert.equal(await page.getByLabel('Prompt behavior').inputValue(), 'interrupt', 'visible behavior changed after queued polling');
    await promptSubmit.click();
    await until(async () => commands.length === pollingBefore + 2, 'failed polling recovery retry not posted');
    await visible(sessions.getByRole('alert'));
    assert.equal(await promptInput.inputValue(), pollingText, 'failed retry after queued polling cleared its draft');
    assert.equal(commandKeys[pollingBefore + 1], commandKeys[pollingBefore], 'a failed retry after polling changed its idempotency key');
    assert.deepEqual(commands[pollingBefore + 1], commands[pollingBefore], 'a failed retry after polling changed its command body');
    assert.equal(storedRecoveryCommands.size, 1, 'failed retry stored a duplicate command');
    assert.equal(await sessions.getByText(/Request queued|has not confirmed/i).count(), 0, 'failed retry looked accepted');
    state.loseCommands = false;
    await promptSubmit.click();
    await until(async () => commands.length === pollingBefore + 3, 'confirmed polling recovery retry not posted');
    assert.equal(commandKeys[pollingBefore + 2], commandKeys[pollingBefore], 'a confirmed retry after polling changed its idempotency key');
    assert.deepEqual(commands[pollingBefore + 2], commands[pollingBefore], 'a confirmed retry after polling changed its command body');
    assert.equal(storedRecoveryCommands.size, 1, 'retrying the recovery intent stored a duplicate command');
    await visible(sessions.getByText('Request queued. The execution host has not confirmed it yet.', { exact: true }));
    await until(async () => (await promptInput.inputValue()) === '', 'confirmed recovery retry did not clear its text');
    assert.equal(await sessions.getByText(/recovered|stopped|succeeded/i).count(), 0, 'queued looked like recovery after polling');
    scenarios.push('native recovery with normal polling: interrupt and draft retained through two lost replies, original body/key, one stored command, truthful acceptance only');
    queueRecoveryPrompts = false;
    state.runState = 'reconciling';
    state.sessionState = 'reconciling';
    state.queue = null;
    await page.reload();
    await page.getByRole('button', { name: 'Execution', exact: true }).click();
    await visible(status.getByText(COPY.reconciling));

    state.sessionState = 'reconciling';
    const recoverySend = page.getByRole('button', { name: 'Send new instructions', exact: true });
    await visible(recoverySend);
    assert.equal(await page.getByRole('button', { name: 'Cancel current turn', exact: true }).count(), 0, 'turn cancel offered during recovery');
    assert.equal(await page.getByLabel('Prompt behavior').count(), 0, 'steer offered during recovery');
    const recoveryInput = page.getByPlaceholder('New instructions to continue…');
    const before = commands.length;
    state.loseCommands = true;
    await recoveryInput.fill('Continue from the last green test');
    await recoverySend.click();
    await until(async () => commands.length === before + 1, 'recovery prompt not posted');
    await visible(page.getByLabel('Sessions').getByRole('alert'));
    assert.equal(await recoveryInput.inputValue(), 'Continue from the last green test', 'typed recovery text lost after a lost response');
    assert.equal(await page.getByText(/has not confirmed|recovered|stopped/).count(), 0, 'a lost response looked accepted');
    state.loseCommands = false;
    await recoverySend.click();
    await until(async () => commands.length === before + 2, 'recovery prompt retry not posted');
    assert.deepEqual(commands[before], { kind: 'prompt', text: 'Continue from the last green test', behavior: 'interrupt' });
    assert.deepEqual(commands[before + 1], commands[before]);
    assert.equal(commandKeys[before + 1], commandKeys[before], 'a retried intent changed its idempotency key');
    await visible(page.getByText('Request queued. The execution host has not confirmed it yet.', { exact: true }));
    await until(async () => (await recoveryInput.inputValue()) === '', 'confirmed recovery response did not clear its text');
    assert.equal(await page.getByText(/recovered|stopped|succeeded/i).count(), 0, 'queued looked like recovery');
    await page.getByRole('button', { name: 'Cancel uncertain execution', exact: true }).click();
    await until(async () => commands.length === before + 3, 'recovery cancel not posted');
    assert.deepEqual(commands[before + 2], { kind: 'cancel' });
    assert.notEqual(commandKeys[before + 2], commandKeys[before]);
    assert.ok(!commands.slice(before).some((c) => c.kind === 'prompt' && c.text !== 'Continue from the last green test'), 'an old prompt was replayed');
    state.sessionState = 'needs_input';
    scenarios.push('native recovery: explicit Cancel and new instructions only; lost response keeps text and key, no false success; queued is not recovery');

    {
      await page.reload();
      await page.getByRole('button', { name: 'Execution', exact: true }).click();
      state.runState = 'reconciling';
      state.sessionState = 'reconciling';
      state.queue = null;
      state.loseCommands = true;
      queueRecoveryPrompts = true;
      await visible(status.getByText(COPY.reconciling));
      const sessions4 = page.getByLabel('Sessions', { exact: true });
      const recInput4 = page.getByPlaceholder('New instructions to continue…');
      const recSend4 = page.getByRole('button', { name: 'Send new instructions', exact: true });
      await visible(recInput4);
      const before4 = commands.length;
      const text4 = 'Steer while recovery is pending';
      await recInput4.fill(text4);
      await recSend4.click();
      await until(async () => commands.length === before4 + 1, 'recovery prompt not posted');
      await visible(sessions4.getByRole('alert'));
      await until(async () => (await sessions4.getByRole('button', { name: /Work session/ }).innerText()).includes('queued'), 'session did not transition to queued');
      const normInput4 = page.getByPlaceholder('Send a follow-up instruction…');
      await visible(normInput4);
      const normSend4 = page.getByRole('button', { name: 'Send', exact: true });
      const behaviorSelect4 = page.getByLabel('Prompt behavior');
      await behaviorSelect4.selectOption('steer');
      state.loseCommands = false;
      await normSend4.click();
      await until(async () => commands.length === before4 + 2, 'steer command not posted');
      assert.equal(commands[before4 + 1].behavior, 'steer', 'explicit steer selection was overridden');
      assert.notEqual(commandKeys[before4 + 1], commandKeys[before4], 'explicit steer reused the recovery key');
      await until(async () => (await normInput4.inputValue()) === '', 'steer command did not clear draft on success');
      scenarios.push('explicit steer while recovery pending: fresh key, steer body, no silent replay');
      queueRecoveryPrompts = false;
      state.sessionState = 'needs_input';
    }

    state.runState = 'failed';
    state.runError = 'integration_disabled';
    await visible(status.getByText(COPY.disabled));
    await until(async () => page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), 'controls not disabled for integration_disabled');
    assert.match(await page.getByLabel('Session timeline').innerText(), /Recorded execution output/);
    assert.equal(await page.getByLabel('Execution stage').isDisabled(), true);
    assert.doesNotMatch(await status.innerText(), /integration_disabled/);
    scenarios.push('integration_disabled: history kept, controls disabled, approved copy only');

    const html = await page.content();
    assert.ok(!html.includes(FIXTURE_PATH) && !html.includes(FIXTURE_TOKEN) && !html.includes('configPath') && !html.includes('apiKey'));
    assert.equal(unhandled.length, 0, unhandled.join(';'));
    await page.close();
  }

  {
    state.caps = START_ONLY;
    state.runState = 'queued';
    state.runError = null;
    state.queue = { queuedAt, reason: 'capacity' };
    seenPaths.clear();
    const { page, unhandled } = await openPage();
    await page.goto(`${origin}/tasks/${ids.task}`);
    await page.getByRole('button', { name: 'Execution', exact: true }).click();
    const status = page.getByLabel('Run status');
    await visible(status.getByText(COPY.slot, { exact: false }));
    assert.equal(await status.locator(`time[datetime="${queuedAt}"]`).count(), 1);
    await page.getByRole('button', { name: 'Start AI work', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Start AI work' });
    await visible(dialog.getByText(/configured execution settings/));
    const text = await page.locator('body').innerText();
    for (const leak of ['Backend:', 'Model:', 'Policy:', 'cc-main', 'cx-main', 'claude-opus-5-5', 'gpt-codex', ids.session, 'Work session']) {
      assert.ok(!text.includes(leak), `start-only reader sees ${leak}`);
    }
    assert.ok(![...seenPaths].some((p) => p.includes('/mappings') || p.includes('/sessions/')), `start-only reader requested ${[...seenPaths].join(',')}`);
    assert.equal(unhandled.length, 0, unhandled.join(';'));
    await page.close();
    scenarios.push('start-only: own queued time and copy; no profile/model/policy/session detail; no mapping or session requests');
  }

  console.log(JSON.stringify({ result: 'PASS', scenarios }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', scenarios, message: error.message }));
  throw error;
} finally {
  await browser.close();
}
