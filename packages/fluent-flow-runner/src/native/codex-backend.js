
import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { answerBarrierRef, BackendContractError } from '../supervisor/backend-contract.js';
import { assessCodexLayers, FF_CODEX_MCP_SERVERS } from './codex-config-gate.js';
import { CODEX_LABELS, codexServerRequest, createCodexNormalizeContext, markOpenTurnsUnproven, normalizeCodexMessage, rpcRequestId } from './codex-normalize.js';
import { createCodexRpc } from './codex-rpc.js';
import { createJsonlChannel } from './jsonl.js';
import { buildNativeEnv } from './native-env.js';
import { codexArgs, codexLaunchControls, codexQuestionServerOverrides, NATIVE_OBSERVED, NATIVE_PINS, readNativeVersion } from './pins.js';
import { startQuestionServer } from './question-mcp.js';
import { readProcessDetails, sameProcess } from '../supervisor/process-identity.js';

const OBSERVED = NATIVE_OBSERVED.codex;
const REPORTING_SERVER = 'ff_reporting';
const QUESTIONS_SERVER = 'ff_questions';
const CLIENT_INFO = Object.freeze({ name: 'fluent-flow', title: null, version: '1' });
const CONTROL_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 20_000;
const MCP_READY_TIMEOUT_MS = 15_000;
const INTERRUPT_SETTLE_MS = 30_000;
const EXIT_WAIT_MS = 5_000;
const LOADED_LIST_MAX_PAGES = 1000;
const SANDBOX_TYPES = Object.freeze({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' });

export async function isCodexRetainedProcess({
  worker,
  candidate,
  executableFor = (pid) => nodeFs.realpathSync(`/proc/${pid}/exe`),
  detailsFor = readProcessDetails,
}) {
  if (!Number.isSafeInteger(worker?.pid) || !Number.isSafeInteger(candidate?.pid) || candidate.ppid !== worker.pid) return false;
  const [workerBefore, candidateBefore] = await Promise.all([detailsFor(worker.pid), detailsFor(candidate.pid)]);
  if (!sameProcess(worker, workerBefore) || !sameProcess(candidate, candidateBefore)) return false;
  if (candidateBefore.ppid !== workerBefore.pid || candidateBefore.ppid !== candidate.ppid) return false;
  if (typeof candidate.cgroup !== 'string' || candidateBefore.cgroup !== candidate.cgroup || candidateBefore.cgroup !== workerBefore.cgroup) return false;
  const workerExecutableBefore = executableFor(worker.pid);
  const candidateExecutableBefore = executableFor(candidate.pid);
  const [workerAfter, candidateAfter] = await Promise.all([detailsFor(worker.pid), detailsFor(candidate.pid)]);
  if (!sameProcess(worker, workerAfter) || !sameProcess(candidate, candidateAfter)) return false;
  if (candidateAfter.ppid !== workerAfter.pid || candidateAfter.cgroup !== candidate.cgroup || candidateAfter.cgroup !== workerAfter.cgroup) return false;
  const workerExecutableAfter = executableFor(worker.pid);
  const candidateExecutableAfter = executableFor(candidate.pid);
  return typeof workerExecutableBefore === 'string'
    && workerExecutableAfter === workerExecutableBefore
    && candidateExecutableBefore === join(dirname(workerExecutableBefore), 'codex-code-mode-host')
    && candidateExecutableAfter === candidateExecutableBefore;
}

export class CodexBackendError extends Error {
  /** @param {string} code @param {string} reason @param {ErrorOptions} [options] */
  constructor(code, reason, options) {
    super(`codex backend: ${code} (${reason})`, options);
    this.name = 'CodexBackendError';
    this.code = code;
    this.reason = reason;
  }
}

/**
 * @returns {{ ok: true } | { ok: false, code: 'startup_failed' | 'profile_unavailable', reason: string }}
 */
export function admitCodexThread({ profile, started, worktree }) {
  if (started?.thread?.cwd !== worktree) return { ok: false, code: 'startup_failed', reason: 'thread_cwd_mismatch' };
  if (started.model !== profile.model) return { ok: false, code: 'profile_unavailable', reason: 'model_mismatch' };
  if (started.approvalPolicy !== profile.policy?.approvalPolicy) return { ok: false, code: 'profile_unavailable', reason: 'approval_policy_mismatch' };
  const sandbox = started.sandbox;
  const expected = SANDBOX_TYPES[profile.policy?.sandbox];
  if (!expected || sandbox?.type !== expected) return { ok: false, code: 'profile_unavailable', reason: 'sandbox_mismatch' };
  if (expected === 'workspaceWrite' && sandbox.networkAccess !== profile.policy.networkAccess) return { ok: false, code: 'profile_unavailable', reason: 'sandbox_mismatch' };
  return { ok: true };
}

/**
 * @param {{ type: string, responseId: string, requestId: string, generation: number }} record
 * @param {{ generation: number, calls: Map<string, { barrier: Function, requestId: string, used: boolean }> }} worker
 */
export async function routeAnswerBarrier(record, { generation, calls }) {
  if (record?.generation !== generation) throw new BackendContractError('An answer barrier from another generation cannot use this worker');
  const call = calls.get(record.responseId);
  if (!call || call.requestId !== record.requestId || call.used) throw new BackendContractError('An answer barrier needs its own respond call');
  call.used = true;
  await call.barrier(answerBarrierRef(record));
}

const STEER_NOT_SUBMITTED = [/^no active turn to steer$/, /^expected active turn id `[^`]*` but found `[^`]*`$/, /^cannot steer a (review|compact) turn$/];

function steerNotSubmitted(rpcError) {
  return rpcError?.code === -32600 && typeof rpcError.message === 'string' && STEER_NOT_SUBMITTED.some((re) => re.test(rpcError.message));
}

function policyProblem(approvalPolicy) {
  const outcome = Object.hasOwn(OBSERVED.policyOutcomes, approvalPolicy) ? OBSERVED.policyOutcomes[approvalPolicy] : undefined;
  if (!outcome) return 'required_capability_unproven';
  const values = [outcome.reporting, outcome.questions];
  if (values.includes('refused')) return 'required_capability_blocked';
  if (values.some((v) => v !== 'runs' && v !== 'asks')) return 'required_capability_unproven';
  return null;
}

const suppression = () => ({ check_for_update_on_startup: false, 'analytics.enabled': false, 'feedback.enabled': false });

function launchOverrides({ profile, reportingUrl, questionsUrl, auth }) {
  const own = {
    model: profile.model,
    approval_policy: profile.policy.approvalPolicy,
    sandbox_mode: profile.policy.sandbox,
    'sandbox_workspace_write.network_access': profile.policy.networkAccess,
    ...suppression(),
    ...codexLaunchControls(),
    [`mcp_servers.${REPORTING_SERVER}.url`]: reportingUrl,
    [`mcp_servers.${REPORTING_SERVER}.bearer_token_env_var`]: 'FF_REPORTING_TOKEN',
    ...codexQuestionServerOverrides({ url: questionsUrl }),
  };
  const overlay = auth.args();
  if (Object.keys(overlay).some((key) => Object.hasOwn(own, key) || key === 'forced_login_method')) throw new BackendContractError('auth.args() may not replace FF launch overrides');
  return { ...own, ...overlay };
}

function validateOpen({ sessionId, profile, workspaceDir, reporting, resume, generation, spawn, effects, stopOwned }) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new BackendContractError('codex open needs a session id');
  if (profile?.backend !== 'codex' || profile.complete !== true) throw new BackendContractError('codex open needs a complete codex profile');
  if (typeof workspaceDir !== 'string' || !isAbsolute(workspaceDir)) throw new BackendContractError('workspaceDir must be absolute');
  if (typeof reporting?.url !== 'string' || typeof reporting?.credential !== 'string' || !reporting.credential) throw new BackendContractError('open needs a reporting url and credential');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BackendContractError('open needs a positive generation');
  if (typeof spawn !== 'function') throw new BackendContractError('open needs the supervisor spawn');
  if (typeof effects?.barrier !== 'function' || typeof effects?.bind !== 'function') throw new BackendContractError('open needs effects');
  if (typeof stopOwned !== 'function') throw new BackendContractError('codex open needs the supervisor-bound stopOwned');
  if (resume !== null && (typeof resume?.nativeSessionId !== 'string' || resume.nativeSessionId === '')) throw new BackendContractError('resume needs a recorded native thread id');
}

function createQueue() {
  const items = [];
  /** @type {((value?: unknown) => void) | null} */
  let wake = null;
  let ended = false;
  return {
    push(item) {
      if (ended) return;
      items.push(item);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

/**
 * @param {{ log: { info: Function, warn: Function, error: Function }, auth: { readiness: Function, admitsAuthMode: Function, env: () => Record<string, string>, args: () => Record<string, string|number|boolean> }, parentEnv?: Record<string, string|undefined>, platform?: string, readVersion?: (profile: any) => Promise<string>, readAccount?: (profile: any) => Promise<any> }} opts
 */
export function createCodexBackend({ log, auth, parentEnv = process.env, platform = process.platform, readVersion, readAccount }) {
  if (!log || !auth || typeof auth.readiness !== 'function' || typeof auth.admitsAuthMode !== 'function' || typeof auth.env !== 'function' || typeof auth.args !== 'function') {
    throw new BackendContractError('createCodexBackend needs log and auth');
  }

  const nativeEnv = (profile, tokens = {}) => ({ ...buildNativeEnv({ backend: 'codex', contextDir: profile.contextDir, parentEnv, ...tokens }), ...auth.env() });
  const versionOf = readVersion ?? ((profile) => readNativeVersion({ backend: 'codex', executable: profile.executable, env: nativeEnv(profile) }));
  const accountOf = readAccount ?? ((profile) => readAccountOnce(profile, { env: nativeEnv(profile), overrides: { ...suppression(), ...codexLaunchControls(), ...auth.args() } }));

  async function readiness(profile) {
    if (platform !== 'linux') return { state: 'platform_unsupported' };
    let version;
    try {
      version = await versionOf(profile);
    } catch (err) {
      if (err?.code === 'ENOENT') return { state: 'not_installed' };
      log.warn({ msg: 'codex version unreadable', profileId: profile.id, reason: 'version_unreadable', errorCode: err?.code });
      return { state: 'incompatible' };
    }
    if (!NATIVE_PINS.codex.versions.includes(version)) return { state: 'incompatible', version };
    const problem = policyProblem(profile.policy?.approvalPolicy);
    if (problem) {
      log.warn({ msg: 'codex approval policy cannot run required reporting and questions unaltered', profileId: profile.id, reason: problem });
      return { state: 'invalid_config', version };
    }
    let account;
    try {
      account = await accountOf(profile);
    } catch (err) {
      log.warn({ msg: 'codex account unreadable', profileId: profile.id, reason: 'account_unreadable', errorCode: err?.code });
      return { state: 'sign_in_required', version };
    }
    const judged = auth.readiness({ account });
    if (judged?.state !== 'ready') {
      log.warn({ msg: 'codex sign-in not admitted', profileId: profile.id, reason: judged?.reason ?? 'refused' });
      return { state: 'sign_in_required', version };
    }
    return { state: 'ready', version };
  }

  async function open(opts) {
    validateOpen(opts);
    const { sessionId, profile, workspaceDir, reporting, resume, generation, spawn, effects, stopOwned } = opts;
    const worktree = nodeFs.realpathSync(workspaceDir);
    const session = createSession({ log, auth, profile, sessionId, generation, worktree, stopOwned, resumed: resume !== null });
    await session.startQuestions();
    const overrides = launchOverrides({ profile, reportingUrl: reporting.url, questionsUrl: session.questionsUrl, auth });
    const env = nativeEnv(profile, { reportingToken: reporting.credential, questionsToken: session.questionsToken });
    let spawned;
    try {
      spawned = await spawn({ executable: profile.executable, args: codexArgs({ overrides }), env, cwd: worktree });
    } catch (err) {
      await session.abandon();
      throw new CodexBackendError('startup_failed', 'spawn_failed', { cause: err });
    }
    session.attach(spawned);
    return session.handshake({ overrides, resume, effects });
  }

  async function readAccountOnce(profile, { env, overrides }) {
    const child = spawnChild(profile.executable, codexArgs({ overrides }), { cwd: profile.contextDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const rpc = createCodexRpc(createJsonlChannel({ readable: child.stdout, writable: child.stdin }));
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, { timeoutMs: CONTROL_TIMEOUT_MS });
      await rpc.notify('initialized');
      return await rpc.request('account/read', { refreshToken: false }, { timeoutMs: CONTROL_TIMEOUT_MS });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  return Object.freeze({ id: 'codex', readiness, open });
}

function createSession({ log, auth, profile, sessionId, generation, worktree, stopOwned, resumed }) {
  const ctx = createCodexNormalizeContext({ model: null, resumed });
  const output = createQueue();
  const questionsToken = randomBytes(32).toString('hex');
  /** @type {Awaited<ReturnType<typeof startQuestionServer>> | null} */
  let questions = null;
  /** @type {{ child: any, identity: any } | null} */
  let proc = null;
  /** @type {ReturnType<typeof createCodexRpc> | null} */
  let rpc = null;
  /** @type {Promise<{ code: number|null, signal: string|null }> | null} */
  let exited = null;
  let threadId = null;
  let closed = false;
  let seq = 0;

  /** @type {{ ok: true } | { ok: false, code: string, reason: string } | null} */
  let threadAdmission = null;
  /** @type {{ ok: true } | null} */
  let readyAdmission = null;
  /** @type {{ code: string, reason: string } | null} */
  let startupBlock = null;
  let reconciling = false;
  let authBlocked = false;
  let promptDispatched = false;
  /** @type {Promise<string> | null} */
  let stopping = null;
  /** @type {{ actualModel: string|null } | null} */
  let profileViolation = null;
  const mcpStatus = new Map();

  let activeTurnId = null;
  /** @type {Map<string, string>} turnId -> terminal */
  const turnOutcomes = new Map();
  /** @type {Map<string, { phase: 'pending' | 'written' | 'undispatched', turnId: string|null, targetTurnId: string|null, outcome: string|null }>} */
  const prompts = new Map();
  /** @type {Array<{ check: () => boolean, resolve: () => void, reject: (error: unknown) => void }>} */
  const progressWaiters = [];

  /** @type {Map<string, any>} */
  const approvals = new Map();
  /** @type {Map<number|string, { attempted: boolean, resolve: (value?: unknown) => void, reject: (error: unknown) => void }>} */
  const writeWaiters = new Map();
  /** @type {Map<string, any>} */
  const questionRequests = new Map();
  /** @type {Map<string, { requestId: string, commandId: string|null }>} */
  const questionCalls = new Map();
  /** @type {Map<string, { barrier: Function, requestId: string, used: boolean }>} */
  const answerBarriers = new Map();

  const push = (event) => output.push(event);

  function wakeProgress() {
    for (const w of [...progressWaiters]) {
      if (!w.check()) continue;
      progressWaiters.splice(progressWaiters.indexOf(w), 1);
      w.resolve();
    }
  }

  function waitProgress(check, ms, onTimeout) {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = progressWaiters.indexOf(waiter);
        if (i >= 0) progressWaiters.splice(i, 1);
        reject(onTimeout());
      }, ms);
      const waiter = {
        check,
        resolve: () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      progressWaiters.push(waiter);
    });
  }

  function markReconciling(reason, extra = {}) {
    log.warn({ msg: 'codex session reconciling', sessionId, generation, reason, ...extra });
    if (reconciling) return;
    reconciling = true;
    push({ kind: 'state', nativeEventId: `session:reconciling:${++seq}`, payload: { state: 'reconciling' } });
  }


  async function recordQuestion(entry) {
    if (entry.type === 'answer_barrier') {
      await routeAnswerBarrier(entry, { generation, calls: answerBarriers });
      const calls = [...questionCalls.values()].find((c) => c.requestId === entry.requestId);
      if (calls) calls.commandId = entry.responseId;
      return;
    }
    const { type, requestId, ...rest } = entry;
    push({ kind: 'attention', nativeEventId: `question:${requestId}:${type}:${++seq}`, payload: { nativeRequestId: requestId, record: type, ...rest } });
  }

  function admitQuestion(req) {
    const c = req.correlation;
    let reason = null;
    if (closed) reason = 'worker_closed';
    else if (req.generation !== generation) reason = 'generation_mismatch';
    else if (typeof c?.threadId !== 'string' || c.threadId !== threadId) reason = 'thread_not_owned';
    else if (typeof c.turnId !== 'string') reason = 'turn_missing';
    else if (c.turnId !== activeTurnId || turnOutcomes.has(c.turnId)) reason = 'turn_not_active';
    if (!reason) return { ok: true };
    markReconciling('question_correlation_unproven', { why: reason });
    return { ok: false, reason };
  }

  function questionPending(req) {
    const publicRequest = {
      nativeRequestId: req.requestId,
      kind: 'question',
      fingerprint: req.fingerprint,
      secret: req.secret,
      hostOnly: req.secret,
      generation: req.generation,
      choices: [{ id: 'decline', label: CODEX_LABELS.denyContinue, scope: 'once', behavior: 'deny' }],
      questions: req.questions,
      correlation: { ...req.correlation },
    };
    questionRequests.set(req.requestId, publicRequest);
    questionCalls.set(req.correlation.callId, { requestId: req.requestId, commandId: null });
    push({ kind: 'attention', nativeEventId: `question:${req.requestId}:pending`, payload: { ...publicRequest, state: 'pending' } });
  }

  function questionSettled(req, outcome) {
    questionRequests.delete(req.requestId);
    push({ kind: 'attention', nativeEventId: `question:${req.requestId}:settled:${++seq}`, payload: { nativeRequestId: req.requestId, state: outcome?.state ?? 'settled', ...(outcome?.reason ? { reason: outcome.reason } : {}) } });
  }


  function onNotification(message) {
    const params = message.params ?? {};
    switch (message.method) {
      case 'mcpServer/startupStatus/updated':
        if (!FF_CODEX_MCP_SERVERS.includes(params.name)) unexpectedServer(params.name);
        else mcpStatus.set(params.name, params.status);
        break;
      case 'account/updated':
        if (!auth.admitsAuthMode(params.authMode ?? null) && !authBlocked) {
          authBlocked = true;
          log.warn({ msg: 'codex auth mode changed; admission stopped', sessionId, generation, reason: 'auth_mode_not_admitted' });
          push({ kind: 'state', nativeEventId: `session:sign_in_required:${++seq}`, payload: { state: 'sign_in_required' } });
        }
        break;
      case 'turn/started':
        if (typeof params.turn?.id === 'string' && !turnOutcomes.has(params.turn.id)) activeTurnId = params.turn.id;
        break;
      case 'serverRequest/resolved': {
        const id = rpcRequestId(params.requestId);
        const entry = approvals.get(id);
        if (entry && !ctx.ffResolved.has(id)) {
          entry.withdrawn = true;
          approvals.delete(id);
          const waiter = writeWaiters.get(entry.rpcId);
          if (waiter && !waiter.attempted) waiter.resolve('withdrawn');
        }
        break;
      }
      default:
        break;
    }
    for (const event of normalizeCodexMessage(message, ctx)) push(profileViolation && event.terminal ? violatedTerminal(event) : event);
    if (message.method === 'model/rerouted') modelRerouted(params);
    if (message.method === 'item/completed' && params.item?.type === 'mcpToolCall' && questionCalls.has(params.item.id)) {
      const call = questionCalls.get(params.item.id);
      questionCalls.delete(params.item.id);
      push({
        kind: 'attention',
        nativeEventId: `question:${call.requestId}:resolved`,
        payload: { nativeRequestId: call.requestId, state: 'resolved', resolvedBy: call.commandId ? 'ff' : 'native' },
        ...(call.commandId ? { receiptFor: call.commandId } : {}),
      });
    }
    if (message.method === 'turn/completed') turnEnded(params);
    wakeProgress();
  }

  function turnEnded(params) {
    const turnId = params.turn?.id;
    if (typeof turnId !== 'string') return;
    const status = params.turn.status;
    const terminal = status === 'completed' || status === 'interrupted' || status === 'failed' ? status : null;
    if (!terminal) return;
    turnOutcomes.set(turnId, terminal);
    if (activeTurnId === turnId) activeTurnId = null;
    for (const entry of prompts.values()) if (entry.turnId === turnId && entry.outcome === null) entry.outcome = profileViolation ? 'failed' : terminal;
    if (questions) {
      questions.withdrawTurn({ threadId: params.threadId, turnId, generation, reason: terminal === 'interrupted' ? 'turn_interrupted' : 'turn_ended' }).catch((err) => {
        markReconciling('question_withdrawal_failed', { error: err instanceof Error ? err.name : 'error' });
      });
    }
  }

  function ownedStop(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        return await stopOwned({ reason });
      } catch (err) {
        log.error({ msg: 'codex owned stop failed', sessionId, generation, reason, error: err instanceof Error ? err.name : 'error' });
        return 'uncertain';
      }
    })();
    stopping.then((result) => {
      log.warn({ msg: 'codex owned stop finished', sessionId, generation, reason, stop: result });
      if (result !== 'quiesced') markReconciling(reason, { stop: result });
    });
    return stopping;
  }

  function unexpectedServer(name) {
    if (stopping) return;
    const beforePrompt = !promptDispatched;
    if (beforePrompt) startupBlock = { code: 'startup_failed', reason: 'unexpected_mcp_server' };
    else markReconciling('unexpected_mcp_server');
    log.warn({ msg: 'codex reported an unexpected MCP server; stopping the worker', sessionId, generation, reason: 'unexpected_mcp_server', server: name });
    ownedStop('unexpected_mcp_server');
  }

  function modelRerouted(params) {
    const ownThread = typeof params.threadId === 'string' && params.threadId === threadId;
    const validModel = (v) => (typeof v === 'string' && v !== '' ? v : null);
    const toModel = validModel(params.toModel);
    const fromModel = validModel(params.fromModel);
    if (ownThread && toModel === profile.model && fromModel === profile.model) return;
    const actualModel = ownThread ? toModel : null;
    if (!actualModel) {
      ctx.model = null;
      markOpenTurnsUnproven(ctx);
    }
    if (profileViolation) return;
    profileViolation = { actualModel };
    const str = (v) => (typeof v === 'string' ? v : null);
    log.warn({ msg: 'codex reported a model other than the selected profile; stopping the worker', sessionId, generation, reason: ownThread && toModel ? 'model_rerouted' : 'model_reroute_unproven' });
    push({
      kind: 'state',
      nativeEventId: `session:profile_violation:${++seq}`,
      payload: { state: 'profile_violation', errorCode: 'profile_unavailable', threadId: str(params.threadId), turnId: str(params.turnId), selectedModel: profile.model, actualModel, fromModel: ownThread ? fromModel : null, reason: str(params.reason) },
    });
    ownedStop('model_rerouted');
  }

  function violatedTerminal(event) {
    return { ...event, terminal: 'failed', payload: { ...event.payload, state: 'failed', nativeState: event.payload.state, errorCode: 'profile_unavailable' } };
  }

  function onServerRequest(req) {
    const offered = codexServerRequest(req, ctx);
    if ('unsupported' in offered) {
      const nativeRequestId = rpcRequestId(req.id);
      log.warn({ msg: 'codex server request not supported', sessionId, generation, reason: 'unsupported_server_request', method: req.method });
      push({ kind: 'attention', nativeEventId: `request:${nativeRequestId}:unsupported`, payload: { nativeRequestId, state: 'unsupported', method: req.method } });
      return Promise.resolve({ error: { code: -32601, message: 'Request not supported' } });
    }
    return new Promise((resolve) => {
      const entry = { ...offered, rpcId: req.id, settled: false, withdrawn: false, resolve };
      approvals.set(offered.publicRequest.nativeRequestId, entry);
      push({ kind: 'attention', nativeEventId: `request:${offered.publicRequest.nativeRequestId}`, payload: { ...offered.publicRequest, state: 'pending' } });
      if (offered.reconcile) markReconciling('approval_choices_unavailable', { method: req.method });
    });
  }

  function streamClosed() {
    closed = true;
    const error = new CodexBackendError('reconciling', 'native_stream_closed');
    for (const w of progressWaiters.splice(0)) w.reject(error);
    for (const [, w] of writeWaiters) {
      if (w.attempted) w.reject(error);
      else w.resolve('withdrawn');
    }
    output.end();
  }

  async function kill() {
    closed = true;
    const child = proc?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), EXIT_WAIT_MS).unref())]);
    if (done === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  async function abandon() {
    await kill();
    try {
      await questions?.close();
    } catch (err) {
      log.error({ msg: 'codex question server close failed while abandoning open', sessionId, generation, error: err instanceof Error ? err.name : 'error' });
    }
  }

  async function fail(code, reason, cause) {
    log.warn({ msg: 'codex open failed', sessionId, generation, code, reason });
    await abandon();
    return new CodexBackendError(code, reason, cause ? { cause } : undefined);
  }

  async function loadedThreadIds(control) {
    const ids = [];
    let cursor = null;
    for (let page = 0; page < LOADED_LIST_MAX_PAGES; page += 1) {
      const res = await control.request('thread/loaded/list', cursor ? { cursor } : {}, { timeoutMs: CONTROL_TIMEOUT_MS });
      if (!Array.isArray(res?.data) || res.data.some((id) => typeof id !== 'string')) throw new CodexBackendError('reconciling', 'loaded_list_unreadable');
      ids.push(...res.data);
      if (res.nextCursor === null || res.nextCursor === undefined) return ids;
      cursor = res.nextCursor;
    }
    throw new CodexBackendError('reconciling', 'loaded_list_unbounded');
  }

  /**
   * @returns {Promise<{ ok: true, thread: any } | { ok: false, reason: string }>}
   */
  async function recoverLostThread(control, baseline, sinceMs) {
    let fresh;
    try {
      fresh = (await loadedThreadIds(control)).filter((id) => !baseline.has(id));
    } catch (err) {
      log.warn({ msg: 'codex loaded-thread listing failed after a lost thread/start', sessionId, generation, reason: 'loaded_list_failed', error: err instanceof Error ? err.name : 'error' });
      return { ok: false, reason: 'lost_create_unlisted' };
    }
    if (fresh.length !== 1) return { ok: false, reason: fresh.length === 0 ? 'lost_create_not_found' : 'lost_create_ambiguous' };
    let read;
    try {
      read = await control.request('thread/read', { threadId: fresh[0] }, { timeoutMs: CONTROL_TIMEOUT_MS });
    } catch (err) {
      log.warn({ msg: 'codex lost-create candidate unreadable', sessionId, generation, reason: 'lost_create_unreadable', error: err instanceof Error ? err.name : 'error' });
      return { ok: false, reason: 'lost_create_unreadable' };
    }
    const thread = read?.thread;
    if (thread?.id !== fresh[0]) return { ok: false, reason: 'lost_create_identity_mismatch' };
    if (thread.cwd !== worktree) return { ok: false, reason: 'lost_create_foreign' };
    if (!Number.isFinite(thread.createdAt) || thread.createdAt < Math.floor(sinceMs / 1000)) return { ok: false, reason: 'lost_create_preexisting' };
    return { ok: true, thread };
  }


  const requireBarrier = (barrier, method) => {
    if (typeof barrier !== 'function') throw new BackendContractError(`${method}() needs its per-call barrier`);
  };
  const unavailable = () => ({ state: /** @type {const} */ ('failed'), errorCode: 'request_unavailable' });
  const text = (value) => [{ type: 'text', text: value, text_elements: [] }];

  /** @returns {Promise<{ ok: true } | { ok: false, code: string, reason: string }>} */
  async function admitPrompt() {
    if (threadAdmission && !threadAdmission.ok) return threadAdmission;
    if (readyAdmission) return readyAdmission;
    const check = () => {
      const states = [mcpStatus.get(REPORTING_SERVER), mcpStatus.get(QUESTIONS_SERVER)];
      if (states.some((s) => s === 'failed' || s === 'cancelled')) return { ok: /** @type {const} */ (false), code: 'startup_failed', reason: 'ff_mcp_not_ready' };
      if (states.every((s) => s === 'ready')) return { ok: /** @type {const} */ (true) };
      return null;
    };
    try {
      await waitProgress(() => check() !== null || startupBlock !== null, MCP_READY_TIMEOUT_MS, () => new CodexBackendError('startup_failed', 'ff_mcp_ready_timeout'));
    } catch (err) {
      if (err instanceof CodexBackendError && err.code === 'startup_failed') return { ok: false, code: err.code, reason: err.reason };
      throw err;
    }
    const verdict = check();
    if (verdict?.ok) readyAdmission = verdict;
    return verdict ?? { ok: false, code: 'startup_failed', reason: 'ff_mcp_not_ready' };
  }

  const worker = {
    nativeSessionId: /** @type {string|null} */ (null),
    identity: null,
    events: output,

    async send({ commandId, text: value, mode, barrier }) {
      requireBarrier(barrier, 'send');
      if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('send needs a commandId');
      if (typeof value !== 'string' || value === '') throw new BackendContractError('send needs text');
      if (mode !== 'start' && mode !== 'steer') throw new BackendContractError('send mode must be start or steer');
      if (prompts.has(commandId)) throw new BackendContractError('send commandIds are single-use');
      const refuse = () => {
        if (startupBlock) return new CodexBackendError(startupBlock.code, startupBlock.reason);
        if (profileViolation) return new CodexBackendError('profile_unavailable', 'model_rerouted');
        if (reconciling || closed) return new CodexBackendError('reconciling', closed ? 'worker_closed' : 'session_reconciling');
        if (authBlocked) return new CodexBackendError('sign_in_required', 'auth_mode_not_admitted');
        return null;
      };
      const early = refuse();
      if (early) throw early;
      if (mode === 'steer' && !activeTurnId) throw new CodexBackendError('request_unavailable', 'no_active_turn');
      const entry = {
        phase: /** @type {'pending' | 'written' | 'undispatched'} */ ('pending'),
        turnId: /** @type {string|null} */ (null),
        targetTurnId: /** @type {string|null} */ (null),
        outcome: /** @type {string|null} */ (null),
      };
      prompts.set(commandId, entry);
      const cancelled = () => ({ receipt: { commandId, state: 'cancelled', dispatched: false } });
      if (!promptDispatched) {
        let admitted;
        try {
          admitted = await admitPrompt();
        } catch (err) {
          prompts.delete(commandId);
          throw err;
        }
        if (entry.phase === 'undispatched') return cancelled();
        const late = admitted.ok === false ? new CodexBackendError(admitted.code, admitted.reason) : refuse();
        if (late) {
          if (admitted.ok === false) log.warn({ msg: 'codex prompt not admitted', sessionId, generation, code: admitted.code, reason: admitted.reason });
          prompts.delete(commandId);
          throw late;
        }
      }
      try {
        await barrier({ clientUserMessageId: commandId });
      } catch (err) {
        prompts.delete(commandId);
        throw err;
      }
      if (entry.phase === 'undispatched') return cancelled();
      const blocked = refuse();
      const expectedTurnId = activeTurnId;
      if (blocked || (mode === 'steer' && !expectedTurnId)) {
        prompts.delete(commandId);
        throw blocked ?? new CodexBackendError('request_unavailable', 'no_active_turn');
      }
      entry.phase = 'written';
      entry.targetTurnId = activeTurnId;
      promptDispatched = true;
      let turnId;
      try {
        if (mode === 'start') {
          const res = await /** @type {any} */ (rpc).request('turn/start', { threadId, input: text(value), clientUserMessageId: commandId }, { timeoutMs: CONTROL_TIMEOUT_MS });
          turnId = res?.turn?.id;
        } else {
          const res = await /** @type {any} */ (rpc).request('turn/steer', { threadId, expectedTurnId, input: text(value), clientUserMessageId: commandId }, { timeoutMs: CONTROL_TIMEOUT_MS });
          turnId = res?.turnId;
        }
      } catch (err) {
        if (mode === 'steer' && steerNotSubmitted(err?.rpcError)) {
          prompts.delete(commandId);
          wakeProgress();
          log.warn({ msg: 'codex refused the steer before submitting it', sessionId, generation, reason: 'steer_not_submitted' });
          throw new CodexBackendError('request_unavailable', 'steer_not_submitted', { cause: err });
        }
        prompts.delete(commandId);
        wakeProgress();
        log.warn({ msg: 'codex prompt outcome unknown after its write', sessionId, generation, reason: err?.rpcError ? `${mode}_error` : 'prompt_write_failed' });
        throw new CodexBackendError('reconciling', err?.rpcError ? `${mode}_error` : 'prompt_write_failed', { cause: err });
      }
      if (typeof turnId !== 'string') throw new CodexBackendError('reconciling', 'prompt_receipt_unreadable');
      entry.turnId = turnId;
      if (turnOutcomes.has(turnId)) entry.outcome = turnOutcomes.get(turnId) ?? null;
      else if (mode === 'start') activeTurnId = turnId;
      wakeProgress();
      return { receipt: { commandId, turnId, state: 'started', dispatched: true } };
    },

    async respond({ commandId, nativeRequestId, response, source, barrier }) {
      requireBarrier(barrier, 'respond');
      if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('respond needs a commandId');
      if (source !== 'web' && source !== 'local') throw new BackendContractError('respond source must be web or local');
      if (typeof nativeRequestId !== 'string' || nativeRequestId === '') return unavailable();
      if (nativeRequestId.startsWith('rpc:')) return respondApproval({ nativeRequestId, response, source, barrier });
      return respondQuestion({ commandId, nativeRequestId, response, source, barrier });
    },

    async interrupt({ commandId, barrier }) {
      requireBarrier(barrier, 'interrupt');
      if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('interrupt needs a commandId');
      if (closed) throw new CodexBackendError('reconciling', 'worker_closed');
      await barrier({});
      const reconcile = () => new CodexBackendError('reconciling', 'interrupt_unsettled');
      const turnsKnown = () => [...prompts.values()].every((e) => e.phase !== 'written' || e.outcome !== null || e.turnId !== null || e.targetTurnId !== null);
      while (!closed && !turnsKnown()) await waitProgress(() => closed || turnsKnown(), INTERRUPT_SETTLE_MS, reconcile);
      if (closed) throw new CodexBackendError('reconciling', 'worker_closed');
      for (const [id, e] of prompts) if (e.phase === 'written' && e.outcome !== null) prompts.delete(id);
      const boundary = [...prompts.entries()];
      const undispatched = boundary.filter(([, e]) => e.phase === 'pending').map(([id]) => id);
      for (const id of undispatched) /** @type {any} */ (prompts.get(id)).phase = 'undispatched';
      const watched = boundary.filter(([, e]) => e.phase === 'written').map(([id]) => id);
      const settledList = () =>
        boundary.map(([id, e]) => (e.phase === 'undispatched' ? { commandId: id, outcome: 'cancelled', dispatched: false } : { commandId: id, outcome: e.outcome, dispatched: true }));
      try {
        const turnId = activeTurnId;
        if (!turnId) {
          const result = { receipt: null, terminal: null, settled: settledList(), dispatched: false };
          for (const id of watched) prompts.delete(id);
          return result;
        }
        let receipt;
        try {
          receipt = await /** @type {any} */ (rpc).request('turn/interrupt', { threadId, turnId }, { timeoutMs: CONTROL_TIMEOUT_MS });
        } catch (err) {
          if (!err?.rpcError) throw new CodexBackendError('reconciling', 'interrupt_unconfirmed', { cause: err });
          receipt = null;
        }
        await waitProgress(() => turnOutcomes.has(turnId) && watched.every((id) => prompts.get(id)?.outcome !== null), INTERRUPT_SETTLE_MS, reconcile);
        const settled = settledList();
        for (const id of watched) prompts.delete(id);
        return { receipt, terminal: turnOutcomes.get(turnId) ?? null, settled, dispatched: true };
      } finally {
        for (const id of undispatched) prompts.delete(id);
      }
    },

    pending() {
      return [...[...approvals.values()].filter((e) => !e.settled).map((e) => e.publicRequest), ...questionRequests.values()];
    },

    retainsProcess(candidate) {
      return isCodexRetainedProcess({ worker: worker.identity, candidate });
    },

    idle() {
      return !closed && activeTurnId === null && ![...prompts.values()].some((e) => e.phase === 'pending' || (e.phase === 'written' && e.outcome === null));
    },

    /** @param {{ reason?: string }} [opts] */
    async close({ reason } = {}) {
      log.info({ msg: 'codex worker closing', sessionId, generation, reason: reason ?? 'unspecified' });
      let failure = null;
      try {
        await questions?.close();
      } catch (err) {
        failure = err;
      }
      await kill();
      if (failure) throw failure;
    },
  };

  async function respondApproval({ nativeRequestId, response, source, barrier }) {
    const entry = approvals.get(nativeRequestId);
    if (closed || !entry || entry.settled || entry.withdrawn) return unavailable();
    const { publicRequest } = entry;
    if (response?.fingerprint !== undefined && response.fingerprint !== publicRequest.fingerprint) return unavailable();
    const choice = publicRequest.choices.find((c) => c.id === response?.selectedActionId);
    if (!choice || response.behavior !== choice.behavior) return unavailable();
    const ref = { nativeRequestId, requestKind: 'permission', fingerprint: publicRequest.fingerprint, source, operation: choice.behavior === 'deny' ? 'decline' : 'answer' };
    entry.settled = true;
    try {
      await barrier(ref);
    } catch (err) {
      entry.settled = false;
      throw err;
    }
    if (closed || entry.withdrawn || approvals.get(nativeRequestId) !== entry) return unavailable();
    const written = new Promise((resolve, reject) => writeWaiters.set(entry.rpcId, { attempted: false, resolve, reject }));
    approvals.delete(nativeRequestId);
    ctx.ffResolved.add(nativeRequestId);
    entry.resolve({ result: structuredClone(entry.responses.get(choice.id)) });
    try {
      if ((await written) === 'withdrawn') return unavailable();
    } catch (err) {
      log.warn({ msg: 'codex approval write failed after its barrier', sessionId, generation, nativeRequestId, reason: err?.code ?? 'write_failed' });
      return { state: 'reconciling' };
    } finally {
      writeWaiters.delete(entry.rpcId);
    }
    return { state: 'dispatched' };
  }

  async function respondQuestion({ commandId, nativeRequestId, response, source, barrier }) {
    if (closed || !questions) return unavailable();
    const known = questionRequests.get(nativeRequestId);
    if (known && response?.fingerprint !== undefined && response.fingerprint !== known.fingerprint) return unavailable();
    let operation;
    if (response?.selections !== undefined) operation = 'answer';
    else if (response?.selectedActionId === 'decline' && response?.behavior === 'deny') operation = 'decline';
    else return unavailable();
    if (answerBarriers.has(commandId)) throw new BackendContractError('respond commandIds are single-use');
    answerBarriers.set(commandId, { barrier, requestId: nativeRequestId, used: false });
    try {
      return operation === 'answer'
        ? await questions.answer(nativeRequestId, { responseId: commandId, source, selections: response.selections })
        : await questions.decline(nativeRequestId, { responseId: commandId, source });
    } finally {
      answerBarriers.delete(commandId);
    }
  }

  return {
    get questionsUrl() {
      return /** @type {any} */ (questions).url;
    },
    questionsToken,
    async startQuestions() {
      questions = await startQuestionServer({
        sessionId,
        generation,
        token: questionsToken,
        record: recordQuestion,
        onPending: questionPending,
        onSettled: questionSettled,
        admit: admitQuestion,
        log: (entry) => log.info({ ...entry, msg: `codex ${entry.msg}`, sessionId, generation }),
      });
    },
    abandon,

    attach({ child, identity }) {
      proc = { child, identity };
      worker.identity = identity;
      exited = new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) r({ code: child.exitCode, signal: child.signalCode });
        else child.once('exit', (code, signal) => r({ code, signal }));
      });
      child.stderr?.resume();
      const channel = createJsonlChannel({ readable: child.stdout, writable: child.stdin });
      const messages = (async function* () {
        try {
          for await (const m of channel.messages) yield m;
        } finally {
          streamClosed();
        }
      })();
      rpc = createCodexRpc(
        {
          messages,
          fail: channel.fail,
          send(message) {
            const sent = channel.send(message);
            const waiter = message?.method === undefined && message?.id !== undefined ? writeWaiters.get(message.id) : undefined;
            if (waiter) {
              waiter.attempted = true;
              sent.then(() => waiter.resolve('written'), waiter.reject);
            }
            return sent;
          },
        },
        { onNotification, onServerRequest },
      );
    },

    async handshake({ overrides, resume, effects }) {
      const control = /** @type {ReturnType<typeof createCodexRpc>} */ (rpc);
      try {
        await control.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, { timeoutMs: CONTROL_TIMEOUT_MS });
        await control.notify('initialized');
      } catch (err) {
        throw await fail('startup_failed', 'initialize_failed', err);
      }
      let account;
      try {
        account = await control.request('account/read', { refreshToken: false }, { timeoutMs: CONTROL_TIMEOUT_MS });
      } catch (err) {
        throw await fail('sign_in_required', 'account_unreadable', err);
      }
      const judged = auth.readiness({ account });
      if (judged?.state !== 'ready') throw await fail('sign_in_required', `auth_${judged?.reason ?? 'refused'}`);
      const gate = async () => {
        const layers = await control.request('config/read', { cwd: worktree, includeLayers: true }, { timeoutMs: CONTROL_TIMEOUT_MS });
        const result = assessCodexLayers(layers, { overrides, disabledProjectLayersInert: OBSERVED.disabledProjectLayersInert });
        if (result.ok) {
          for (const layer of layers.layers) {
            const servers = layer.name.type === 'user' && (layer.disabledReason === null || layer.disabledReason === undefined) ? layer.config?.mcp_servers : null;
            if (servers && typeof servers === 'object') for (const name of Object.keys(servers)) ctx.persistableMcpServers.add(name);
          }
        }
        return result;
      };
      /** @type {ReturnType<typeof assessCodexLayers>} */
      let verdict;
      try {
        verdict = await gate();
      } catch (err) {
        throw await fail('startup_failed', 'config_read_failed', err);
      }
      if (verdict.ok === false) throw await fail('startup_failed', verdict.reason);

      let started;
      if (resume === null) {
        let baseline;
        try {
          baseline = new Set(await loadedThreadIds(control));
        } catch (err) {
          throw await fail('startup_failed', 'loaded_baseline_unreadable', err);
        }
        const barrierAt = Date.now();
        try {
          await effects.barrier('create_native_session', {});
        } catch (err) {
          await abandon();
          throw err;
        }
        try {
          started = await control.request('thread/start', { ephemeral: false }, { timeoutMs: THREAD_START_TIMEOUT_MS });
        } catch (err) {
          if (err?.rpcError) {
            await abandon();
            throw new CodexBackendError('reconciling', 'thread_start_error', { cause: err });
          }
          const found = await recoverLostThread(control, baseline, barrierAt);
          if (found.ok === false) {
            await abandon();
            throw new CodexBackendError('reconciling', found.reason, { cause: err });
          }
          log.warn({ msg: 'codex thread/start response lost; binding the one new owned loaded thread', sessionId, generation, reason: 'thread_start_response_lost' });
          started = { thread: found.thread, recovered: true };
        }
        threadId = started.thread.id;
        try {
          await effects.bind(threadId);
        } catch (err) {
          await abandon();
          throw err;
        }
        if (started.recovered) {
          let again;
          try {
            again = await gate();
          } catch (err) {
            await abandon();
            throw new CodexBackendError('reconciling', 'recovered_gate_unreadable', { cause: err });
          }
          if (again.ok === false) {
            await abandon();
            throw new CodexBackendError('reconciling', `recovered_gate_${again.reason}`);
          }
          let rejoined;
          try {
            rejoined = await control.request('thread/resume', { threadId }, { timeoutMs: CONTROL_TIMEOUT_MS });
          } catch (err) {
            await abandon();
            throw new CodexBackendError('reconciling', 'recovered_rejoin_failed', { cause: err });
          }
          const settings = rejoined?.thread?.id === threadId ? admitCodexThread({ profile, started: rejoined, worktree }) : { ok: false, reason: 'recovered_identity_mismatch' };
          if (settings.ok === false) {
            await abandon();
            throw new CodexBackendError('reconciling', `recovered_${settings.reason}`);
          }
          started = rejoined;
        }
      } else {
        try {
          started = await control.request('thread/resume', { threadId: resume.nativeSessionId }, { timeoutMs: CONTROL_TIMEOUT_MS });
        } catch (err) {
          await abandon();
          throw new CodexBackendError('reconciling', 'resume_failed', { cause: err });
        }
        threadId = started?.thread?.id;
        if (threadId !== resume.nativeSessionId) {
          await abandon();
          throw new CodexBackendError('reconciling', 'resume_mismatch');
        }
        if (resume.bound === false) {
          try {
            await effects.bind(threadId);
          } catch (err) {
            await abandon();
            throw err;
          }
        }
      }
      worker.nativeSessionId = threadId;
      if (!threadAdmission) threadAdmission = admitCodexThread({ profile, started, worktree });
      if (typeof started?.model === 'string') ctx.model = started.model;
      const admission = threadAdmission;
      if (admission.ok === false) log.warn({ msg: 'codex thread not admitted', sessionId, generation, code: admission.code, reason: admission.reason });
      return worker;
    },
  };
}
