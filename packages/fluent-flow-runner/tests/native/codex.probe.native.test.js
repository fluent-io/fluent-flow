
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createJsonlChannel } from '../../src/native/jsonl.js';
import { createCodexRpc } from '../../src/native/codex-rpc.js';
import { buildNativeEnv } from '../../src/native/native-env.js';
import { codexArgs, codexLaunchControls, codexQuestionServerOverrides, NATIVE_OBSERVED } from '../../src/native/pins.js';
import { assessCodexLayers } from '../../src/native/codex-config-gate.js';
import { startQuestionServer } from '../../src/native/question-mcp.js';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras, MARKERS } from './harness/context.js';
import { startOpenAiFixture } from './harness/openai-fixture.js';
import { startMcpFixture, MCP_TOOL } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { createEvidence } from './harness/evidence.js';

const MODEL = 'ff-probe-model';
const MCP_TOKEN = 'ff-probe-dummy-mcp-token';
const QUESTIONS_TOKEN = 'ff-probe-dummy-questions-token';
const CLIENT_INFO = { name: 'ff-probe', title: null, version: '0.0.0' };

const binary = requireNativeBinary('codex');
const suite = binary ? describe : describe.skip;

const under = (root, p) => typeof p === 'string' && isAbsolute(p) && !relative(root, p).startsWith('..');

