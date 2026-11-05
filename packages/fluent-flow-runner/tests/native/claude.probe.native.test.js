
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createJsonlChannel } from '../../src/native/jsonl.js';
import { createClaudeControl } from '../../src/native/claude-control.js';
import { buildNativeEnv } from '../../src/native/native-env.js';
import { claudeArgs, NATIVE_OBSERVED, NATIVE_PINS, POLICY_OUTCOMES } from '../../src/native/pins.js';
import { assertNetworkIsolation } from './harness/isolation.js';
import { requireNativeBinary } from './harness/binaries.js';
import { createProbeContext, probeSpawnExtras, MARKERS } from './harness/context.js';
import { startAnthropicFixture } from './harness/anthropic-fixture.js';
import { startMcpFixture, MCP_TOOL } from './harness/mcp-fixture.js';
import { startDenyProxy } from './harness/deny-proxy.js';
import { createEvidence } from './harness/evidence.js';

const execFileAsync = promisify(execFile);
const MODEL = 'ff-probe-model';
const MCP_TOKEN = 'ff-probe-dummy-mcp-token';
const API_KEY = 'sk-ant-ff-probe-dummy-key';

const binary = requireNativeBinary('claude-code');
const WRONG = new Set();
const suite = binary ? describe : describe.skip;

