import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNetworkIsolation } from './harness/isolation.js';
import { platformCodex, requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startMcpFixture } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { startTestSupervisor } from './harness/start-test-supervisor.js';
import { connectSupervisor } from '../../src/supervisor/client.js';
import { isLive, readProcessIdentity } from '../../src/supervisor/process-identity.js';
import { loadLocalProfiles } from '../../src/connector/config.js';
import { harnessVersionFor, profileRevision } from '../../src/connector/catalog.js';

const MCP_TOKEN = 'ff-recovery-dummy-mcp-token';
const SHUTDOWN = "Shutdown could not be confirmed. Check the runner's status before continuing.";
const BIN = fileURLToPath(new URL('../../bin/fluent-flow-connector.js', import.meta.url));
const CHILD = fileURLToPath(new URL('./harness/ipc-connector-child.js', import.meta.url));
const SCENARIOS = ['conn', 'worker', 'sup', 'stuck', 'sigint'];

async function until(check, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function controlPlane() {
  const seen = { registers: 0, polls: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const reply = (data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    const path = new URL(req.url ?? '/', 'http://plane').pathname;
    if (path === '/api/connector/v1/register') {
      seen.registers += 1;
      return reply({ connectorSessionId: 'recovery-session', leaseEpoch: 1, heartbeatIntervalMs: 15_000, serverTime: new Date().toISOString() });
    }
    if (path === '/api/connector/v1/heartbeat') return reply({ leaseEpoch: 1 });
    if (path === '/api/connector/v1/poll') {
      seen.polls += 1;
      await new Promise((r) => setTimeout(r, Math.min(body.waitMs ?? 1_000, 1_000)));
      return reply({ commands: [], serverTime: new Date().toISOString() });
    }
    if (path === '/api/connector/v1/observations') return reply({ acceptedEventIds: (body.events ?? []).map((e) => e.eventId) });
    if (path.endsWith('/ack')) return reply({ state: body.state });
    return res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

function run(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((r) => child.once('exit', (code) => r({ code, stderr })));
}

function supervisorChild(flockPid) {
  const children = readFileSync(`/proc/${flockPid}/task/${flockPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  if (children.length !== 1) throw new Error(`expected one supervisor under flock, found ${children.length}`);
  return children[0];
}

for (const backend of ['claude-code', 'codex']) {
  const binary = requireNativeBinary(backend);
  describe.skipIf(!binary)(`native lifecycle and recovery (${backend}, Task 11)`, () => {
    const instanceId = `rec-${backend}`;
    const model = (key) => `ff-rec-${backend}-${key}`;
    let ctx;
    let proxy;
    let mcp;
    let fx;
    let configFile;
    let stateDir;
    let profiles;
    let supervisor = null;
    let client = null;
    let plane;
    const sleepers = [];
    const env = () => ({ PATH: process.env.PATH ?? '', HOME: ctx.home });

    const start = async () => {
      supervisor = await startTestSupervisor({ stateDir, instanceId, configFile, fixtures: {
        ...(backend === 'claude-code' ? { anthropicUrl: fx.url } : { openaiUrl: fx.url }),
        parentEnv: ctx.parentEnv, spawnEnvExtras: probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }), containment: 'real',
      } });
      return supervisor;
    };
    const connect = async () => {
      client = await connectSupervisor({ instanceId, stateDir, role: 'connector' });
      return client;
    };
    const disconnect = async () => {
      await client?.close();
      client = null;
    };
    const ledger = () => readFileSync(join(stateDir, 'supervisor', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const workerOf = (sessionId) => ledger().filter((r) => r.type === 'worker' && r.sessionId === sessionId).at(-1);
    const intentOf = (sessionId) => ledger().filter((r) => r.type === 'worker_intent' && r.sessionId === sessionId).at(-1);
    const leafPopulated = (cgroupPath) => /^populated 1$/m.test(readFileSync(join(cgroupPath, 'cgroup.events'), 'utf8'));
    const requests = (key) => fx.requestsFor(model(key));
    const carrying = (key, text) => requests(key).filter((r) => JSON.stringify(r.body).includes(text));
    const spooled = async (sessionId, predicate) => {
      const { events } = await client.request('events', { afterSeq: 0, limit: 500 });
      return events.filter((e) => e.sessionId === sessionId && predicate(e.payload));
    };
    const launch = (key) => {
      const runId = randomUUID();
      const profile = profiles.find((p) => p.id === `p-${key}`);
      return { commandId: randomUUID(), digest: `d-${key}`, runId, sessionId: randomUUID(), backend, kind: 'launch', profileId: profile.id, profileRevision: profileRevision(profile, harnessVersionFor(backend)), repositoryKey: 'repo', branchName: `ff/run-${runId}`, baseRef: 'main', role: 'work', reporting: { url: mcp.url, credential: MCP_TOKEN } };
    };
    const held = async (key, text) => {
      const cmd = launch(key);
      expect(await client.request('submit', cmd)).toMatchObject({ state: 'accepted' });
      expect(await client.request('deliver', { commandId: cmd.commandId, digest: cmd.digest, text })).toEqual({ state: 'applied' });
      await until(() => carrying(key, text).length === 1, 90_000, `${key} turn held`);
      return cmd;
    };

    beforeAll(async () => {
      await assertNetworkIsolation();
      ctx = await createProbeContext(backend);
      proxy = await startDenyProxy();
      mcp = await startMcpFixture({ token: MCP_TOKEN });
      plane = await controlPlane();
      const modelScripts = Object.fromEntries(SCENARIOS.map((key) => [model(key), key === 'worker' ? [{ text: 'first done' }, { hold: true, text: 'second' }, { text: 'continued' }] : [{ hold: true, text: `${key} done` }]]));
      fx = backend === 'claude-code' ? await startAnthropicFixture({ script: [], mainModel: model('unused'), modelScripts }) : await startOpenAiFixture({ script: [], mainModel: model('unused'), modelScripts });
      let contextDir = ctx.contextDir;
      let executable = binary.executable;
      let policy = { permissionMode: 'manual' };
      if (backend === 'codex') {
        contextDir = join(ctx.root, 'codex-context');
        mkdirSync(contextDir, { mode: 0o700 });
        chmodSync(contextDir, 0o700);
        executable = platformCodex(binary.executable);
        policy = { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false };
      }
      const tokenFile = join(ctx.root, 'host-token');
      writeFileSync(tokenFile, 'ffh_recovery_fixture_token\n', { mode: 0o600 });
      configFile = join(ctx.root, 'connector.json');
      writeFileSync(configFile, JSON.stringify({
        serverUrl: plane.url, tokenFile, instanceId, repositories: { repo: ctx.repoDir },
        capacity: { [backend]: 8 },
        profiles: SCENARIOS.map((key) => ({ id: `p-${key}`, name: `p-${key}`, backend, executable, contextDir, model: model(key), policy })),
      }));
      profiles = loadLocalProfiles({ file: configFile }).profiles;
      stateDir = join(ctx.root, `connector-${instanceId}`);
      mkdirSync(stateDir, { mode: 0o700 });
      await start();
      await connect();
    }, 120_000);

    afterAll(async () => {
      const logFile = stateDir && join(stateDir, 'supervisor', 'supervisor.log');
      if (logFile && existsSync(logFile)) {
        for (const line of readFileSync(logFile, 'utf8').split('\n')) if (/not reopened|native effect failed|recovery|refused|resume|not proven|crashed/.test(line)) console.error(`[${backend} supervisor] ${line}`);
      }
      for (const s of sleepers) {
        if (await isLive(s)) process.kill(s.pid, 'SIGKILL');
      }
      if (supervisor) {
        await disconnect();
        await run(['stop', '--config', configFile], env());
        await supervisor.close();
      }
      await fx?.close();
      await mcp?.close();
      await proxy?.close();
      await plane?.close();
      await ctx?.cleanup();
    }, 90_000);

    it('connector SIGKILL mid-turn: the turn continues, events replay, zero resends', async () => {
      await disconnect();
      const cmd = launch('conn');
      const text = 'Connector crash prompt.';
      const child = spawn(process.execPath, [CHILD], { env: { PATH: process.env.PATH ?? '', FF_TEST_CONNECTOR: JSON.stringify({ instanceId, stateDir, submit: cmd, deliver: { commandId: cmd.commandId, digest: cmd.digest, text }, ackFirst: true }) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const exited = new Promise((r) => child.once('exit', r));
      const acked = Number(await until(() => out.match(/acked (\d+)/)?.[1], 90_000, 'child acked'));
      await until(() => carrying('conn', text).length === 1, 90_000, 'conn turn held');
      child.kill('SIGKILL');
      await exited;
      fx.releaseFor(model('conn'), 0);
      await connect();
      expect((await client.request('hello', {})).deliveredSeq).toBe(acked);
      const terminal = await until(async () => {
        const { events } = await client.request('events', { afterSeq: acked, limit: 500 });
        return events.find((e) => e.sessionId === cmd.sessionId && e.payload.terminal === 'completed');
      }, 90_000, 'turn completed after the connector died');
      expect(terminal.seq).toBeGreaterThan(acked);
      const { events } = await client.request('events', { afterSeq: acked, limit: 500 });
      expect(events[0].seq).toBe(acked + 1);
      expect(carrying('conn', text)).toHaveLength(1);
      expect(ledger().filter((r) => r.type === 'barrier' && r.effect === 'prompt' && r.commandId === cmd.commandId)).toHaveLength(1);
      expect(await client.request('submit', cmd)).toMatchObject({ state: 'applied' });
      expect(ledger().filter((r) => r.type === 'worker_intent' && r.sessionId === cmd.sessionId)).toHaveLength(1);
    }, 240_000);

    it('worker SIGKILL: the request expires, the command reconciles, explicit continuation resumes the exact session without replay', async () => {
      const cmd = launch('worker');
      expect(await client.request('submit', cmd)).toMatchObject({ state: 'accepted' });
      expect(await client.request('deliver', { commandId: cmd.commandId, digest: cmd.digest, text: 'First worker prompt.' })).toEqual({ state: 'applied' });
      await until(async () => (await spooled(cmd.sessionId, (p) => p.terminal === 'completed')).length === 1, 90_000, 'first turn completed');
      const second = 'Second worker prompt.';
      const followUp = { runId: cmd.runId, sessionId: cmd.sessionId, backend, commandId: randomUUID(), digest: 'd-second', kind: 'prompt', profileId: cmd.profileId, profileRevision: cmd.profileRevision, text: second };
      expect(await client.request('submit', followUp)).toEqual({ state: 'applied' });
      await until(() => carrying('worker', second).length === 1, 90_000, 'second turn held');
      const worker = workerOf(cmd.sessionId);
      const bind = ledger().find((r) => r.type === 'bind' && r.sessionId === cmd.sessionId);
      process.kill(worker.identity.pid, 'SIGKILL');
      await until(async () => (await spooled(cmd.sessionId, (p) => p.event?.reason === 'worker_lost')).length, 60_000, 'worker loss reconciled');
      expect((await spooled(cmd.sessionId, (p) => p.event?.reason === 'worker_lost'))[0].payload.event).toMatchObject({ state: 'reconciling', errorCode: 'reconciling', stop: 'quiesced' });
      expect(leafPopulated(intentOf(cmd.sessionId).cgroupPath)).toBe(false);
      const base = { runId: cmd.runId, sessionId: cmd.sessionId, backend };
      expect(await client.request('submit', { ...base, commandId: randomUUID(), digest: 'd-expired', kind: 'permission', nativeRequestId: 'expired-request', generation: worker.generation, response: { behavior: 'allow' } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
      expect(await client.request('submit', { ...base, commandId: randomUUID(), digest: 'd-close', kind: 'cancel' })).toEqual({ state: 'applied', closure: 'operator' });
      const next = 'Continue the work.';
      const continuation = { ...base, commandId: randomUUID(), digest: 'd-continue', kind: 'prompt', profileId: cmd.profileId, profileRevision: cmd.profileRevision, text: next, reporting: cmd.reporting };
      expect(await client.request('submit', continuation)).toEqual({ state: 'applied' });
      await until(async () => (await spooled(cmd.sessionId, (p) => p.terminal === 'completed')).length === 2, 90_000, 'continued turn completed');
      expect(requests('worker')).toHaveLength(3);
      expect(carrying('worker', next)).toHaveLength(1);
      expect(JSON.stringify(requests('worker')[2].body).split(second).length - 1).toBeLessThanOrEqual(1);
      const reopened = workerOf(cmd.sessionId);
      expect(reopened.generation).toBe(worker.generation + 1);
      expect(ledger().filter((r) => r.type === 'bind' && r.sessionId === cmd.sessionId)).toEqual([bind]);
      expect(ledger().filter((r) => r.type === 'barrier' && r.effect === 'prompt' && [cmd.commandId, followUp.commandId, continuation.commandId].includes(r.commandId)).map((r) => r.commandId)).toEqual([cmd.commandId, followUp.commandId, continuation.commandId]);
      expect(ledger().filter((r) => r.type === 'barrier' && r.effect === 'create_native_session' && r.commandId === continuation.commandId)).toEqual([]);
    }, 300_000);

    it('supervisor SIGKILL mid-turn: the old worker is quiesced, the command reconciles, no competing worker', async () => {
      const text = 'Supervisor crash prompt.';
      const cmd = await held('sup', text);
      const worker = workerOf(cmd.sessionId);
      await disconnect();
      process.kill(supervisorChild(supervisor.pid), 'SIGKILL');
      await supervisor.exited;
      supervisor = null;
      expect(await isLive(worker.identity)).toBe(true);
      expect(leafPopulated(intentOf(cmd.sessionId).cgroupPath)).toBe(true);
      await start();
      expect(await isLive(worker.identity)).toBe(false);
      expect(leafPopulated(intentOf(cmd.sessionId).cgroupPath)).toBe(false);
      const recoveryStops = ledger().filter((r) => r.type === 'worker_exit' && r.sessionId === cmd.sessionId && r.exit.kind === 'recovery_stop');
      expect(recoveryStops.every((r) => r.exit.stop === 'quiesced')).toBe(true);
      await connect();
      expect(await spooled(cmd.sessionId, (p) => p.event?.state === 'reconciling' && p.event?.errorCode === 'reconciling')).toHaveLength(1);
      expect(await client.request('submit', cmd)).toMatchObject({ state: 'applied' });
      expect(ledger().filter((r) => r.type === 'worker_intent' && r.sessionId === cmd.sessionId)).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(carrying('sup', text)).toHaveLength(1);
      expect((await client.request('status', {})).workers.filter((w) => w.sessionId === cmd.sessionId)).toEqual([expect.objectContaining({ populated: false, state: 'stopped' })]);
    }, 240_000);

    it('a stuck descendant gives the uncertain message, exit 1, and status shows it', async () => {
      const cmd = await held('stuck', 'Escape prompt.');
      const sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
      await new Promise((r) => sleeper.once('spawn', r));
      const identity = await until(() => readProcessIdentity(sleeper.pid), 5_000, 'sleeper identity');
      sleepers.push(identity);
      const leaf = intentOf(cmd.sessionId).cgroupPath;
      writeFileSync(join(leaf, 'cgroup.procs'), String(sleeper.pid));
      expect(readFileSync(`/proc/${sleeper.pid}/cgroup`, 'utf8')).toContain(leaf.split('/').at(-1));
      await client.request('status', {});
      const own = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::')).slice(3);
      writeFileSync(join('/sys/fs/cgroup', own, 'cgroup.procs'), String(sleeper.pid));
      await disconnect();
      const stopped = await run(['stop', '--config', configFile], env());
      expect(stopped.code).toBe(1);
      expect(stopped.stderr).toContain(SHUTDOWN);
      const status = await run(['status', '--config', configFile], env());
      expect(status.code).toBe(0);
      expect(status.stderr).toContain(cmd.sessionId);
      expect(status.stderr).toMatch(/escaped/);
      expect(status.stderr).not.toContain('Escape prompt.');
      expect(await isLive(identity)).toBe(true);
      process.kill(identity.pid, 'SIGKILL');
      await until(async () => !(await isLive(identity)), 5_000, 'fixture sleeper gone');
      const again = await run(['stop', '--config', configFile], env());
      expect(again.code, again.stderr).toBe(0);
      await supervisor.exited;
      supervisor = null;
    }, 240_000);

    it("SIGINT to the runner's foreground group: turns interrupted with receipts, workers gone, journals and worktrees kept, exit 0", async () => {
      await start();
      await connect();
      const cmd = await held('sigint', 'Interrupt prompt.');
      const worker = workerOf(cmd.sessionId);
      await disconnect();
      const filesBefore = readdirSync(stateDir, { recursive: true }).filter((f) => !String(f).endsWith('.sock')).sort();
      const registersBefore = plane.seen.registers;
      const runner = spawn(process.execPath, [BIN, '--config', configFile], { detached: true, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      runner.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((r) => runner.once('exit', (code, signal) => r({ code, signal })));
      await until(() => plane.seen.registers > registersBefore && plane.seen.polls > 0, 60_000, 'runner attached');
      process.kill(-runner.pid, 'SIGINT');
      expect(await exited, stderr).toEqual({ code: 0, signal: null });
      expect(stderr).not.toContain(SHUTDOWN);
      await supervisor.exited;
      supervisor = null;
      const records = ledger();
      const stop = records.find((r) => r.type === 'accept' && r.kind === 'stop_interrupt' && r.sessionId === cmd.sessionId);
      expect(stop).toBeDefined();
      expect(records.filter((r) => r.commandId === stop.commandId && ['barrier', 'receipt'].includes(r.type)).map((r) => `${r.type}:${r.effect}`)).toEqual(['barrier:interrupt', 'receipt:interrupt']);
      expect(await isLive(worker.identity)).toBe(false);
      const filesAfter = readdirSync(stateDir, { recursive: true }).map(String);
      expect(filesBefore.filter((f) => !filesAfter.includes(f))).toEqual([]);
      expect(existsSync(join(stateDir, 'supervisor', 'ledger.jsonl'))).toBe(true);
      const workspaceRef = records.find((r) => r.type === 'barrier' && r.effect === 'create_worktree' && r.commandId === cmd.commandId).ref.workspaceRef;
      expect(existsSync(join(stateDir, 'worktrees', workspaceRef))).toBe(true);
    }, 240_000);
  });
}
