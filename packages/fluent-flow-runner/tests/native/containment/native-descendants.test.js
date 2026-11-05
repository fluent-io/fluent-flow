import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containmentOps, probeContainment, readContainment, spawnContained } from '../../../src/supervisor/containment.js';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { isLive, readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { createClaudeBackend } from '../../../src/native/claude-backend.js';
import { harnessVersionFor, profileRevision } from '../../../src/connector/catalog.js';
import { assertNetworkIsolation } from '../harness/isolation.js';
import { requireNativeBinary } from '../harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from '../harness/context.js';
import { startAnthropicFixture } from '../harness/anthropic-fixture.js';
import { startMcpFixture } from '../harness/mcp-fixture.js';
import { startDenyProxy } from '../harness/deny-proxy.js';
import { syntheticClaudeAuth } from '../harness/synthetic-auth.js';

const MODEL = 'ff-descendant-model';
const MCP_TOKEN = 'ff-descendant-dummy-mcp-token';
const binary = requireNativeBinary('claude-code');
const suite = binary ? describe : describe.skip;

async function until(check, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite('native descendants under real containment (Task 11)', () => {
  let containment;
  let ctx;
  let mcp;
  let proxy;
  let fx;
  let handlers;
  const logs = [];

  beforeAll(async () => {
    await assertNetworkIsolation();
    containment = await probeContainment({ instanceHash: randomBytes(8).toString('hex') });
    ctx = await createProbeContext('claude-code');
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    proxy = await startDenyProxy();
  }, 60_000);

  afterAll(async () => {
    if (handlers) await handlers.stop({ scope: 'all', timeoutMs: 20_000 });
    await fx?.close();
    await mcp?.close();
    await proxy?.close();
    if (containment?.state === 'verified') await containment.close();
    await ctx?.cleanup();
  }, 60_000);

  it('a background process started by a native tool call stays in the worker cgroup after the turn, blocks wrap-up and is ended by stopContained', async () => {
    if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
    const pidFile = join(ctx.root, 'background.pid');
    fx = await startAnthropicFixture({
      mainModel: MODEL,
      script: [
        { tool: 'Bash', input: { command: `nohup setsid sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`, description: 'background' } },
        { text: 'done' },
      ],
    });
    const stateDir = join(ctx.root, 'state');
    mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
    const privateDir = join(stateDir, 'supervisor', 'claude-sessions');
    mkdirSync(privateDir, { mode: 0o700 });
    const extras = probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url });
    const ops = { ...containmentOps(containment), spawn: (opts) => spawnContained({ ...opts, env: { ...opts.env, ...extras } }) };
    const profile = { id: 'cc-desc', name: 'Claude', backend: 'claude-code', executable: binary.executable, contextDir: ctx.contextDir, model: MODEL, policy: { permissionMode: 'manual' }, complete: true, problems: [] };
    const backendLog = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), debug: () => {} };
    const backend = createClaudeBackend({ privateDir, log: backendLog, auth: syntheticClaudeAuth({ fixture: fx }), parentEnv: ctx.parentEnv });
    const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
    handlers = createSupervisorHandlers({ ledger, profiles: [profile], backends: { 'claude-code': backend }, containment: { state: 'verified', scopePath: containment.scopePath, ops }, log: (l) => logs.push(l), stateDir, repositories: { repo: ctx.repoDir } });
    const runId = randomUUID();
    const sessionId = randomUUID();
    const launch = { commandId: randomUUID(), digest: 'd-launch', runId, sessionId, backend: 'claude-code', kind: 'launch', profileId: 'cc-desc', profileRevision: profileRevision(profile, harnessVersionFor('claude-code')), repositoryKey: 'repo', branchName: `ff/run-${runId}`, baseRef: 'main', role: 'work', reporting: { url: mcp.url, credential: MCP_TOKEN } };
    const bound = await handlers.submit(launch);
    expect(bound, JSON.stringify(logs.slice(-5))).toMatchObject({ state: 'accepted' });
    expect(await handlers.deliver({ commandId: launch.commandId, digest: 'd-launch', text: 'Start the background helper.' })).toEqual({ state: 'applied' });
    const request = await until(async () => (await handlers.pendingQuestions()).requests[0], 90_000, 'permission request');
    expect(request.kind).toBe('permission');
    const answered = await handlers.submit({ commandId: randomUUID(), digest: 'd-allow', runId, sessionId, backend: 'claude-code', kind: 'permission', nativeRequestId: request.nativeRequestId, generation: request.generation, fingerprint: request.fingerprint, response: { selectedActionId: 'allow_once', behavior: 'allow' } });
    expect(answered).toEqual({ state: 'applied' });
    await until(async () => (await handlers.status()).workers[0]?.state === 'idle', 90_000, 'turn finished');
    const pid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()), 10_000, 'background pid');
    const identity = await readProcessIdentity(pid);
    expect(identity).not.toBeNull();
    const [worker] = ledger.workers();
    const leaf = ops.leaf({ cgroupPath: worker.cgroupPath, generation: worker.generation, sessionId });
    const inside = await readContainment({ cgroupPath: leaf });
    expect(inside.populated).toBe(true);
    expect(inside.pids.map((p) => p.pid)).toContain(pid);
    expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(`/w-${worker.generation}-${sessionId}`);
    const preflight = await handlers.wrapupPreflight({ runId, repositoryKey: 'repo', workspaceRef: bound.binding.workspaceRef });
    expect(preflight.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'owned_activity' })]));
    expect(await handlers.stop({ scope: 'all', timeoutMs: 20_000 })).toEqual({ state: 'stopped' });
    expect(await isLive(identity)).toBe(false);
    expect((await readContainment({ cgroupPath: leaf })).populated).toBe(false);
    expect(ledger.workers()[0].exit).toMatchObject({ kind: 'owned_stop', reason: 'shutdown', stop: 'quiesced' });
    expect(existsSync(join(stateDir, 'worktrees', bound.binding.workspaceRef))).toBe(true);
    expect(fx.unexpected).toEqual([]);
  }, 180_000);
});
