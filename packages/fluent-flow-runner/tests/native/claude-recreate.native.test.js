import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startMcpFixture } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { syntheticClaudeAuth } from './harness/synthetic-auth.js';
import { containmentOps, probeContainment, spawnContained } from '../../src/supervisor/containment.js';
import { createLedger } from '../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../src/supervisor/supervisor.js';
import { isLive, readProcessIdentity } from '../../src/supervisor/process-identity.js';
import { createClaudeBackend } from '../../src/native/claude-backend.js';
import { harnessVersionFor, profileRevision } from '../../src/connector/catalog.js';

const MODEL = 'ff-recreate-model';
const MCP_TOKEN = 'ff-recreate-dummy-mcp-token';
const binary = requireNativeBinary('claude-code');

async function until(check, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!binary)('Claude same-UUID recreation after exact native absence (Task 11 C1)', () => {
  let containment;
  let ctx;
  let proxy;
  let mcp;
  let fx;
  let profile;
  const sleepers = [];
  const logs = [];

  beforeAll(async () => {
    await assertNetworkIsolation();
    containment = await probeContainment({ instanceHash: randomBytes(8).toString('hex') });
    ctx = await createProbeContext('claude-code');
    proxy = await startDenyProxy();
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    fx = await startAnthropicFixture({ script: [{ text: 'recreated and answered' }], mainModel: MODEL });
    profile = { id: 'cc-recreate', name: 'Claude', backend: 'claude-code', executable: binary.executable, contextDir: ctx.contextDir, model: MODEL, policy: { permissionMode: 'manual' }, complete: true, problems: [] };
  }, 60_000);

  afterAll(async () => {
    for (const s of sleepers) if (await isLive(s)) process.kill(s.pid, 'SIGKILL');
    await fx?.close();
    await mcp?.close();
    await proxy?.close();
    if (containment?.state === 'verified') {
      try {
        await containment.close();
      } catch (err) {
        logs.push({ msg: 'recreate test scope kept', code: err?.code });
      }
    }
    await ctx?.cleanup();
  }, 60_000);

  function lifetime(stateDir, { killAfterSpawn = false, killable = true } = {}) {
    const extras = probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url });
    const base = containmentOps(containment);
    const spawned = [];
    const ops = {
      ...base,
      kill: killable ? base.kill : async () => {},
      async spawn(opts) {
        const result = await spawnContained({ ...opts, env: { ...opts.env, ...extras } });
        spawned.push(opts.args.slice(-2));
        if (killAfterSpawn) process.kill(-result.child.pid, 'SIGKILL');
        return result;
      },
    };
    const privateDir = join(stateDir, 'supervisor', 'claude-sessions');
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const backend = createClaudeBackend({ privateDir, log: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), debug: () => {} }, auth: syntheticClaudeAuth({ fixture: fx }), parentEnv: ctx.parentEnv });
    const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
    const handlers = createSupervisorHandlers({ ledger, profiles: [profile], backends: { 'claude-code': backend }, containment: { state: 'verified', scopePath: containment.scopePath, ops }, log: (l) => logs.push(l), stateDir, repositories: { repo: ctx.repoDir }, stopTimeoutMs: 2_000 });
    return { handlers, ledger, spawned };
  }

  const stateFor = (name) => {
    const dir = join(ctx.root, name);
    mkdirSync(join(dir, 'supervisor'), { recursive: true, mode: 0o700 });
    return dir;
  };
  const launch = () => {
    const runId = randomUUID();
    return { commandId: randomUUID(), digest: 'd-launch', runId, sessionId: randomUUID(), backend: 'claude-code', kind: 'launch', profileId: profile.id, profileRevision: profileRevision(profile, harnessVersionFor('claude-code')), repositoryKey: 'repo', branchName: `ff/run-${runId}`, baseRef: 'main', role: 'work', reporting: { url: mcp.url, credential: MCP_TOKEN } };
  };
  const continuation = (c1, text) => ({ commandId: randomUUID(), digest: 'd-continue', runId: c1.runId, sessionId: c1.sessionId, backend: 'claude-code', kind: 'prompt', profileId: c1.profileId, profileRevision: c1.profileRevision, text, reporting: c1.reporting });
  const lines = (stateDir) => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('an unconfirmed create is resolved by exact native absence before one same-UUID create, with only the new prompt', async () => {
    if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
    const stateDir = stateFor('recreate');
    const first = lifetime(stateDir, { killAfterSpawn: true });
    const c1 = launch();
    expect(await first.handlers.submit(c1), JSON.stringify(logs.slice(-4))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(first.spawned).toEqual([['--session-id', c1.sessionId]]);
    expect(first.ledger.classify(c1.commandId)).toEqual({ create_worktree: 'receipted', create_native_session: 'uncertain' });
    expect(fx.requests).toHaveLength(0);

    const second = lifetime(stateDir);
    const text = 'Begin again with this explicit instruction.';
    const c2 = continuation(c1, text);
    expect(await second.handlers.submit(c2), JSON.stringify(logs.slice(-6))).toEqual({ state: 'applied' });
    expect(second.spawned).toEqual([['--resume', c1.sessionId], ['--session-id', c1.sessionId]]);
    const records = lines(stateDir);
    const absentAt = records.findIndex((r) => r.type === 'resolution' && r.commandId === c1.commandId && r.kind === 'native_absent');
    const closedAt = records.findIndex((r) => r.type === 'closure' && r.commandId === c1.commandId);
    const createAt = records.findIndex((r) => r.type === 'barrier' && r.commandId === c2.commandId && r.effect === 'create_native_session');
    const bindAt = records.findIndex((r) => r.type === 'bind');
    expect(absentAt).toBeGreaterThan(-1);
    expect(closedAt).toBeGreaterThan(absentAt);
    expect(createAt).toBeGreaterThan(closedAt);
    expect(bindAt).toBeGreaterThan(createAt);
    expect(records[absentAt]).toMatchObject({ effect: 'create_native_session', generation: 1, by: c2.commandId, evidence: { nativeSessionId: c1.sessionId, source: 'claude_resume_not_found', generation: 2 } });
    expect(records[bindAt]).toMatchObject({ sessionId: c1.sessionId, nativeSessionId: c1.sessionId, generation: 2 });
    expect(records.filter((r) => r.type === 'barrier' && r.commandId === c1.commandId).map((r) => r.effect)).toEqual(['create_worktree', 'create_native_session']);
    await until(() => second.ledger.eventsAfter(0).some((e) => e.payload.terminal === 'completed'), 90_000, 'recreated turn completed');
    expect(fx.requests).toHaveLength(1);
    const users = fx.requests[0].body.messages.filter((m) => m.role === 'user');
    expect(JSON.stringify(users)).toContain(text);
    expect(records.filter((r) => r.type === 'barrier' && r.effect === 'prompt').map((r) => r.commandId)).toEqual([c2.commandId]);
    expect(await second.handlers.stop({ scope: 'all', timeoutMs: 20_000 })).toEqual({ state: 'stopped' });
  }, 240_000);

  it('an old worker that cannot be proven quiescent keeps the session reconciling with no resume and no create', async () => {
    if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
    const stateDir = stateFor('stuck');
    const first = lifetime(stateDir, { killAfterSpawn: true });
    const c1 = launch();
    expect(await first.handlers.submit(c1)).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    const worker = first.ledger.workers().find((w) => w.sessionId === c1.sessionId);
    const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => sleeper.once('spawn', r));
    const identity = await until(() => readProcessIdentity(sleeper.pid), 5_000, 'sleeper identity');
    sleepers.push(identity);
    writeFileSync(join(worker.cgroupPath, 'cgroup.procs'), String(sleeper.pid));
    const second = lifetime(stateDir, { killable: false });
    const requestsBefore = fx.requests.length;
    expect(await second.handlers.submit(continuation(c1, 'must not run'))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(second.spawned).toEqual([]);
    expect(second.ledger.classify(c1.commandId).create_native_session).toBe('uncertain');
    expect(second.ledger.commandRecord(c1.commandId).closure).toBeNull();
    expect(fx.requests.length).toBe(requestsBefore);
    process.kill(identity.pid, 'SIGKILL');
  }, 240_000);
});