suite('codex native probes', () => {
  /** @type {Awaited<ReturnType<typeof createProbeContext>>} */
  let ctx;
  let mcp;
  let proxy;
  let evidence;
  /** @type {{ fx: any, expectedMain: number, id: string }[]} */
  const fixtures = [];
  const live = new Set();
  const rolloutPaths = [];
  let x4Thread;

  beforeAll(async () => {
    await assertNetworkIsolation();
    ctx = await createProbeContext('codex');
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    proxy = await startDenyProxy();
    evidence = createEvidence({ backend: 'codex', version: binary.version, root: ctx.root });
  });

  afterAll(async () => {
    for (const w of live) w.child.kill('SIGKILL');
    for (const { fx } of fixtures) await fx.close();
    await mcp?.close();
    await proxy?.close();
    evidence?.flush();
    await ctx?.cleanup();
    for (const c of groups.values()) await c.cleanup();
  });

  async function fixture(id, script, expectedMain = script.length) {
    const fx = await startOpenAiFixture({ script, mainModel: MODEL });
    fixtures.push({ fx, expectedMain, id });
    return fx;
  }

  function overrides(fx) {
    return {
      model_provider: 'ffprobe',
      'model_providers.ffprobe.name': 'ffprobe',
      'model_providers.ffprobe.base_url': fx.url,
      'model_providers.ffprobe.env_key': 'FF_PROBE_OPENAI_KEY',
      'model_providers.ffprobe.wire_api': 'responses',
      'model_providers.ffprobe.requires_openai_auth': false,
      check_for_update_on_startup: false,
      'analytics.enabled': false,
      'feedback.enabled': false,
      ...codexLaunchControls(),
      'mcp_servers.ff_reporting.url': mcp.url,
      'mcp_servers.ff_reporting.bearer_token_env_var': 'FF_REPORTING_TOKEN',
    };
  }

  /**
   * @param {{ fx: any, onServerRequest?: Function, onNotification?: Function, context?: any, cwd?: string, questionsUrl?: string }} opts
   */
  async function startWorker({ fx, onServerRequest, onNotification, context = ctx, cwd = context.repoDir, questionsUrl }) {
    const env = {
      ...buildNativeEnv({ backend: 'codex', contextDir: context.contextDir, parentEnv: context.parentEnv, reportingToken: MCP_TOKEN, questionsToken: questionsUrl ? QUESTIONS_TOKEN : undefined }),
      ...probeSpawnExtras({ home: context.home, proxyUrl: proxy.url }),
      FF_PROBE_OPENAI_KEY: 'sk-ff-probe-dummy-key',
    };
    const launchOverrides = { ...overrides(fx), ...(questionsUrl ? codexQuestionServerOverrides({ url: questionsUrl }) : {}) };
    const child = spawn(binary.executable, codexArgs({ overrides: launchOverrides }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const channel = createJsonlChannel({ readable: child.stdout, writable: child.stdin });
    const notifications = [];
    const serverRequests = [];
    const rpc = createCodexRpc(channel, {
      onNotification: (n) => {
        notifications.push(n);
        return onNotification?.(n);
      },
      onServerRequest: async (req) => {
        serverRequests.push(req);
        if (!onServerRequest) return { error: { code: -32601, message: 'probe did not expect a server request' } };
        return onServerRequest(req);
      },
    });
    const worker = {
      child,
      rpc,
      overrides: launchOverrides,
      notifications,
      serverRequests,
      exited,
      get stderr() {
        return stderr;
      },
      async waitFor(pred, timeoutMs = 30_000, label = 'notification') {
        const start = Date.now();
        for (;;) {
          const hit = notifications.find(pred);
          if (hit) return hit;
          if (Date.now() - start > timeoutMs) {
            throw new Error(`timed out waiting for ${label}; seen: ${notifications.map((n) => n.method).slice(-12).join(',')}; stderr: ${stderr.slice(-400)}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      async stop() {
        live.delete(worker);
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(t);
      },
    };
    live.add(worker);
    const init = await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } });
    await rpc.notify('initialized');
    worker.init = init;
    return worker;
  }

  async function startThread(worker) {
    const res = await worker.rpc.request('thread/start', {
      model: MODEL,
      cwd: ctx.repoDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      ephemeral: false,
    });
    if (res?.thread?.path) rolloutPaths.push(res.thread.path);
    return res;
  }

  const text = (t) => [{ type: 'text', text: t, text_elements: [] }];
  const turnDone = (turnId) => (n) => n.method === 'turn/completed' && n.params.turn.id === turnId;
  const bodyJson = (fx, i) => JSON.stringify(fx.requests[i]?.body ?? null);

  it('X1 version is 0.162.1', () => {
    expect(binary.version, 'X1').toBe('0.162.1');
  });

  it('X2 initialize then initialized under strict config', async () => {
    const fx = await fixture('X2', []);
    const w = await startWorker({ fx });
    const exitedEarly = await Promise.race([w.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
    await w.stop();
    evidence.record('X2', { initialize: w.init, argv: [...codexArgs({ overrides: {} }), '-c', '<key>=<toml value>', '...'], overrideKeys: Object.keys(overrides(fx)) });
    expect(w.init, 'X2 initialize').toHaveProperty('userAgent');
    expect(under(ctx.contextDir, w.init.codexHome), 'X2 codexHome').toBe(true);
    expect(exitedEarly, 'X2 strict config rejected').toBe(false);
  });

  it('X3 account/read without refresh reports no account', async () => {
    const fx = await fixture('X3', []);
    const w = await startWorker({ fx });
    const account = await w.rpc.request('account/read', { refreshToken: false });
    await w.stop();
    evidence.record('X3', { account });
    expect({ account: account.account, requiresOpenaiAuth: account.requiresOpenaiAuth }, 'X3').toEqual({ account: null, requiresOpenaiAuth: false });
  });

  it('X4 and X5 thread/start then turn/start with clientUserMessageId', async () => {
    const fx = await fixture('X4', [{ text: 'hello' }]);
    const w = await startWorker({ fx });
    const started = await startThread(w);
    x4Thread = started.thread;
    const clientUserMessageId = randomUUID();
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, clientUserMessageId, input: text('hi') });
    const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X5 turn/completed');
    const userItem = w.notifications.find((n) => n.method === 'item/completed' && n.params.item.type === 'userMessage');
    const mcpStartup = w.notifications.filter((n) => n.method === 'mcpServer/startupStatus/updated').map((n) => ({ name: n.params.name, status: n.params.status }));
    await w.stop();
    const { turns, ...threadShape } = started.thread;
    evidence.record('X4', { thread: threadShape, model: started.model, approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, instructionSources: started.instructionSources, mcpStartup });
    evidence.record('X5', { clientUserMessageId, echoedClientId: userItem?.params.item.clientId ?? null, turnStatus: done.params.turn.status });
    expect(typeof started.thread.id, 'X4 thread id').toBe('string');
    expect(under(ctx.contextDir, started.thread.path), 'X4 rollout under contextDir').toBe(true);
    expect(fx.requests.length, 'X4 model requests').toBe(1);
    expect(fx.requests[0].body.model, 'X4 model').toBe(MODEL);
    expect(bodyJson(fx, 0).includes(MARKERS.agentsMd), 'X4 AGENTS.md marker').toBe(true);
    expect(bodyJson(fx, 0).includes(MARKERS.plantedModel), 'X4 planted model').toBe(false);
    expect(done.params.turn.status, 'X5 turn completed').toBe('completed');
  });

  it('X4b trap record: thread/start with cwd writes trust and contacts the planted server', async () => {
    const c = await group('E');
    const configBefore = contextConfig(c);
    const fx = await fixture('X4b', [{ text: 'hello' }]);
    const w = await startWorker({ fx, context: c, cwd: c.worktreeDir });
    const started = await gatedThread(w, { cwd: c.worktreeDir });
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('hi') });
    await w.waitFor(turnDone(turn.turn.id), 30_000, 'X4b turn/completed');
    const contacted = await waitUntil(() => c.plantedHits.length > 0, 10_000, 'X4b planted hit').then(
      () => true,
      () => false,
    );
    const statuses = plantedStatuses(w);
    const hits = [...c.plantedHits];
    const configAfter = contextConfig(c);
    await w.stop();
    recordGroup('X4b', { contextConfigBefore: configBefore, contextConfigAfter: configAfter, plantedStatuses: statuses, plantedHits: hits, plantedModelUsed: bodyJson(fx, 0).includes(MARKERS.plantedModel) });
    expect(configBefore, 'X4b context config.toml before').toBeNull();
    expect(configAfter ?? '', 'X4b trust written').toMatch(/trust_level\s*=\s*"trusted"/);
    expect(contacted && hits.length > 0, 'X4b planted server contacted').toBe(true);
  });

  it('X6 command approval decline leaves no file and resolves the request', async () => {
    const marker = join(ctx.repoDir, 'x6-marker');
    const fx = await fixture('X6', [
      { tool: 'exec_command', input: { cmd: `touch ${marker}`, sandbox_permissions: 'require_escalated', justification: 'probe' } },
      { text: 'ok' },
    ]);
    const w = await startWorker({ fx, onServerRequest: async () => ({ result: { decision: 'decline' } }) });
    const started = await startThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('run it') });
    const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X6 turn/completed');
    await w.stop();
    const approval = w.serverRequests.find((r) => r.method === 'item/commandExecution/requestApproval');
    const resolved = w.notifications.find((n) => n.method === 'serverRequest/resolved');
    evidence.record('X6', { approval, resolved: resolved?.params, turnStatus: done.params.turn.status });
    expect(approval?.params.command, 'X6 approval command').toContain(marker);
    expect(existsSync(marker), 'X6 file created').toBe(false);
    expect(resolved?.params.requestId, 'X6 serverRequest/resolved').toBe(approval?.id);
    expect(done.params.turn.status, 'X6 turn completed').toBe('completed');
  });

  it('X7 limit record: request_user_input cannot carry the required question shape', async () => {
    const plan = { mode: 'plan', settings: { model: MODEL, reasoning_effort: null, developer_instructions: null } };
    const run = async (id, script, collaborationMode) => {
      const fx = await fixture(id, script);
      const w = await startWorker({ fx, onServerRequest: async () => ({ result: { answers: { q1: { answers: ['FF-X7-ANSWER'] } } } }) });
      const started = await startThread(w);
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('ask me'), ...(collaborationMode ? { collaborationMode } : {}) });
      await w.waitFor(turnDone(turn.turn.id), 30_000, `${id} turn/completed`);
      await w.stop();
      return { fx, requests: w.serverRequests.filter((r) => r.method === 'item/tool/requestUserInput') };
    };
    const withOptions = { id: 'q1', header: 'Pick', question: 'Which one?', options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }] };
    const withoutOptions = { id: 'q1', header: 'Token', question: 'Paste the token', isSecret: true };
    const def = await run('X7-default', [{ tool: 'request_user_input', input: { questions: [withOptions] } }, { text: 'ok' }]);
    const planOptions = await run('X7-plan-options', [{ tool: 'request_user_input', input: { questions: [withOptions] } }, { text: 'ok' }], plan);
    const planNoOptions = await run('X7-plan-no-options', [{ tool: 'request_user_input', input: { questions: [withoutOptions] } }, { text: 'ok' }], plan);
    const defaultTool = (def.fx.requests[0]?.body.tools ?? []).find((t) => t.name === 'request_user_input');
    const toolOutput = (fx) => {
      const out = (fx.requests[1]?.body.input ?? []).find((i) => i.type === 'function_call_output');
      return typeof out?.output === 'string' ? out.output : JSON.stringify(out?.output ?? null);
    };
    const defaultOutput = toolOutput(def.fx);
    evidence.record('X7', {
      defaultModeOffersRequestUserInput: Boolean(defaultTool),
      defaultToolDescription: defaultTool?.description ?? null,
      defaultCallToolOutput: defaultOutput.slice(0, 300),
      defaultCallServerRequests: def.requests.length,
      planWithOptions: planOptions.requests.map((r) => r.params.questions.map((q) => ({ isSecret: q.isSecret, isOther: q.isOther, options: q.options === null ? null : q.options.length }))),
      planWithoutOptionsServerRequests: planNoOptions.requests.length,
      planWithoutOptionsToolOutput: toolOutput(planNoOptions.fx).slice(0, 300),
    });
    expect(defaultTool, 'X7 default mode offers request_user_input').toBeDefined();
    expect(defaultTool?.description ?? '', 'X7 default tool description').toMatch(/only available in Plan mode/i);
    expect(defaultOutput, 'X7 default call rejected outside Plan mode').toBe('request_user_input is unavailable in Default mode');
    expect(defaultOutput, 'X7 default call not rejected for its arguments').not.toMatch(/requires non-empty options/i);
    expect(def.requests.length, 'X7 default call server requests').toBe(0);
    expect(toolOutput(planNoOptions.fx), 'X7 plan no-options rejection').toMatch(/requires non-empty options/i);
    expect(planOptions.requests.length, 'X7 plan call with options arrives').toBe(1);
    expect(planOptions.requests[0]?.params.questions[0].isSecret, 'X7 plan isSecret').toBe(false);
    expect(planNoOptions.requests.length, 'X7 plan call without options').toBe(0);
  });

  it('X8 turn/steer with the active turn id succeeds and a stale id errors', async () => {
    const fx = await fixture('X8', [{ hold: true }, { text: 'after steer' }]);
    const w = await startWorker({ fx });
    const started = await startThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('start') });
    await waitUntil(() => fx.requests.length === 1, 30_000, 'X8 held request');
    const steer = await w.rpc.request('turn/steer', { threadId: started.thread.id, expectedTurnId: turn.turn.id, input: text('FF-STEER-TEXT') });
    const stale = await w.rpc.request('turn/steer', { threadId: started.thread.id, expectedTurnId: randomUUID(), input: text('stale') }).then(
      (r) => ({ ok: r }),
      (e) => ({ error: e.rpcError ?? e.code }),
    );
    fx.release(0);
    const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X8 turn/completed');
    await w.stop();
    evidence.record('X8', { steer, stale, turnStatus: done.params.turn.status, modelRequests: fx.requests.length, steerReachedModel: fx.requests.some((r) => JSON.stringify(r.body).includes('FF-STEER-TEXT')) });
    expect(steer, 'X8 steer response').toBeTruthy();
    expect(stale.error, 'X8 stale id error').toBeTruthy();
    expect(done.params.turn.status, 'X8 turn continued').toBe('completed');
    expect(fx.requests.length, 'X8 model requests').toBe(2);
    expect(JSON.stringify(fx.requests[0].body).includes('FF-STEER-TEXT'), 'X8 steer in held request').toBe(false);
    expect(JSON.stringify(fx.requests[1].body).includes('FF-STEER-TEXT'), 'X8 steer reached model').toBe(true);
  });

  it('X9 turn/interrupt returns and the turn completes interrupted', async () => {
    const fx = await fixture('X9', [{ hold: true }]);
    const w = await startWorker({ fx });
    const started = await startThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('start') });
    await waitUntil(() => fx.requests.length === 1, 30_000, 'X9 held request');
    const interrupted = await w.rpc.request('turn/interrupt', { threadId: started.thread.id, turnId: turn.turn.id });
    const done = await w.waitFor(turnDone(turn.turn.id), 15_000, 'X9 turn/completed');
    await waitUntil(() => fx.requests[0].aborted, 5_000, 'X9 held stream abort');
    await w.stop();
    evidence.record('X9', { interruptResponse: interrupted, turnStatus: done.params.turn.status, heldStreamAborted: fx.requests[0].aborted });
    expect(done.params.turn.status, 'X9 status').toBe('interrupted');
    expect(fx.requests[0].aborted, 'X9 held stream aborted').toBe(true);
    expect(fx.requests.length, 'X9 model requests').toBe(1);
  });

  it('X10 resume after killing a worker with a pending approval makes no requests', async () => {
    const fx = await fixture('X10', [{ tool: 'exec_command', input: { cmd: `touch ${join(ctx.repoDir, 'x10-marker')}`, sandbox_permissions: 'require_escalated', justification: 'probe' } }]);
    const first = await startWorker({ fx, onServerRequest: () => new Promise(() => {}) });
    const started = await startThread(first);
    await first.rpc.request('turn/start', { threadId: started.thread.id, input: text('run it') });
    await waitUntil(() => first.serverRequests.some((r) => r.method === 'item/commandExecution/requestApproval'), 30_000, 'X10 approval');
    first.child.kill('SIGKILL');
    await first.exited;
    live.delete(first);
    const before = fx.requests.length;
    const second = await startWorker({ fx });
    const resumed = await second.rpc.request('thread/resume', { threadId: started.thread.id });
    await new Promise((r) => setTimeout(r, 5_000));
    const modelDuring = fx.requests.length - before;
    const serverDuring = second.serverRequests.length;
    await second.stop();
    evidence.record('X10', { resumedThreadStatus: resumed?.thread?.status, resumedTurnStatuses: (resumed?.thread?.turns ?? []).map((t) => t.status), modelRequests: modelDuring, serverRequests: serverDuring });
    expect(modelDuring, 'X10 model requests').toBe(0);
    expect(serverDuring, 'X10 server requests').toBe(0);
    expect(existsSync(join(ctx.repoDir, 'x10-marker')), 'X10 file created').toBe(false);
  });

  it('X11 reporting MCP call is authorized through bearer_token_env_var', async () => {
    const fx = await fixture('X11', [{ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status: 'ok' } }, { text: 'ok' }]);
    const before = mcp.calls.length;
    const w = await startWorker({
      fx,
      onServerRequest: async (req) =>
        req.method === 'mcpServer/elicitation/request' ? { result: { action: 'accept', content: {}, _meta: null } } : { error: { code: -32601, message: 'unexpected' } },
    });
    const started = await startThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('report') });
    await w.waitFor(turnDone(turn.turn.id), 30_000, 'X11 turn/completed');
    await w.stop();
    const calls = mcp.calls.slice(before).filter((c) => c.method === 'tools/call');
    evidence.record('X11', { approvals: w.serverRequests.map((r) => ({ method: r.method, kind: r.params?._meta?.codex_approval_kind })), calls: calls.map((c) => ({ ...c, authorization: c.authorization ? 'Bearer <dummy>' : null })) });
    expect(calls.length, 'X11 tools/call count').toBe(1);
    expect(calls[0].authorization, 'X11 bearer').toBe(`Bearer ${MCP_TOKEN}`);
  });

  it('X13 thread listing returns the X4 thread with its cwd', async () => {
    const fx = await fixture('X13', []);
    const w = await startWorker({ fx });
    const listed = await w.rpc.request('thread/list', { cwd: ctx.repoDir, limit: 50 });
    await w.stop();
    const hit = listed.data.find((t) => t.id === x4Thread?.id);
    for (const t of listed.data) if (t.path) rolloutPaths.push(t.path);
    evidence.record('X13', { method: 'thread/list', params: { cwd: '<repo>', limit: 50 }, ids: listed.data.map((t) => t.id), x4: hit ? { id: hit.id, cwd: hit.cwd, path: hit.path } : null });
    expect(hit?.cwd, 'X13 cwd').toBe(ctx.repoDir);
  });

  const groups = new Map();
  async function group(name) {
    if (!groups.has(name)) groups.set(name, await createProbeContext('codex'));
    return groups.get(name);
  }
  const recordGroup = (id, data) => {
    let json = JSON.stringify(data ?? null);
    for (const c of groups.values()) json = json.split(c.root).join('<probe-root>');
    evidence.record(id, JSON.parse(json));
  };
  const PLANTED = [MARKERS.plantedMcp, MARKERS.plantedCodexMcp, MARKERS.plantedRootMcp];
  const plantedStatuses = (w) => w.notifications.filter((n) => n.method === 'mcpServer/startupStatus/updated' && PLANTED.includes(n.params.name)).map((n) => `${n.params.name}:${n.params.status}`);
  const contextConfig = (c) => {
    const p = join(c.contextDir, 'config.toml');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const sanitizedLayers = (cfg) => (cfg.layers ?? []).map((l) => ({ type: l.name.type, disabledReason: l.disabledReason ?? '<absent: enabled>', keys: Object.keys(l.config ?? {}).sort(), mcpServers: Object.keys(l.config?.mcp_servers ?? {}).sort() }));
  const rootConfigLayer = (cfg, c) => (cfg.layers ?? []).some((l) => [join(c.repoDir, 'config.toml'), join(c.worktreeDir, 'config.toml')].includes(l.name.file));

  async function gatedWorker({ c, fx, onServerRequest, onNotification, questionsUrl, inert = NATIVE_OBSERVED.codex.disabledProjectLayersInert, gate = assessCodexLayers }) {
    const w = await startWorker({ fx, context: c, cwd: c.worktreeDir, questionsUrl, onServerRequest, onNotification });
    const cfg = await w.rpc.request('config/read', { cwd: c.worktreeDir, includeLayers: true });
    const verdict = gate(cfg, { overrides: w.overrides, disabledProjectLayersInert: inert });
    return { w, cfg, verdict };
  }
  async function gatedThread(w, { policy = 'on-request', cwd } = {}) {
    const res = await w.rpc.request('thread/start', { model: MODEL, approvalPolicy: policy, sandbox: 'workspace-write', ephemeral: false, ...(cwd ? { cwd } : {}) });
    return res;
  }
  const approvalOf = (w, kind) => w.serverRequests.filter((r) => r.method === 'mcpServer/elicitation/request' && r.params?._meta?.codex_approval_kind === kind);
  const classify = ({ asked, executed }) =>
    asked > 0 && executed > 0 ? 'asks' : asked === 0 && executed > 0 ? 'runs' : asked === 0 && executed === 0 ? 'refused' : `inconsistent(asked=${asked},executed=${executed})`;

  const WRONG = new Set();

  let x4cThread;
  let x4cConfigBefore;

  it('X4c worktree launch with disabled project layers, gate passes, no thread cwd', async () => {
    const c = await group('A');
    x4cConfigBefore = contextConfig(c);
    const fx = await fixture('X4c', [{ text: 'hello' }]);
    const { w, cfg, verdict } = await gatedWorker({ c, fx, inert: true });
    const projectLayers = (cfg.layers ?? []).filter((l) => l.name.type === 'project');
    expect(verdict, 'X4c gate').toEqual({ ok: true });
    const started = await gatedThread(w, WRONG.has('X4c') ? { cwd: c.worktreeDir } : {});
    x4cThread = started.thread;
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('hi') });
    const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X4c turn/completed');
    await new Promise((r) => setTimeout(r, 1_000));
    await w.stop();
    recordGroup('X4c', {
      layers: sanitizedLayers(cfg),
      rootConfigTomlProducedLayer: rootConfigLayer(cfg, c),
      threadCwdIsWorktreeRealpath: started.thread.cwd === c.worktreeDir,
      plantedStatuses: plantedStatuses(w),
      plantedHits: [...c.plantedHits],
      contextConfigUnchanged: contextConfig(c) === x4cConfigBefore,
      turnStatus: done.params.turn.status,
    });
    expect(projectLayers.length, 'X4c project layers reported').toBeGreaterThan(0);
    expect(projectLayers.every((l) => typeof l.disabledReason === 'string'), 'X4c project layers disabled').toBe(true);
    expect(done.params.turn.status, 'X4c turn').toBe('completed');
    expect(started.thread.cwd, 'X4c thread.cwd').toBe(c.worktreeDir);
    expect(bodyJson(fx, 0).includes(MARKERS.agentsMd), 'X4c AGENTS.md marker').toBe(true);
    expect(plantedStatuses(w), 'X4c planted startup').toEqual([]);
    expect(c.plantedHits, 'X4c planted hits').toEqual([]);
    expect(contextConfig(c), 'X4c context config.toml').toBe(x4cConfigBefore);
  });

  it('X4d a trusted project layer is refused before any thread/start', async () => {
    const c = await group('B');
    const repo = c.repoDir;
    writeFileSync(join(c.contextDir, 'config.toml'), `[projects."${repo}"]\ntrust_level = "trusted"\n[projects."${c.worktreeDir}"]\ntrust_level = "trusted"\n`);
    const fx = await fixture('X4d', []);
    const alwaysOk = () => ({ ok: true });
    const { w, cfg, verdict } = await gatedWorker({ c, fx, inert: true, gate: WRONG.has('X4d') ? alwaysOk : assessCodexLayers });
    let threadStarted = false;
    if (verdict.ok) {
      await gatedThread(w);
      threadStarted = true;
    }
    await new Promise((r) => setTimeout(r, 2_000));
    await w.stop();
    const projectLayers = (cfg.layers ?? []).filter((l) => l.name.type === 'project');
    recordGroup('X4d', { layers: sanitizedLayers(cfg), verdict, threadStarted, plantedStatuses: plantedStatuses(w), plantedHits: [...c.plantedHits] });
    expect(projectLayers.some((l) => l.disabledReason == null), 'X4d project layer enabled').toBe(true);
    expect(['project_layer_enabled', 'project_trust_present'], 'X4d gate reason').toContain(verdict.reason);
    expect(threadStarted, 'X4d thread/start sent').toBe(false);
    expect(plantedStatuses(w), 'X4d planted startup').toEqual([]);
    expect(c.plantedHits, 'X4d planted hits').toEqual([]);
  });

  it('X4e safe resume repeats the gate and sends thread/resume without cwd', async () => {
    const c = await group('A');
    expect(x4cThread?.id, 'X4e needs the X4c thread').toBeTruthy();
    if (WRONG.has('X4e')) writeFileSync(join(c.contextDir, 'config.toml'), `[projects."${c.repoDir}"]\ntrust_level = "trusted"\n`);
    const configBefore = contextConfig(c);
    const fx = await fixture('X4e', []);
    const { w, cfg, verdict } = await gatedWorker({ c, fx, inert: true, gate: WRONG.has('X4e') ? () => ({ ok: true }) : assessCodexLayers });
    expect(verdict, 'X4e gate').toEqual({ ok: true });
    const resumed = await w.rpc.request('thread/resume', { threadId: x4cThread.id });
    await new Promise((r) => setTimeout(r, 5_000));
    await w.stop();
    recordGroup('X4e', { layers: sanitizedLayers(cfg), resumedCwdIsWorktreeRealpath: resumed.thread.cwd === c.worktreeDir, modelRequests: fx.requests.length, serverRequests: w.serverRequests.length, plantedStatuses: plantedStatuses(w), plantedHits: [...c.plantedHits], contextConfigUnchanged: contextConfig(c) === configBefore });
    expect(resumed.thread.cwd, 'X4e resumed thread.cwd').toBe(c.worktreeDir);
    expect(fx.requests.length, 'X4e model requests').toBe(0);
    expect(w.serverRequests.length, 'X4e server requests').toBe(0);
    expect(plantedStatuses(w), 'X4e planted startup').toEqual([]);
    expect(c.plantedHits, 'X4e planted hits').toEqual([]);
    expect(contextConfig(c), 'X4e context config.toml').toBe(x4cConfigBefore ?? null);
  });

  it('X6b command approval answered cancel interrupts the turn', async () => {
    const c = await group('C');
    const marker = join(c.worktreeDir, 'x6b-marker');
    const fx = await fixture('X6b', [{ tool: 'exec_command', input: { cmd: `touch ${marker}`, sandbox_permissions: 'require_escalated', justification: 'probe' } }]);
    const decision = WRONG.has('X6b') ? 'decline' : 'cancel';
    const { w, verdict } = await gatedWorker({ c, fx, onServerRequest: async () => ({ result: { decision } }) });
    expect(verdict, 'X6b gate').toEqual({ ok: true });
    const started = await gatedThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('run it') });
    const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X6b turn/completed');
    await w.stop();
    const approval = w.serverRequests.find((r) => r.method === 'item/commandExecution/requestApproval');
    recordGroup('X6b', { availableDecisions: approval?.params.availableDecisions, answered: decision, turnStatus: done.params.turn.status, modelRequests: fx.requests.length });
    expect(approval, 'X6b approval').toBeDefined();
    expect(existsSync(marker), 'X6b file created').toBe(false);
    expect(done.params.turn.status, 'X6b turn status').toBe('interrupted');
  });

  it('X11b reporting outcome under untrusted and never', async () => {
    const c = await group('C');
    const policies = WRONG.has('X11b') ? ['untrusted'] : ['untrusted', 'never'];
    const outcomes = {};
    const details = {};
    for (const policy of policies) {
      const fx = await fixture(`X11b-${policy}`, [{ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status: `x11b-${policy}` } }, { text: 'ok' }]);
      const before = mcp.calls.filter((x) => x.method === 'tools/call').length;
      const { w, verdict } = await gatedWorker({ c, fx, onServerRequest: async (req) => (req.method === 'mcpServer/elicitation/request' ? { result: { action: 'accept', content: {}, _meta: null } } : { error: { code: -32601, message: 'unexpected' } }) });
      expect(verdict, `X11b ${policy} gate`).toEqual({ ok: true });
      const started = await gatedThread(w, { policy });
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('report') });
      const done = await w.waitFor(turnDone(turn.turn.id), 30_000, `X11b ${policy} turn/completed`);
      await w.stop();
      const asked = approvalOf(w, 'mcp_tool_call').length;
      const executed = mcp.calls.filter((x) => x.method === 'tools/call').length - before;
      outcomes[policy] = { reporting: classify({ asked, executed }) };
      details[policy] = { asked, executed, turnStatus: done.params.turn.status, otherServerRequests: w.serverRequests.filter((r) => r.method !== 'mcpServer/elicitation/request').map((r) => r.method) };
    }
    recordGroup('X11b', { policyOutcomes: outcomes, details });
    expect(Object.keys(outcomes).sort(), 'X11b recorded policies').toEqual(['never', 'untrusted']);
    for (const [policy, o] of Object.entries(outcomes)) {
      expect(['runs', 'asks', 'refused'], `X11b ${policy} outcome`).toContain(o.reporting);
      expect(details[policy].executed, `X11b ${policy} fixture calls`).toBe(o.reporting === 'refused' ? 0 : 1);
      expect(o.reporting, `X11b ${policy} matches NATIVE_OBSERVED`).toBe(NATIVE_OBSERVED.codex.policyOutcomes[policy].reporting);
    }
  });

  it('X11c reporting approval decline and cancel under on-request', async () => {
    const c = await group('C');
    const results = {};
    for (const action of ['decline', 'cancel']) {
      const sent = WRONG.has('X11c') && action === 'decline' ? 'accept' : action;
      const expected = action === 'cancel' && NATIVE_OBSERVED.codex.mcpApprovalCancelInterrupts !== false ? 1 : 2;
      const fx = await fixture(`X11c-${action}`, [{ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status: `x11c-${action}` } }, { text: 'ok' }], expected);
      const before = mcp.calls.filter((x) => x.method === 'tools/call').length;
      const { w, verdict } = await gatedWorker({ c, fx, onServerRequest: async (req) => (req.method === 'mcpServer/elicitation/request' ? { result: { action: sent, content: sent === 'accept' ? {} : null, _meta: null } } : { error: { code: -32601, message: 'unexpected' } }) });
      expect(verdict, `X11c ${action} gate`).toEqual({ ok: true });
      const started = await gatedThread(w);
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('report') });
      const done = await w.waitFor(turnDone(turn.turn.id), 30_000, `X11c ${action} turn/completed`);
      await w.stop();
      results[action] = { asked: approvalOf(w, 'mcp_tool_call').length, fixtureCalls: mcp.calls.filter((x) => x.method === 'tools/call').length - before, turnStatus: done.params.turn.status, modelRequests: fx.requests.length };
    }
    recordGroup('X11c', { results, mcpApprovalCancelInterrupts: results.cancel.turnStatus === 'interrupted' });
    expect(results.decline.asked, 'X11c decline asked').toBe(1);
    expect(results.decline.fixtureCalls, 'X11c decline fixture calls').toBe(0);
    expect(results.decline.turnStatus, 'X11c decline turn continues').toBe('completed');
    expect(results.cancel.asked, 'X11c cancel asked').toBe(1);
    expect(results.cancel.fixtureCalls, 'X11c cancel fixture calls').toBe(0);
  });

  const X14_ORDINARY = { id: 'color', header: 'Color', question: 'Which color should the probe use?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: 'cool' }] };
  const X14_SECRET = { id: 'token', header: 'Token', question: 'Paste the probe token', options: null, secret: true };
  const X14_SECRET_ANSWER = 'FF-X14-SECRET-ANSWER-5521';

  const QUESTION_GENERATION = 1;
  async function questionServer({ onPending, holdMs, dropWithdrawn = false } = {}) {
    const records = [];
    const pendings = [];
    const logs = [];
    const server = await startQuestionServer({
      sessionId: randomUUID(),
      generation: QUESTION_GENERATION,
      token: QUESTIONS_TOKEN,
      record: async (entry) => {
        if (dropWithdrawn && entry.type === 'question_withdrawn') return;
        records.push(entry);
      },
      onPending: (req) => {
        pendings.push(req);
        onPending?.(req);
      },
      log: (l) => logs.push(l),
      ...(holdMs ? { holdMs } : {}),
    });
    return { server, records, pendings, logs };
  }
  const askCall = () => ({ tool: 'mcp__ff_questions.ask', input: { questions: [X14_ORDINARY, X14_SECRET] } });
  const localAnswer = (q, req, responseId) =>
    q.server.answer(req.requestId, { responseId, source: 'local', selections: { color: { selected: ['Red'], other: null }, token: { selected: [], other: X14_SECRET_ANSWER } } });
  const acceptApproval = async (req) => (req.method === 'mcpServer/elicitation/request' ? { result: { action: 'accept', content: {}, _meta: null } } : { error: { code: -32601, message: 'unexpected' } });

  it('X14 ff_questions.ask round trip under on-request', async () => {
    const c = await group('D');
    let answered;
    const q = WRONG.has('X14') ? { server: await startMcpFixture({ token: QUESTIONS_TOKEN }), records: [], pendings: [], logs: [] } : await questionServer({ onPending: (req) => (answered = localAnswer(q, req, 'x14-r1')) });
    const fx = await fixture('X14', [askCall(), { text: 'ok' }]);
    const { w, verdict } = await gatedWorker({ c, fx, questionsUrl: q.server.url, onServerRequest: acceptApproval });
    expect(verdict, 'X14 gate').toEqual({ ok: true });
    const started = await gatedThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('ask me') });
    const done = await w.waitFor(turnDone(turn.turn.id), 60_000, 'X14 turn/completed');
    await w.stop();
    const item = w.notifications.find((n) => n.method === 'item/started' && n.params.item.type === 'mcpToolCall')?.params.item;
    const completed = w.notifications.find((n) => n.method === 'item/completed' && n.params.item.id === item?.id);
    const approvals = approvalOf(w, 'mcp_tool_call');
    const req = q.pendings[0];
    const outcome = answered ? await answered : null;
    recordGroup('X14', {
      nativeApproval: approvals.map((a) => ({ mode: a.params.mode, persist: a.params._meta?.persist ?? null, requestedSchema: a.params.requestedSchema, answered: 'accept' })),
      ffRequests: q.pendings.length,
      correlation: req ? { threadIdMatches: req.correlation.threadId === started.thread.id, callIdMatchesItem: req.correlation.callId === item?.id, itemIdMatchesItem: req.correlation.itemId === item?.id, matchedBy: req.correlation.callId === item?.id ? 'callId' : req.correlation.itemId === item?.id ? 'itemId' : 'none' } : null,
      answerOutcome: outcome,
      itemCompletedStatus: completed?.params.item.status ?? null,
      turnStatus: done.params.turn.status,
      recordTypes: q.records.map((r) => r.type),
    });
    q.server.close && (await q.server.close());
    expect(q.pendings.length, 'X14 FF requests').toBe(1);
    expect(req.correlation.threadId, 'X14 correlation threadId').toBe(started.thread.id);
    expect([req.correlation.callId, req.correlation.itemId], 'X14 correlation item').toContain(item?.id);
    expect(outcome, 'X14 local answer').toEqual({ state: 'dispatched' });
    expect(bodyJson(fx, 1).includes(X14_SECRET_ANSWER), 'X14 answer in next model request').toBe(true);
    expect(completed?.params.item.status, 'X14 item/completed').toBe('completed');
    expect(JSON.stringify([q.records, q.logs]).includes(X14_SECRET_ANSWER), 'X14 answer in records').toBe(false);
  });

  it('X14b ff_questions.ask outcome under untrusted and never', async () => {
    const c = await group('D');
    const policies = WRONG.has('X14b') ? ['untrusted'] : ['untrusted', 'never'];
    const outcomes = {};
    const details = {};
    for (const policy of policies) {
      let answered;
      const q = await questionServer({ onPending: (req) => (answered = localAnswer(q, req, `x14b-${policy}`)) });
      const fx = await fixture(`X14b-${policy}`, [askCall(), { text: 'ok' }]);
      const { w, verdict } = await gatedWorker({ c, fx, questionsUrl: q.server.url, onServerRequest: acceptApproval });
      expect(verdict, `X14b ${policy} gate`).toEqual({ ok: true });
      const started = await gatedThread(w, { policy });
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('ask me') });
      const done = await w.waitFor(turnDone(turn.turn.id), 60_000, `X14b ${policy} turn/completed`);
      await w.stop();
      const asked = approvalOf(w, 'mcp_tool_call').length;
      outcomes[policy] = { questions: classify({ asked, executed: q.pendings.length }) };
      details[policy] = { asked, ffRequests: q.pendings.length, answer: answered ? await answered : null, turnStatus: done.params.turn.status };
      await q.server.close();
    }
    recordGroup('X14b', { policyOutcomes: outcomes, details });
    expect(Object.keys(outcomes).sort(), 'X14b recorded policies').toEqual(['never', 'untrusted']);
    for (const [policy, o] of Object.entries(outcomes)) {
      expect(['runs', 'asks', 'refused'], `X14b ${policy} outcome`).toContain(o.questions);
      expect(details[policy].ffRequests, `X14b ${policy} FF requests`).toBe(o.questions === 'refused' ? 0 : 1);
      expect(o.questions, `X14b ${policy} matches NATIVE_OBSERVED`).toBe(NATIVE_OBSERVED.codex.policyOutcomes[policy].questions);
    }
  });

  it('X14c an interrupted terminal turn withdraws the held call as turn_interrupted', async () => {
    const c = await group('D');
    const q = await questionServer();
    const fx = await fixture('X14c', [askCall()]);
    const bridge = (n) =>
      n.method === 'turn/completed' && n.params.turn.status === 'interrupted'
        ? q.server.withdrawTurn({ threadId: n.params.threadId, turnId: n.params.turn.id, generation: QUESTION_GENERATION })
        : undefined;
    const { w, verdict } = await gatedWorker({ c, fx, questionsUrl: q.server.url, onServerRequest: acceptApproval, onNotification: WRONG.has('X14c') ? undefined : bridge });
    expect(verdict, 'X14c gate').toEqual({ ok: true });
    const started = await gatedThread(w);
    const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('ask me') });
    await waitUntil(() => q.pendings.length === 1, 30_000, 'X14c pending');
    const req = q.pendings[0];
    await w.rpc.request('turn/interrupt', { threadId: started.thread.id, turnId: turn.turn.id });
    const done = await w.waitFor(turnDone(turn.turn.id), 15_000, 'X14c turn/completed');
    const withdrawn = await waitUntil(() => q.records.some((r) => r.type === 'question_withdrawn'), 10_000, 'X14c question_withdrawn').then(
      () => true,
      () => false,
    );
    const preCleanup = {
      turnStatus: done.params.turn.status,
      correlationTurnIdExact: req.correlation.turnId === turn.turn.id,
      correlationThreadIdExact: req.correlation.threadId === started.thread.id,
      withdrawnBeforeCleanup: withdrawn,
      withdrawalReason: q.records.find((r) => r.type === 'question_withdrawn')?.reason ?? null,
      stillPending: q.server.pending().length,
      recordTypes: q.records.map((r) => (r.type === 'question_withdrawn' ? `${r.type}:${r.reason}` : r.type)),
    };
    const late = withdrawn ? await localAnswer(q, req, 'x14c-late') : 'not sent: request still pending';
    const barrierAfterLate = q.records.some((r) => r.type === 'answer_barrier');
    await w.stop();
    const postCleanup = { recordTypes: q.records.map((r) => (r.type === 'question_withdrawn' ? `${r.type}:${r.reason}` : r.type)) };
    await q.server.close();
    recordGroup('X14c', { preCleanup, lateAnswer: late, barrierAfterLate, postCleanup, answerInRecords: JSON.stringify([q.records, q.logs]).includes(X14_SECRET_ANSWER) });
    expect(req.correlation.turnId, 'X14c correlation turnId').toBe(turn.turn.id);
    expect(preCleanup.turnStatus, 'X14c turn status').toBe('interrupted');
    expect(withdrawn, 'X14c question_withdrawn before cleanup').toBe(true);
    expect(preCleanup.withdrawalReason, 'X14c withdrawal reason').toBe('turn_interrupted');
    expect(late, 'X14c late answer').toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(barrierAfterLate, 'X14c answer barrier').toBe(false);
  });

  it(
    'X14d a held call survives 360 s with heartbeats, then the answer reaches the model',
    async () => {
      const c = await group('D');
      const q = await questionServer(WRONG.has('X14d') ? { holdMs: 30_000 } : {});
      const fx = await fixture('X14d', [askCall(), { text: 'ok' }]);
      const { w, verdict } = await gatedWorker({ c, fx, questionsUrl: q.server.url, onServerRequest: acceptApproval });
      expect(verdict, 'X14d gate').toEqual({ ok: true });
      const started = await gatedThread(w);
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('ask me') });
      await waitUntil(() => q.pendings.length === 1, 30_000, 'X14d pending');
      const heldSince = Date.now();
      while (Date.now() - heldSince < 360_000) {
        expect(q.server.pending().length, `X14d still pending after ${Math.round((Date.now() - heldSince) / 1000)} s`).toBe(1);
        expect(w.notifications.some(turnDone(turn.turn.id)), 'X14d turn ended during hold').toBe(false);
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const outcome = await localAnswer(q, q.pendings[0], 'x14d-r1');
      const done = await w.waitFor(turnDone(turn.turn.id), 30_000, 'X14d turn/completed');
      await w.stop();
      await q.server.close();
      recordGroup('X14d', { heldMs: 360_000, answerOutcome: outcome, turnStatus: done.params.turn.status, answerReachedModel: bodyJson(fx, 1).includes(X14_SECRET_ANSWER) });
      expect(outcome, 'X14d answer').toEqual({ state: 'dispatched' });
      expect(bodyJson(fx, 1).includes(X14_SECRET_ANSWER), 'X14d answer reached model').toBe(true);
      expect(done.params.turn.status, 'X14d turn').toBe('completed');
    },
    420_000,
  );


  async function loadedIds(w) {
    const ids = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await w.rpc.request('thread/loaded/list', { cursor, limit: 2 });
      ids.push(...res.data);
      if (!res.nextCursor) return ids;
      cursor = res.nextCursor;
    }
    throw new Error('thread/loaded/list did not end');
  }

  it('X13b a turnless thread is absent from thread/list but present in thread/loaded/list and thread/read', async () => {
    const c = await group('F');
    const fx = await fixture('X13b', []);
    const { w, verdict } = await gatedWorker({ c, fx });
    expect(verdict, 'X13b gate').toEqual({ ok: true });
    const baseline = await loadedIds(w);
    const before = Math.floor(Date.now() / 1000);
    const started = await gatedThread(w);
    const second = await gatedThread(w);
    const listed = await w.rpc.request('thread/list', { cwd: c.worktreeDir, limit: 50 });
    const loaded = await loadedIds(w);
    const read = await w.rpc.request('thread/read', { threadId: started.thread.id });
    const rejoin = await w.rpc.request('thread/resume', { threadId: started.thread.id }).then(
      () => 'ok',
      (e) => ({ code: e.rpcError?.code ?? e.code, noRollout: /no rollout found/.test(e.rpcError?.message ?? '') }),
    );
    const unknown = await w.rpc.request('thread/read', { threadId: randomUUID() }).then(
      () => 'ok',
      (e) => e.rpcError ?? e.code,
    );
    await w.stop();
    recordGroup('X13b', {
      baseline,
      threadListIds: listed.data.map((t) => t.id),
      loadedIncludesBoth: [started.thread.id, second.thread.id].every((id) => loaded.includes(id)),
      loadedCount: loaded.length,
      paginatedWithLimit: 2,
      read: { idMatches: read.thread.id === started.thread.id, cwdIsWorktree: read.thread.cwd === c.worktreeDir, createdAt: read.thread.createdAt, createdSinceStart: read.thread.createdAt >= before, turns: read.thread.turns?.length ?? null, status: read.thread.status },
      unknownRead: unknown,
      turnlessRejoin: rejoin,
      readHasApprovalOrSandbox: ['approvalPolicy', 'sandbox'].some((k) => Object.hasOwn(read.thread, k)),
      modelRequests: fx.requests.length,
    });
    expect(baseline, 'X13b fresh process loads nothing').toEqual([]);
    expect(listed.data.map((t) => t.id), 'X13b thread/list omits turnless threads').not.toContain(started.thread.id);
    expect(loaded.sort(), 'X13b loaded list, all pages').toEqual([started.thread.id, second.thread.id].sort());
    expect(read.thread.id, 'X13b read id').toBe(started.thread.id);
    expect(read.thread.cwd, 'X13b read cwd').toBe(c.worktreeDir);
    expect(read.thread.createdAt >= before, 'X13b read createdAt').toBe(true);
    expect(unknown, 'X13b unknown thread read fails').not.toBe('ok');
    expect(rejoin, 'X13b turnless rejoin').toEqual({ code: -32600, noRollout: true });
    expect(['approvalPolicy', 'sandbox'].some((k) => Object.hasOwn(read.thread, k)), 'X13b read carries no policy').toBe(false);
    expect(fx.requests.length, 'X13b model requests').toBe(0);
  });

  async function rememberRun(c, id, persist) {
    const report = (status) => ({ tool: `mcp__ff_reporting.${MCP_TOOL}`, input: { status } });
    const fx = await fixture(id, [report(`${id}-1`), report(`${id}-2`), { text: 'ok' }, report(`${id}-3`), { text: 'ok' }]);
    const before = mcp.calls.filter((x) => x.method === 'tools/call').length;
    let first = true;
    const answer = async (req) => {
      if (req.method !== 'mcpServer/elicitation/request') return { error: { code: -32601, message: 'unexpected' } };
      const meta = first && persist ? { persist } : null;
      first = false;
      return { result: { action: 'accept', content: {}, _meta: meta } };
    };
    const configBefore = contextConfig(c);
    const { w, verdict } = await gatedWorker({ c, fx, onServerRequest: answer });
    expect(verdict, `${id} gate`).toEqual({ ok: true });
    const one = await gatedThread(w);
    const t1 = await w.rpc.request('turn/start', { threadId: one.thread.id, input: text('report twice') });
    await w.waitFor(turnDone(t1.turn.id), 60_000, `${id} turn 1`);
    const askedInThread = approvalOf(w, 'mcp_tool_call').length;
    const two = await gatedThread(w);
    const t2 = await w.rpc.request('turn/start', { threadId: two.thread.id, input: text('report again') });
    await w.waitFor(turnDone(t2.turn.id), 60_000, `${id} turn 2`);
    await w.stop();
    const firstApproval = approvalOf(w, 'mcp_tool_call')[0];
    const fx2 = await fixture(`${id}-restart`, [report(`${id}-4`), { text: 'ok' }]);
    const w2 = (await gatedWorker({ c, fx: fx2, onServerRequest: async () => ({ result: { action: 'accept', content: {}, _meta: null } }) })).w;
    const three = await gatedThread(w2);
    const t3 = await w2.rpc.request('turn/start', { threadId: three.thread.id, input: text('report after restart') });
    await w2.waitFor(turnDone(t3.turn.id), 60_000, `${id} restart turn`);
    await w2.stop();
    return {
      advertised: firstApproval?.params._meta?.persist ?? null,
      askedFirstThread: askedInThread,
      askedSecondThread: approvalOf(w, 'mcp_tool_call').length - askedInThread,
      askedAfterRestart: approvalOf(w2, 'mcp_tool_call').length,
      executed: mcp.calls.filter((x) => x.method === 'tools/call').length - before,
      configBefore,
      configAfter: contextConfig(c),
    };
  }

  it('X11d MCP approval remember scopes: session, and always for a session-flag server', async () => {
    const session = await rememberRun(await group('G'), 'X11d-session', 'session');
    const always = await rememberRun(await group('G2'), 'X11d-always', 'always');
    const none = await rememberRun(await group('G3'), 'X11d-once', null);
    recordGroup('X11d', { encoding: "{ action: 'accept', content: {}, _meta: { persist } }", session, always, none });
    for (const [name, r] of Object.entries({ session, always, none })) {
      expect(r.advertised, `X11d ${name} advertised`).toEqual(['session', 'always']);
      expect(r.executed, `X11d ${name} calls`).toBe(4);
      expect(r.askedSecondThread, `X11d ${name} new thread asks again`).toBe(1);
      expect(r.askedAfterRestart, `X11d ${name} new process asks again`).toBe(1);
    }
    expect(none.askedFirstThread, 'X11d once asks each call').toBe(2);
    expect(session.askedFirstThread, 'X11d session suppresses the second call').toBe(1);
    expect(always.askedFirstThread, 'X11d always suppresses the second call').toBe(1);
    expect(always.configAfter, 'X11d always writes no config for a session-flag server').toBe(always.configBefore);
  });

  it('X11e MCP approval always persists for a server the context config defines', async () => {
    const c = await group('H');
    writeFileSync(join(c.contextDir, 'config.toml'), `[mcp_servers.ff_reporting]\nurl = "${mcp.url}"\nbearer_token_env_var = "FF_REPORTING_TOKEN"\n`);
    const always = await rememberRun(c, 'X11e-always', 'always');
    recordGroup('X11e', { always });
    expect(always.advertised, 'X11e advertised').toEqual(['session', 'always']);
    expect(always.askedFirstThread, 'X11e first thread').toBe(1);
    expect(always.askedSecondThread, 'X11e new thread not asked').toBe(0);
    expect(always.askedAfterRestart, 'X11e new process not asked').toBe(0);
    const added = new RegExp(`\\n*\\[mcp_servers\\.ff_reporting\\.tools\\.${MCP_TOOL}\\]\\napproval_mode = "approve"\\n?`);
    expect(always.configAfter ?? '', 'X11e persisted approval').toMatch(added);
    expect((always.configAfter ?? '').replace(added, '\n').trim(), 'X11e nothing else changed').toBe((always.configBefore ?? '').trim());
  });

  async function failingEndpoint(status, body) {
    const hits = [];
    const server = http.createServer(async (req, res) => {
      for await (const _ of req);
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}/v1`, hits, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r(undefined)))) };
  }

  it('X15 a 404 drops the provider error code; a 400 carries the provider body as its message', async () => {
    const c = await group('I');
    const cases = {
      modelNotFound404: [404, { error: { message: 'The model `ff-probe-model` does not exist or you do not have access to it.', type: 'invalid_request_error', param: null, code: 'model_not_found' } }],
      routing404: [404, { error: { message: 'route not found', type: 'not_found', code: 'route_not_found' } }],
      plain404: [404, 'Not Found'],
      modelNotFound400: [400, { error: { message: 'The requested model is not supported.', type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }],
      invalidValue400: [400, { error: { message: 'Invalid value for input.', type: 'invalid_request_error', param: 'input', code: 'invalid_value' } }],
    };
    const seen = {};
    for (const [name, [status, body]] of Object.entries(cases)) {
      const ep = await failingEndpoint(status, body);
      const { w, verdict } = await gatedWorker({ c, fx: ep });
      expect(verdict, `X15 ${name} gate`).toEqual({ ok: true });
      const started = await gatedThread(w);
      const turn = await w.rpc.request('turn/start', { threadId: started.thread.id, input: text('hi') });
      const done = await w.waitFor(turnDone(turn.turn.id), 90_000, `X15 ${name}`);
      await w.stop();
      await ep.close();
      const errors = w.notifications.filter((n) => n.method === 'error').map((n) => ({ codexErrorInfo: n.params.error.codexErrorInfo, willRetry: n.params.willRetry }));
      const raw = JSON.stringify(w.notifications).split(ep.url).join('<endpoint>');
      const providerCode = typeof body === 'string' ? null : body.error.code;
      seen[name] = { turnStatus: done.params.turn.status, terminalErrorInfo: done.params.turn.error?.codexErrorInfo ?? null, terminalMessage: (done.params.turn.error?.message ?? '').split(ep.url).join('<endpoint>'), errors, providerCodeAnywhere: providerCode !== null && raw.includes(providerCode), endpointHits: ep.hits.length };
    }
    recordGroup('X15', seen);
    for (const r of Object.values(seen)) expect(r.turnStatus, 'X15 turn status').toBe('failed');
    expect(seen.modelNotFound404.terminalErrorInfo, 'X15 model 404 vs routing 404').toEqual(seen.routing404.terminalErrorInfo);
    expect(seen.modelNotFound404.terminalErrorInfo, 'X15 model 404 vs plain 404').toEqual(seen.plain404.terminalErrorInfo);
    for (const name of ['modelNotFound404', 'routing404', 'plain404']) expect(seen[name].providerCodeAnywhere, `X15 ${name} provider code reaches the client`).toBe(false);
    for (const name of ['modelNotFound400', 'invalidValue400']) {
      expect(seen[name].terminalErrorInfo, `X15 ${name} info`).toBe('other');
      expect(JSON.parse(seen[name].terminalMessage).error.code, `X15 ${name} body code`).toBe(cases[name][1].error.code);
    }
  }, 400_000);

  it('X12 no egress and every rollout path stays under contextDir', () => {
    const unexpected = fixtures.flatMap(({ id, fx }) => fx.unexpected.map((u) => ({ id, path: u.path, reason: u.reason })));
    const counts = fixtures.map(({ id, fx, expectedMain }) => ({ id, actual: fx.requests.length, expected: expectedMain }));
    evidence.record('X12', { unexpected, counts, proxyAttempts: proxy.attempts, rolloutPaths });
    expect(unexpected, 'X12 unexpected requests').toEqual([]);
    expect(counts.filter((c) => c.actual !== c.expected), 'X12 model request counts').toEqual([]);
    expect(proxy.attempts, 'X12 deny proxy attempts').toEqual([]);
    expect(rolloutPaths.length > 0 && rolloutPaths.every((p) => under(ctx.contextDir, p)), 'X12 rollout paths').toBe(true);
  });
});

async function waitUntil(pred, timeoutMs, label) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