suite('claude-code native probes', () => {
  /** @type {Awaited<ReturnType<typeof createProbeContext>>} */
  let ctx;
  let mcp;
  let proxy;
  let evidence;
  let mcpConfigPath;
  let settingsPath;
  /** @type {{ fx: any, expectedMain: number, id: string }[]} */
  const fixtures = [];
  const sessions = [];
  const live = new Set();

  beforeAll(async () => {
    await assertNetworkIsolation();
    ctx = await createProbeContext('claude-code');
    mcp = await startMcpFixture({ token: MCP_TOKEN });
    proxy = await startDenyProxy();
    evidence = createEvidence({ backend: 'claude-code', version: binary.version, root: ctx.root });
    mcpConfigPath = join(ctx.root, 'mcp.json');
    settingsPath = join(ctx.root, 'settings.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { ff_reporting: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${MCP_TOKEN}` } } } }),
    );
    writeFileSync(settingsPath, '{}');
  });

  afterAll(async () => {
    for (const s of live) s.child.kill('SIGKILL');
    for (const { fx } of fixtures) await fx.close();
    await mcp?.close();
    await proxy?.close();
    evidence?.flush();
    await ctx?.cleanup();
  });

  async function fixture(id, script, expectedMain = script.length) {
    const fx = await startAnthropicFixture({ script, mainModel: MODEL });
    fixtures.push({ fx, expectedMain, id });
    return fx;
  }

  function spawnEnv(fx) {
    return {
      ...buildNativeEnv({ backend: 'claude-code', contextDir: ctx.contextDir, parentEnv: ctx.parentEnv }),
      ...probeSpawnExtras({ home: ctx.home, proxyUrl: proxy.url }),
      ANTHROPIC_BASE_URL: fx.url,
      ANTHROPIC_API_KEY: API_KEY,
    };
  }

  /**
   * @param {{ fx: any, sessionId: string, resume?: boolean, onControlRequest?: Function, permissionMode?: string }} opts
   */
  function startSession({ fx, sessionId, resume = false, onControlRequest, permissionMode = 'manual' }) {
    const args = claudeArgs({ sessionId, resume, model: MODEL, permissionMode, mcpConfigPath, settingsPath, workspaceDir: ctx.repoDir });
    const child = spawn(binary.executable, args, { cwd: ctx.repoDir, env: spawnEnv(fx), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const channel = createJsonlChannel({ readable: child.stdout, writable: child.stdin });
    const controlRequests = [];
    const control = createClaudeControl(channel, {
      onControlRequest: async (req) => {
        controlRequests.push(req);
        if (!onControlRequest) throw new Error('probe did not expect a control request');
        return onControlRequest(req);
      },
    });
    const events = [];
    (async () => {
      for await (const e of control.events) events.push(e);
    })();
    const session = {
      child,
      control,
      channel,
      events,
      controlRequests,
      exited,
      get stderr() {
        return stderr;
      },
      async waitFor(pred, timeoutMs = 30_000, label = 'event') {
        const start = Date.now();
        for (;;) {
          const hit = events.find(pred);
          if (hit) return hit;
          if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}; stderr: ${stderr.slice(0, 400)}; control: ${JSON.stringify(controlRequests).slice(0, 800)}; last events: ${JSON.stringify(events.filter((e) => e.type !== 'stream_event').map((e) => (e.type === 'system' && e.subtype === 'init' ? 'system/init' : e)).slice(-6)).slice(0, 3000)}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      async stop() {
        live.delete(session);
        await channel.end().catch(() => {
        });
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(t);
      },
    };
    live.add(session);
    sessions.push({ sessionId, resume });
    return session;
  }

  const sanitizedEvents = (s) => s.events.filter((e) => e.type !== 'stream_event');
  const mainJson = (fx) => fx.requests.map((r) => JSON.stringify(r.body));

  let c2SessionId;

  it('C1 version is 2.1.317', () => {
    expect(binary.version, 'C1').toBe('2.1.317');
  });

  it('C2 initialize and system/init', async () => {
    const fx = await fixture('C2', [{ text: 'hello' }]);
    c2SessionId = randomUUID();
    const s = startSession({ fx, sessionId: c2SessionId });
    const init = await s.control.request('initialize', {}, { timeoutMs: 30_000 });
    expect(init, 'C2 initialize').toHaveProperty('commands');
    await s.control.sendUser({ uuid: randomUUID(), sessionId: c2SessionId, text: 'hello' });
    const sys = await s.waitFor((e) => e.type === 'system' && e.subtype === 'init', 30_000, 'C2 system/init');
    await s.waitFor((e) => e.type === 'result', 30_000, 'C2 result');
    await s.stop();
    const { tools, slash_commands, skills, agents, plugins, ...initShape } = sys;
    evidence.record('C2', { initialize: { keys: Object.keys(init) }, systemInit: initShape });
    expect(sys.session_id, 'C2 session_id').toBe(c2SessionId);
    expect(
      sys.mcp_servers.map(({ name, status }) => ({ name, status })),
      'C2 mcp_servers',
    ).toEqual([{ name: 'ff_reporting', status: 'connected' }]);
    expect(sys.apiKeySource, 'C2 auth source').toBe('ANTHROPIC_API_KEY');
  });

  it('C3 slash and @ text is replayed and reaches the model verbatim', async () => {
    const fx = await fixture('C3', [{ text: 'ok' }]);
    const sessionId = randomUUID();
    const uuid = randomUUID();
    const text = '/login --resume x @README.md';
    const s = startSession({ fx, sessionId });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid, sessionId, text });
    const replay = await s.waitFor((e) => e.type === 'user' && e.uuid === uuid, 30_000, 'C3 replay');
    await s.waitFor((e) => e.type === 'result', 30_000, 'C3 result');
    await s.stop();
    evidence.record('C3', { replay, events: sanitizedEvents(s).map((e) => e.type) });
    expect(replay.message.content, 'C3 replay content').toEqual([{ type: 'text', text }]);
    const carrying = fx.requests.filter((r) =>
      r.body.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'text' && c.text === text)),
    );
    expect(carrying.length, 'C3 verbatim model requests').toBe(1);
    expect(mainJson(fx).some((j) => j.includes('# readme')), 'C3 @README.md expanded').toBe(false);
  });

  it('C4 Bash permission arrives as can_use_tool and deny leaves no file', async () => {
    const markerPath = join(ctx.repoDir, 'c4-marker');
    const command = `touch ${markerPath}`;
    const fx = await fixture('C4', [{ tool: 'Bash', input: { command, description: 'probe' } }, { text: 'ok' }]);
    const sessionId = randomUUID();
    const s = startSession({
      fx,
      sessionId,
      onControlRequest: async ({ request }) => ({ behavior: 'deny', message: `denied ${request.tool_name}` }),
    });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid: randomUUID(), sessionId, text: 'run it' });
    await s.waitFor((e) => e.type === 'result', 30_000, 'C4 result');
    await s.stop();
    const req = s.controlRequests[0]?.request;
    evidence.record('C4', { canUseTool: req, events: sanitizedEvents(s).filter((e) => e.type === 'user').map((e) => e.message) });
    expect(req?.subtype, 'C4 subtype').toBe('can_use_tool');
    expect(req?.tool_name, 'C4 tool').toBe('Bash');
    expect(req?.input?.command, 'C4 exact command').toBe(command);
    expect(existsSync(markerPath), 'C4 file created').toBe(false);
    const second = fx.requests[1]?.body;
    const toolResult = second?.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_result');
    expect(toolResult?.is_error, 'C4 error tool result').toBe(true);
  });

  it('C5 AskUserQuestion uses the same callback and the answer reaches the model', async () => {
    const questions = [
      { question: 'Which color?', header: 'Choice', multiSelect: false, options: [{ label: 'Red, bright', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
      { question: 'Which size?', header: 'Choice', multiSelect: false, options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }] },
    ];
    const fx = await fixture('C5', [{ tool: 'AskUserQuestion', input: { questions } }, { text: 'ok' }]);
    const sessionId = randomUUID();
    const s = startSession({
      fx,
      sessionId,
      onControlRequest: async ({ request }) => ({
        behavior: 'allow',
        updatedInput: { ...request.input, answers: { 'Which color?': 'Red, bright', 'Which size?': 'Small' } },
      }),
    });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid: randomUUID(), sessionId, text: 'ask me' });
    await s.waitFor((e) => e.type === 'result', 30_000, 'C5 result');
    await s.stop();
    const req = s.controlRequests[0]?.request;
    const advertised = fx.requests[0]?.body.tools.find((t) => t.name === 'AskUserQuestion');
    evidence.record('C5', { canUseTool: req, nativeInputSchema: advertised?.input_schema, answerShape: { behavior: 'allow', updatedInput: { questions: '<as asked>', answers: { '<question text>': '<label>' } } } });
    expect(req?.subtype, 'C5 subtype').toBe('can_use_tool');
    expect(req?.tool_name, 'C5 tool').toBe('AskUserQuestion');
    expect(req?.input?.questions, 'C5 questions').toEqual(questions);
    const second = JSON.stringify(fx.requests[1]?.body.messages ?? []);
    expect(second.includes('Red, bright'), 'C5 answer reached model').toBe(true);
  });

  it('C6 reporting MCP call carries the dummy bearer', async () => {
    const fx = await fixture('C6', [
      { tool: 'ToolSearch', input: { query: `select:mcp__ff_reporting__${MCP_TOOL}`, max_results: 1 } },
      { tool: (n) => n.endsWith(`__${MCP_TOOL}`), input: { status: 'ok' } },
      { text: 'ok' },
    ]);
    const sessionId = randomUUID();
    const before = mcp.calls.length;
    const s = startSession({ fx, sessionId, onControlRequest: async ({ request }) => ({ behavior: 'allow', updatedInput: request.input }) });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid: randomUUID(), sessionId, text: 'report' });
    await s.waitFor((e) => e.type === 'result', 30_000, 'C6 result');
    await s.stop();
    const calls = mcp.calls.slice(before).filter((c) => c.method === 'tools/call');
    evidence.record('C6', { permission: s.controlRequests.map((r) => r.request.tool_name), calls: calls.map((c) => ({ ...c, authorization: c.authorization ? 'Bearer <dummy>' : null })) });
    expect(calls.length, 'C6 tools/call count').toBe(1);
    expect(calls[0].authorization, 'C6 bearer').toBe(`Bearer ${MCP_TOKEN}`);
    expect(calls[0].params.name, 'C6 tool').toBe(MCP_TOOL);
  });

  it('C7 project hook and .mcp.json are ignored, CLAUDE.md reaches the model', async () => {
    const fx = await fixture('C7', [{ text: 'ok' }]);
    const sessionId = randomUUID();
    const s = startSession({ fx, sessionId });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid: randomUUID(), sessionId, text: 'hi' });
    const sys = await s.waitFor((e) => e.type === 'system' && e.subtype === 'init', 30_000, 'C7 init');
    await s.waitFor((e) => e.type === 'result', 30_000, 'C7 result');
    await s.stop();
    const hasMarker = mainJson(fx).some((j) => j.includes(MARKERS.claudeMd));
    evidence.record('C7', { argvAddDir: true, hookRan: existsSync(ctx.hookMarker), mcpServers: sys.mcp_servers, plantedEndpointHits: [...ctx.plantedHits], additionalDirectories: sys.additional_directories, claudeMdInModelRequest: hasMarker });
    expect(existsSync(ctx.hookMarker), 'C7 planted hook ran').toBe(false);
    expect(ctx.plantedHits, 'C7 planted MCP endpoint contacted').toEqual([]);
    expect(sys.mcp_servers.map((m) => m.name), 'C7 planted .mcp.json').not.toContain(MARKERS.plantedMcp);
    expect(hasMarker, 'C7 CLAUDE.md marker in model request').toBe(true);
  });

  it('C8 interrupt with cancel_queued lists the queued message and aborts the held stream', async () => {
    const fx = await fixture('C8', [{ hold: true }], 1);
    const sessionId = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const s = startSession({ fx, sessionId });
    await s.control.request('initialize');
    await s.control.sendUser({ uuid: u1, sessionId, text: 'first' });
    await waitUntil(() => fx.requests.length === 1, 30_000, 'C8 held request');
    await s.control.sendUser({ uuid: u2, sessionId, text: 'second' });
    await s.waitFor((e) => e.type === 'command_lifecycle' && e.command_uuid === u2 && e.state === 'queued', 10_000, 'C8 queued');
    const receipt = await s.control.request('interrupt', { cancel_queued: true }, { timeoutMs: 15_000 });
    const result = await s.waitFor((e) => e.type === 'result', 15_000, 'C8 result');
    await waitUntil(() => fx.requests[0].aborted, 5_000, 'C8 abort').catch(() => {
    });
    await s.stop();
    evidence.record('C8', { receipt, result: { subtype: result.subtype, is_error: result.is_error, user_message_uuids: result.user_message_uuids }, aborted: fx.requests[0].aborted, mainRequests: fx.requests.length });
    expect(JSON.stringify(receipt).includes(u2), 'C8 receipt lists U2').toBe(true);
    expect(fx.requests[0].aborted, 'C8 held stream aborted').toBe(true);
    expect(fx.requests.length, 'C8 no model request for U2').toBe(1);
  });

  it('C9 resume after SIGTERM makes no model request until a new message', async () => {
    const fx = await fixture('C9', [{ hold: true }, { text: 'resumed' }]);
    const sessionId = randomUUID();
    const first = startSession({ fx, sessionId });
    await first.control.request('initialize');
    await first.control.sendUser({ uuid: randomUUID(), sessionId, text: 'start' });
    await waitUntil(() => fx.requests.length === 1, 30_000, 'C9 held request');
    first.child.kill('SIGTERM');
    await first.exited;
    live.delete(first);
    const second = startSession({ fx, sessionId, resume: true });
    await second.control.request('initialize');
    await new Promise((r) => setTimeout(r, 5_000));
    const quiet = fx.requests.length - 1;
    await second.control.sendUser({ uuid: randomUUID(), sessionId, text: 'continue' });
    await second.waitFor((e) => e.type === 'result', 30_000, 'C9 result');
    await second.stop();
    evidence.record('C9', { requestsDuringQuietWindow: quiet, requestsAfterMessage: fx.requests.length - 1, resumeEvents: sanitizedEvents(second).map((e) => `${e.type}${e.subtype ? `/${e.subtype}` : ''}`) });
    expect(quiet, 'C9 zero model requests in 5 s').toBe(0);
    expect(fx.requests.length - 1, 'C9 exactly one after new message').toBe(1);
  });

  it('C10 auth status reports the dummy context as JSON', async () => {
    const fx = await fixture('C10', [], 0);
    const { stdout } = await execFileAsync(binary.executable, ['auth', 'status', '--json'], { cwd: ctx.repoDir, env: spawnEnv(fx), timeout: 30_000 }).catch((err) => ({ stdout: err.stdout ?? '' }));
    const status = JSON.parse(stdout);
    evidence.record('C10', { argv: ['auth', 'status', '--json'], status });
    expect(status, 'C10 authMethod').toHaveProperty('authMethod');
  });

  it('C12 resume of an unknown id errors; reusing an existing session id never duplicates the transcript', async () => {
    const fx = await fixture('C12', [], 0);
    const unknown = randomUUID();
    const s = startSession({ fx, sessionId: unknown, resume: true });
    const initErr = await s.control.request('initialize', {}, { timeoutMs: 15_000 }).then(
      () => null,
      (e) => e.code,
    );
    const resultOrExit = await Promise.race([s.waitFor((e) => e.type === 'result', 15_000, 'C12 result').catch(() => null), s.exited]);
    await s.stop();
    const exit = await s.exited;
    const unknownOutcome = { initErr, result: resultOrExit?.type === 'result' ? { subtype: resultOrExit.subtype, is_error: resultOrExit.is_error } : null, exit, stderr: s.stderr.slice(0, 300) };

    const dupExpected = WRONG.has('C12') ? 1 : NATIVE_OBSERVED['claude-code'].existingSessionId === 'refused' ? 0 : 1;
    const fx2 = await fixture('C12-dup', [{ text: 'dup' }], dupExpected);
    const c2Transcript = findTranscripts(join(ctx.contextDir, 'projects'), c2SessionId)[0];
    const before = transcriptDigest(c2Transcript);
    const dup = startSession({ fx: fx2, sessionId: c2SessionId });
    const dupInit = await dup.control.request('initialize', {}, { timeoutMs: 15_000 }).then(
      () => 'ok',
      (e) => e.code,
    );
    if (dupInit === 'ok') {
      await dup.control.sendUser({ uuid: randomUUID(), sessionId: c2SessionId, text: 'again' }).catch(() => {
      });
      await Promise.race([dup.waitFor((e) => e.type === 'result', 15_000, 'C12 dup result').catch(() => null), dup.exited]);
    }
    await dup.stop();
    const dupExit = await dup.exited;
    const after = transcriptDigest(c2Transcript);
    const transcripts = findTranscripts(join(ctx.contextDir, 'projects'), c2SessionId);
    evidence.record('C12', {
      unknownResume: unknownOutcome,
      existingSessionId: { initialize: dupInit, exit: dupExit, modelRequests: fx2.requests.length, expectedModelRequests: dupExpected, stderr: dup.stderr.slice(0, 300), transcripts: transcripts.length, transcriptUnchanged: before.sha256 === after.sha256 && before.lines === after.lines, transcriptLines: after.lines },
    });
    expect(fx.requests.length, 'C12 unknown resume made a model request').toBe(0);
    expect(unknownOutcome.result?.is_error === true || (exit.code ?? 1) !== 0, 'C12 unknown resume error').toBe(true);
    expect(fx2.requests.length, 'C12 duplicate spawn model requests').toBe(fixtures.find((f) => f.id === 'C12-dup').expectedMain);
    expect(dupExit.code, 'C12 duplicate spawn exit').toBe(1);
    expect(after, 'C12 C2 transcript changed').toEqual(before);
    expect(transcripts.length, 'C12 duplicate transcript').toBe(1);
  });

  it('C13 every pinned permission mode has a recorded reporting and question outcome', async () => {
    const modes = [...NATIVE_PINS['claude-code'].permissionModes].slice(0, WRONG.has('C13') ? -1 : undefined);
    const questions = [{ question: 'Proceed with the probe?', header: 'Probe', multiSelect: false, options: [{ label: 'FF-C13-PROCEED', description: 'go' }, { label: 'No', description: 'stop' }] }];
    const outcomes = {};
    const rawOutcomes = {};
    const initModes = {};
    const details = {};
    for (const mode of modes) {
      const fx = await fixture(`C13-${mode}`, [
        { tool: 'ToolSearch', input: { query: `select:mcp__ff_reporting__${MCP_TOOL}`, max_results: 1 } },
        { tool: (n) => n.endsWith(`__${MCP_TOOL}`), input: { status: `c13-${mode}` } },
        { tool: 'AskUserQuestion', input: { questions } },
        { text: 'done' },
      ]);
      const sessionId = randomUUID();
      const callsBefore = mcp.calls.filter((c) => c.method === 'tools/call').length;
      const s = startSession({
        fx,
        sessionId,
        permissionMode: mode,
        onControlRequest: async ({ request }) =>
          request.tool_name === 'AskUserQuestion'
            ? { behavior: 'allow', updatedInput: { ...request.input, answers: { [questions[0].question]: 'FF-C13-PROCEED' } } }
            : { behavior: 'allow', updatedInput: request.input },
      });
      await s.control.request('initialize');
      await s.control.sendUser({ uuid: randomUUID(), sessionId, text: 'probe' });
      const sys = await s.waitFor((e) => e.type === 'system' && e.subtype === 'init', 30_000, `C13 ${mode} init`);
      await s.waitFor((e) => e.type === 'result', 60_000, `C13 ${mode} result`);
      await s.stop();
      initModes[mode] = sys.permissionMode;
      const asked = (pred) => s.controlRequests.filter((r) => r.request.subtype === 'can_use_tool' && pred(r.request.tool_name)).length;
      const reportingAsked = asked((n) => n.endsWith(`__${MCP_TOOL}`));
      const reportingCalls = mcp.calls.filter((c) => c.method === 'tools/call').length - callsBefore;
      const questionAsked = asked((n) => n === 'AskUserQuestion');
      const askResult = toolResultFor(fx, 'AskUserQuestion');
      const answerReached = JSON.stringify(askResult?.content ?? '').includes('FF-C13-PROCEED');
      const reporting = classify({ asked: reportingAsked, executed: reportingCalls });
      const question = classify({ asked: questionAsked, executed: askResult && askResult.is_error !== true ? 1 : 0 });
      rawOutcomes[mode] = { reporting, questions: question };
      const classifierCouldNotEvaluate = reporting === 'refused' && /could not evaluate/i.test(JSON.stringify(reportingResultFor(fx)?.content ?? ''));
      outcomes[mode] = { reporting: classifierCouldNotEvaluate ? 'unproven' : reporting, questions: question };
      const reportingResult = reportingResultFor(fx);
      details[mode] = { reportingAsked, reportingCalls, questionAsked, askToolResultIsError: askResult?.is_error ?? null, answerReached, modelRequests: fx.requests.length, sideRequests: fx.side.length, reportingToolResult: reportingResult ? { is_error: reportingResult.is_error ?? null, content: JSON.stringify(reportingResult.content).slice(0, 300) } : null };
    }
    evidence.record('C13', { initPermissionModes: initModes, policyOutcomes: outcomes, rawObservedOutcomes: rawOutcomes, details });
    expect(Object.keys(outcomes).sort(), 'C13 recorded modes').toEqual([...NATIVE_PINS['claude-code'].permissionModes].sort());
    for (const mode of modes) {
      expect(POLICY_OUTCOMES, `C13 ${mode} reporting outcome`).toContain(outcomes[mode].reporting);
      expect(POLICY_OUTCOMES, `C13 ${mode} question outcome`).toContain(outcomes[mode].questions);
      expect(outcomes[mode], `C13 ${mode} matches NATIVE_OBSERVED`).toEqual(NATIVE_OBSERVED['claude-code'].policyOutcomes[mode]);
      expect(initModes[mode], `C13 ${mode} init permissionMode`).toBe(NATIVE_OBSERVED['claude-code'].initPermissionModes[mode]);
      const d = details[mode];
      expect(d.reportingCalls, `C13 ${mode} reporting fixture calls`).toBe(rawOutcomes[mode].reporting === 'refused' ? 0 : 1);
      expect(d.reportingAsked, `C13 ${mode} reporting asks`).toBe(rawOutcomes[mode].reporting === 'asks' ? 1 : 0);
      expect(d.questionAsked, `C13 ${mode} question asks`).toBe(outcomes[mode].questions === 'asks' ? 1 : 0);
      if (outcomes[mode].questions === 'asks') expect(d.answerReached, `C13 ${mode} answer reached model`).toBe(true);
    }
  });

  it('C11 no egress and transcripts stay under contextDir', () => {
    const unexpected = fixtures.flatMap(({ id, fx }) => fx.unexpected.map((u) => ({ id, ...u, body: undefined })));
    const counts = fixtures.map(({ id, fx, expectedMain }) => ({ id, actual: fx.requests.length, expected: expectedMain }));
    const derived = ctx.repoDir.replace(/[^A-Za-z0-9]/g, '-');
    const transcript = join(ctx.contextDir, 'projects', derived, `${c2SessionId}.jsonl`);
    const realProject = join(homedir(), '.claude', 'projects', derived);
    evidence.record('C11', { unexpected, counts, proxyAttempts: proxy.attempts, transcriptUnderContext: existsSync(transcript), derivedProjectDir: derived, sessions });
    expect(unexpected, 'C11 unexpected requests').toEqual([]);
    expect(counts.filter((c) => c.actual !== c.expected), 'C11 main request counts').toEqual([]);
    expect(proxy.attempts, 'C11 deny proxy attempts').toEqual([]);
    expect(existsSync(transcript) && statSync(transcript).isFile(), 'C11 transcript under contextDir').toBe(true);
    expect(existsSync(realProject), 'C11 project dir under real home').toBe(false);
  });
});

function classify({ asked, executed }) {
  if (asked > 0 && executed > 0) return 'asks';
  if (asked === 0 && executed > 0) return 'runs';
  if (asked === 0 && executed === 0) return 'refused';
  return `inconsistent(asked=${asked},executed=${executed})`;
}

function reportingResultFor(fx) {
  const name = fx.requests[1]?.body.tools.find((t) => t.name.endsWith(`__${MCP_TOOL}`))?.name;
  return name ? toolResultFor(fx, name) : null;
}

function toolResultFor(fx, toolName) {
  for (const req of fx.requests) {
    const msgs = req.body.messages;
    const uses = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_use' && c.name === toolName);
    for (const use of uses) {
      const result = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_result' && c.tool_use_id === use.id);
      if (result) return result;
    }
  }
  return null;
}

function transcriptDigest(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), lines: bytes.toString('utf8').split('\n').filter(Boolean).length };
}

async function waitUntil(pred, timeoutMs, label) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function findTranscripts(dir, sessionId) {
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...findTranscripts(p, sessionId));
    else if (entry.name === `${sessionId}.jsonl`) hits.push(p);
  }
  return hits;
}
