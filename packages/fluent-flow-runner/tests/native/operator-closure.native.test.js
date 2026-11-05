import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { assertNetworkIsolation } from './harness/isolation.js';
import { platformCodex, requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startMcpFixture } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { syntheticCodexAuth } from './harness/synthetic-auth.js';
import { containmentOps, probeContainment, spawnContained } from '../../src/supervisor/containment.js';
import { createLedger } from '../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../src/supervisor/supervisor.js';
import { isLive, readProcessIdentity } from '../../src/supervisor/process-identity.js';
import { createCodexBackend } from '../../src/native/codex-backend.js';
import { harnessVersionFor, profileRevision } from '../../src/connector/catalog.js';

const MODEL = 'ff-closure-model';
const MCP_TOKEN = 'ff-closure-dummy-mcp-token';
const binary = requireNativeBinary('codex');

async function until(check, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!binary)('operator closure of a bound but unadmitted Codex create (Tasks 7 and 11)', () => {
  let containment;
  let ctx;
  let proxy;
  let mcp;
  let fx;
  let stateDir;
  let profile;
  const spawned = [];
  const sleepers = [];
  const logs = [];

  beforeAll(async () => {
    await assertNetworkIsolation();
    containment = await probeContainment({ instanceHash: randomBytes(8).toString('hex') });
    ctx = await createProbeContext('codex');
    proxy = await startDenyProxy();
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    fx = await startOpenAiFixture({ script: [{ text: 'fresh start done' }], mainModel: MODEL });
    const contextDir = join(ctx.root, 'codex-context');
    mkdirSync(contextDir, { mode: 0o700 });
    chmodSync(contextDir, 0o700);
    profile = { id: 'cx-closure', name: 'Codex', backend: 'codex', executable: platformCodex(binary.executable), contextDir, model: MODEL, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, complete: true, problems: [] };
    stateDir = join(ctx.root, 'state');
    mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  }, 60_000);

  afterAll(async () => {
    for (const s of sleepers) if (await isLive(s)) process.kill(s.pid, 'SIGKILL');
    for (const e of spawned) if (e.child.exitCode === null && e.child.signalCode === null) e.child.kill('SIGKILL');
    await fx?.close();
    await mcp?.close();
    await proxy?.close();
    if (containment?.state === 'verified') {
      try {
        await containment.close();
      } catch (err) {
        logs.push({ msg: 'closure test scope kept', code: err?.code });
      }
    }
    await ctx?.cleanup();
  }, 60_000);

  function lifetime({ dropCreate = false, killable = true } = {}) {
    const extras = probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url });
    const base = containmentOps(containment);
    const ops = {
      ...base,
      kill: killable ? base.kill : async () => {},
      async spawn(opts) {
        const { child, identity } = await spawnContained({ ...opts, env: { ...opts.env, ...extras } });
        const entry = { child, writes: [], dropped: null };
        spawned.push(entry);
        const out = new PassThrough();
        let tail = '';
        child.stdout.on('data', (d) => {
          const lines = (tail + d).split('\n');
          tail = lines.pop();
          for (const line of lines.filter(Boolean)) {
            const msg = JSON.parse(line);
            const start = entry.writes.find((w) => w.method === 'thread/start');
            if (dropCreate && !entry.dropped && start && msg.id === start.id && msg.method === undefined) {
              entry.dropped = msg.result?.thread?.id ?? null;
              continue;
            }
            out.write(`${line}\n`);
          }
        });
        child.stdout.on('end', () => out.end());
        Object.defineProperty(child, 'stdout', { value: out, configurable: true });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...rest) => {
          entry.writes.push(...String(chunk).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
          return write(chunk, ...rest);
        };
        return { child, identity };
      },
    };
    const backend = createCodexBackend({ log: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), debug: () => {} }, auth: syntheticCodexAuth({ fixture: fx }), parentEnv: ctx.parentEnv });
    const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
    const handlers = createSupervisorHandlers({ ledger, profiles: [profile], backends: { codex: backend }, containment: { state: 'verified', scopePath: containment.scopePath, ops }, log: (l) => logs.push(l), stateDir, repositories: { repo: ctx.repoDir }, stopTimeoutMs: 2_000 });
    return { handlers, ledger, ops };
  }

  const launch = () => {
    const runId = randomUUID();
    return { commandId: randomUUID(), digest: 'd-launch', runId, sessionId: randomUUID(), backend: 'codex', kind: 'launch', profileId: profile.id, profileRevision: profileRevision(profile, harnessVersionFor('codex')), repositoryKey: 'repo', branchName: `ff/run-${runId}`, baseRef: 'main', role: 'work', reporting: { url: mcp.url, credential: MCP_TOKEN } };
  };
  const cancel = (c1, commandId = randomUUID()) => ({ commandId, digest: `d-${commandId}`, runId: c1.runId, sessionId: c1.sessionId, backend: 'codex', kind: 'cancel' });
  const lines = () => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const methods = (entry, name) => entry.writes.filter((w) => w.method === name);

  it('a dropped create reply is bound but unadmitted; an explicit Cancel closes it only after quiescence and a new Start then runs', async () => {
    if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
    const first = lifetime({ dropCreate: true });
    const c1 = launch();
    expect(await first.handlers.submit(c1), JSON.stringify(logs.slice(-6))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    const [entry] = spawned;
    expect(entry.dropped).toEqual(expect.any(String));
    expect(methods(entry, 'thread/start')).toHaveLength(1);
    expect(methods(entry, 'turn/start')).toEqual([]);
    expect(methods(entry, 'thread/resume').map((w) => w.params)).toEqual([{ threadId: entry.dropped }]);
    const bind = lines().find((r) => r.type === 'bind' && r.sessionId === c1.sessionId);
    expect(bind.nativeSessionId).toBe(entry.dropped);
    expect(first.ledger.commandRecord(c1.commandId).barriers.map((b) => b.effect)).toEqual(['create_worktree', 'create_native_session']);
    expect(fx.requests).toHaveLength(0);
    const blocked = launch();
    expect(await first.handlers.submit(blocked)).toEqual({ state: 'deferred' });

    const c2 = cancel(c1);
    const closed = await first.handlers.submit(c2);
    expect(closed).toEqual({ state: 'applied', closure: 'operator' });
    expect(spawned).toHaveLength(1);
    const worker = first.ledger.workers().find((w) => w.sessionId === c1.sessionId);
    expect(await isLive(worker.identity)).toBe(false);
    expect(/^populated 0$/m.test(readFileSync(join(worker.cgroupPath, 'cgroup.events'), 'utf8'))).toBe(true);
    const record = first.ledger.commandRecord(c1.commandId);
    expect(record.closure).toMatchObject({ by: c2.commandId, stop: 'quiesced', evidence: { nativeSessionId: entry.dropped, promptBarrier: false, promptReceipt: false } });
    expect(record.barriers.map((b) => b.effect)).toEqual(['create_worktree', 'create_native_session']);
    expect(record.receipts.map((r) => r.effect)).toEqual(['create_worktree']);
    expect(lines().filter((r) => r.type === 'bind' && r.sessionId === c1.sessionId)).toEqual([bind]);
    const cancelled = first.ledger.eventsAfter(0).filter((e) => e.sessionId === c1.sessionId && e.payload.event?.state === 'cancelled');
    expect(cancelled).toEqual([expect.objectContaining({ nativeEventId: `ff:closure:${c2.commandId}` })]);
    const closureAt = lines().findIndex((r) => r.type === 'closure' && r.commandId === c1.commandId);
    const releaseAt = lines().findIndex((r) => r.type === 'slot_release' && r.sessionId === c1.sessionId);
    expect(releaseAt).toBeGreaterThan(closureAt);
    const workspace = first.ledger.runBarrier(c1.runId, 'create_worktree').ref.workspaceRef;
    expect(existsSync(join(stateDir, 'worktrees', workspace))).toBe(true);

    expect(await first.handlers.submit(c1)).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await first.handlers.submit(c2)).toEqual({ state: 'applied', closure: 'operator' });
    const restarted = lifetime();
    expect(await restarted.handlers.submit(c1)).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await restarted.handlers.submit(c2)).toEqual({ state: 'applied', closure: 'operator' });
    expect(await restarted.handlers.deliver({ commandId: c1.commandId, digest: c1.digest, text: 'never' })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(spawned).toHaveLength(1);
    expect(fx.requests).toHaveLength(0);

    const fresh = launch();
    expect(await restarted.handlers.submit(fresh)).toMatchObject({ state: 'accepted' });
    expect(spawned).toHaveLength(2);
    expect(await restarted.handlers.deliver({ commandId: fresh.commandId, digest: fresh.digest, text: 'A fresh explicit start.' })).toEqual({ state: 'applied' });
    await until(() => restarted.ledger.eventsAfter(0).some((e) => e.sessionId === fresh.sessionId && e.payload.terminal === 'completed'), 90_000, 'fresh start completed');
    expect(fx.requests).toHaveLength(1);
    expect(methods(spawned[1], 'thread/start')).toHaveLength(1);
    expect(await restarted.handlers.stop({ scope: 'all', timeoutMs: 20_000 })).toEqual({ state: 'stopped' });
  }, 240_000);

  it('an unprovable stop keeps the bound session reconciling: no cancelled state, no closure and no slot release', async () => {
    if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
    const first = lifetime({ dropCreate: true, killable: false });
    const c1 = launch();
    expect(await first.handlers.submit(c1)).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    const worker = first.ledger.workers().find((w) => w.sessionId === c1.sessionId);
    const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => sleeper.once('spawn', r));
    const identity = await until(() => readProcessIdentity(sleeper.pid), 5_000, 'sleeper identity');
    sleepers.push(identity);
    writeFileSync(join(worker.cgroupPath, 'cgroup.procs'), String(sleeper.pid));
    expect(await first.handlers.submit(cancel(c1))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(first.ledger.commandRecord(c1.commandId).closure).toBeNull();
    expect(first.ledger.eventsAfter(0).some((e) => e.sessionId === c1.sessionId && e.payload.event?.state === 'cancelled')).toBe(false);
    expect(first.ledger.slotHolders().get(c1.sessionId)).toBe('codex');
    expect(await isLive(identity)).toBe(true);
    process.kill(identity.pid, 'SIGKILL');
  }, 240_000);
});
