
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { BackendContractError } from '../supervisor/backend-contract.js';
import { ensurePrivateDir } from '../supervisor/owner-lock.js';
import { openPrivateFile } from '../supervisor/private-file.js';
import { createClaudeControl } from './claude-control.js';
import { normalizeClaudeEvent } from './claude-normalize.js';
import { createJsonlChannel } from './jsonl.js';
import { buildNativeEnv } from './native-env.js';
import { claudeArgs, NATIVE_OBSERVED, NATIVE_PINS, readNativeVersion } from './pins.js';

const execFileAsync = promisify(execFileCb);
const OBSERVED = NATIVE_OBSERVED['claude-code'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORTING_SERVER = 'ff_reporting';
const MCP_READY_TIMEOUT_MS = 15_000;
const EXIT_WAIT_MS = 5_000;
const STDERR_LIMIT = 4096;
const INTERRUPT_SETTLE_MS = 30_000;

export class ClaudeBackendError extends Error {
  constructor(code, reason, options) {
    super(`claude-code backend: ${code} (${reason})`, options);
    this.name = 'ClaudeBackendError';
    this.code = code;
    this.reason = reason;
  }
}

const LABELS = Object.freeze({ allowOnce: 'Allow once', allowSession: 'Allow for this session', deny: 'Deny and continue' });

/**
 * @returns {{ ok: true } | { ok: false, code: 'startup_failed' | 'sign_in_required' | 'profile_unavailable', reason: string }}
 */
export function admitClaudeInit({ profile, init, auth }) {
  const servers = Array.isArray(init?.mcpServers) ? init.mcpServers : [];
  const reporter = servers.find((s) => s.name === REPORTING_SERVER);
  if (reporter?.status !== 'connected') return { ok: false, code: 'startup_failed', reason: 'reporting_not_connected' };
  if (servers.some((s) => s.name !== REPORTING_SERVER)) return { ok: false, code: 'startup_failed', reason: 'unexpected_mcp_server' };
  const fresh = init.authStatus ? auth.readiness({ authStatus: init.authStatus }) : { state: 'sign_in_required', reason: 'auth_status_unreadable' };
  if (fresh?.state !== 'ready') return { ok: false, code: 'sign_in_required', reason: `fresh_${fresh?.reason ?? 'refused'}` };
  const admitted = auth.admitInit(init);
  if (!admitted?.ok) return { ok: false, code: 'sign_in_required', reason: `auth_${admitted?.reason ?? 'refused'}` };
  if (init.model !== profile.model) return { ok: false, code: 'profile_unavailable', reason: 'model_mismatch' };
  const expectedMode = Object.hasOwn(OBSERVED.initPermissionModes, profile.policy?.permissionMode) ? OBSERVED.initPermissionModes[profile.policy.permissionMode] : undefined;
  if (!expectedMode || init.permissionMode !== expectedMode) return { ok: false, code: 'profile_unavailable', reason: 'permission_mode_mismatch' };
  return { ok: true };
}

function policyProblem(permissionMode) {
  const outcome = Object.hasOwn(OBSERVED.policyOutcomes, permissionMode) ? OBSERVED.policyOutcomes[permissionMode] : undefined;
  if (!outcome) return 'required_capability_unproven';
  const values = [outcome.reporting, outcome.questions];
  if (values.includes('refused')) return 'required_capability_blocked';
  if (values.some((v) => v !== 'runs' && v !== 'asks')) return 'required_capability_unproven';
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writePrivate(path, content) {
  const fd = /** @type {number} */ (openPrivateFile(path, { access: 'readwrite', create: true }));
  try {
    nodeFs.ftruncateSync(fd, 0);
    nodeFs.writeSync(fd, content, 0);
    nodeFs.fsyncSync(fd);
  } finally {
    nodeFs.closeSync(fd);
  }
}

function outsideOf(base, target) {
  const rel = relative(base, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function prepareSessionFiles({ privateDir, sessionId, workspaceDir, reporting }) {
  ensurePrivateDir(privateDir);
  const root = nodeFs.realpathSync(privateDir);
  const worktree = nodeFs.realpathSync(workspaceDir);
  if (!outsideOf(worktree, root) || !outsideOf(worktree, join(root, sessionId))) throw new ClaudeBackendError('startup_failed', 'private_dir_inside_worktree');
  const sessionDir = ensurePrivateDir(join(root, sessionId));
  const mcpConfigPath = join(sessionDir, 'mcp.json');
  const settingsPath = join(sessionDir, 'settings.json');
  const mcpConfig = { mcpServers: { [REPORTING_SERVER]: { type: 'http', url: reporting.url, headers: { Authorization: `Bearer ${reporting.credential}` } } } };
  writePrivate(mcpConfigPath, JSON.stringify(mcpConfig));
  writePrivate(settingsPath, JSON.stringify({ disableAllHooks: true }));
  return { sessionDir, mcpConfigPath, settingsPath };
}

function validateOpen({ sessionId, profile, workspaceDir, reporting, resume, generation, spawn, effects }) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new BackendContractError('claude-code sessions need a UUID session id');
  if (profile?.backend !== 'claude-code' || profile.complete !== true) throw new BackendContractError('claude-code open needs a complete claude-code profile');
  if (typeof workspaceDir !== 'string' || !isAbsolute(workspaceDir)) throw new BackendContractError('workspaceDir must be absolute');
  if (typeof reporting?.url !== 'string' || typeof reporting?.credential !== 'string' || !reporting.credential) throw new BackendContractError('open needs a reporting url and credential');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BackendContractError('open needs a positive generation');
  if (typeof spawn !== 'function') throw new BackendContractError('open needs the supervisor spawn');
  if (typeof effects?.barrier !== 'function' || typeof effects?.bind !== 'function') throw new BackendContractError('open needs effects');
  if (resume !== null && (typeof resume?.nativeSessionId !== 'string' || !UUID.test(resume.nativeSessionId))) throw new BackendContractError('resume needs a recorded native UUID');
}

function createQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(item) {
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
 * @param {{ privateDir: string, log: { info: Function, warn: Function, error: Function }, auth: { readiness: Function, admitInit: Function, env: () => Record<string, string>, args: () => string[] }, parentEnv?: Record<string, string|undefined>, platform?: string, readVersion?: (profile: any) => Promise<string>, readAuthStatus?: (profile: any, opts: { env: Record<string, string>, cwd: string }) => Promise<any> }} opts
 */
export function createClaudeBackend({ privateDir, log, auth, parentEnv = process.env, platform = process.platform, readVersion, readAuthStatus }) {
  if (typeof privateDir !== 'string' || !isAbsolute(privateDir)) throw new BackendContractError('createClaudeBackend needs an absolute privateDir');
  if (!log || !auth || typeof auth.admitInit !== 'function' || typeof auth.readiness !== 'function') throw new BackendContractError('createClaudeBackend needs log and auth');

  const nativeEnv = (profile) => ({ ...buildNativeEnv({ backend: 'claude-code', contextDir: profile.contextDir, parentEnv }), ...auth.env() });
  const versionOf = readVersion ?? ((profile) => readNativeVersion({ backend: 'claude-code', executable: profile.executable, env: nativeEnv(profile) }));
  const authStatusOf =
    readAuthStatus ??
    (async (profile, { env, cwd }) => {
      const { stdout } = await execFileAsync(profile.executable, [...OBSERVED.authStatusArgv], { env, cwd, timeout: 15_000 }).catch((err) => {
        if (typeof err.stdout === 'string' && err.stdout.trim()) return { stdout: err.stdout };
        throw err;
      });
      return JSON.parse(stdout);
    });

  async function readiness(profile) {
    if (platform !== 'linux') return { state: 'platform_unsupported' };
    let version;
    try {
      version = await versionOf(profile);
    } catch (err) {
      if (err?.code === 'ENOENT') return { state: 'not_installed' };
      log.warn({ msg: 'claude-code version unreadable', profileId: profile.id, reason: 'version_unreadable', errorCode: err?.code });
      return { state: 'incompatible' };
    }
    if (!NATIVE_PINS['claude-code'].versions.includes(version)) return { state: 'incompatible', version };
    const problem = policyProblem(profile.policy?.permissionMode);
    if (problem) {
      log.warn({ msg: 'claude-code permission mode cannot run required reporting and questions unaltered', profileId: profile.id, reason: problem });
      return { state: 'invalid_config', version };
    }
    let authStatus;
    try {
      authStatus = await authStatusOf(profile, { env: nativeEnv(profile), cwd: privateDir });
    } catch (err) {
      log.warn({ msg: 'claude-code auth status unreadable', profileId: profile.id, reason: 'auth_status_unreadable', errorCode: err?.code });
      return { state: 'sign_in_required', version };
    }
    const judged = auth.readiness({ authStatus });
    if (judged?.state !== 'ready') {
      log.warn({ msg: 'claude-code sign-in not admitted', profileId: profile.id, reason: judged?.reason ?? 'refused' });
      return { state: 'sign_in_required', version };
    }
    return { state: 'ready', version };
  }

  async function open(opts) {
    validateOpen(opts);
    const { sessionId, profile, workspaceDir, reporting, resume, generation, spawn, effects } = opts;
    const uuid = resume?.nativeSessionId ?? sessionId;
    const { sessionDir, mcpConfigPath, settingsPath } = prepareSessionFiles({ privateDir, sessionId, workspaceDir, reporting });

    async function launch(resumeExisting) {
      const args = [
        ...claudeArgs({ sessionId: uuid, resume: resumeExisting, model: profile.model, permissionMode: profile.policy.permissionMode, mcpConfigPath, settingsPath, workspaceDir }),
        ...auth.args(),
      ];
      const { child, identity } = await spawn({ executable: profile.executable, args, env: nativeEnv(profile), cwd: workspaceDir });
      return startProcess({ child, identity, uuid, log, generation });
    }

    async function initialized(proc) {
      try {
        const init = await proc.control.request('initialize', {}, { timeoutMs: 30_000 });
        return { ok: true, init };
      } catch (err) {
        const exit = await proc.waitExit(EXIT_WAIT_MS);
        const notFound = exit?.code === 1 && proc.stderr().includes(`No conversation found with session ID: ${uuid}`);
        await proc.kill();
        return { ok: false, notFound, cause: err };
      }
    }

    async function bindOrStop(proc) {
      try {
        await effects.bind(uuid);
      } catch (err) {
        await proc.kill();
        throw err;
      }
    }

    async function create() {
      await effects.barrier('create_native_session', { uuid });
      let proc;
      try {
        proc = await launch(false);
      } catch (err) {
        throw new ClaudeBackendError('reconciling', 'create_spawn_failed', { cause: err });
      }
      const started = await initialized(proc);
      if (!started.ok) throw new ClaudeBackendError('reconciling', 'create_unconfirmed', { cause: started.cause });
      await bindOrStop(proc);
      return { proc, init: started.init };
    }

    let opened;
    if (resume === null) opened = await create();
    else {
      let proc;
      try {
        proc = await launch(true);
      } catch (err) {
        throw new ClaudeBackendError('startup_failed', 'resume_spawn_failed', { cause: err });
      }
      const started = await initialized(proc);
      if (started.ok) {
        if (resume.bound === false) await bindOrStop(proc);
        opened = { proc, init: started.init };
      } else if (resume.bound === false && started.notFound) {
        log.info({ msg: 'claude-code recovery recreates the session', sessionId, generation });
        if (typeof effects.absent !== 'function') throw new BackendContractError('A same-UUID recreation needs the absence effect');
        await effects.absent({ nativeSessionId: uuid, evidence: 'resume_not_found' });
        opened = await create();
      } else {
        throw new ClaudeBackendError('reconciling', started.notFound ? 'resume_not_found' : 'resume_unconfirmed', { cause: started.cause });
      }
    }

    try {
      const readFreshStatus = () =>
        authStatusOf(profile, { env: nativeEnv(profile), cwd: sessionDir }).catch((err) => {
          log.warn({ msg: 'claude-code auth status unreadable at open', sessionId, reason: 'auth_status_unreadable', errorCode: err?.code });
          return null;
        });
      opened.proc.admission = await admit(opened.proc, opened.init, profile, auth, readFreshStatus);
    } catch (err) {
      await opened.proc.kill();
      throw new ClaudeBackendError('startup_failed', 'admission_unreadable', { cause: err });
    }
    if (!opened.proc.admission.ok) log.warn({ msg: 'claude-code worker not admitted', sessionId, generation, code: opened.proc.admission.code, reason: opened.proc.admission.reason });
    return opened.proc.worker;
  }

  return Object.freeze({ id: 'claude-code', readiness, open });
}

async function admit(proc, init, profile, auth, readFreshStatus) {
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
  let mcpServers;
  for (;;) {
    const status = await proc.control.request('mcp_status', {}, { timeoutMs: 15_000 });
    mcpServers = (Array.isArray(status?.mcpServers) ? status.mcpServers : []).map(({ name, status: state }) => ({ name, status: state }));
    if (!mcpServers.some((s) => s.status === 'pending') || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const settings = await proc.control.request('get_settings', {}, { timeoutMs: 15_000 });
  const authStatus = await readFreshStatus();
  return admitClaudeInit({
    profile,
    auth,
    init: { model: settings?.applied?.model, permissionMode: init?.current_permission_mode, account: init?.account, mcpServers, authStatus },
  });
}

function startProcess({ child, identity, uuid, log, generation }) {
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr = (stderr + d).slice(-STDERR_LIMIT);
  });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const channel = createJsonlChannel({ readable: child.stdout, writable: child.stdin });

  /** @type {Map<string, { attempted: boolean, resolve: (value?: unknown) => void, reject: (error: unknown) => void }>} control_response writes we wait on, by request id; resolve('written') or resolve('withdrawn') before any attempt */
  const writeWaiters = new Map();
  const controlChannel = {
    messages: channel.messages,
    fail: channel.fail,
    send(message) {
      const sent = channel.send(message);
      const waiter = message?.type === 'control_response' ? writeWaiters.get(message.response?.request_id) : undefined;
      if (waiter) {
        waiter.attempted = true;
        sent.then(() => waiter.resolve('written'), waiter.reject);
      }
      return sent;
    },
  };

  /** @type {Map<string, any>} */
  const pending = new Map();
  const output = createQueue();
  const ctx = { modelUnavailable: false };
  /** @type {Map<string, { resolve: Function, reject: Function }>} */
  const receiptWaiters = new Map();
  /** @type {Map<string, { phase: 'pending' | 'written' | 'undispatched', outcome: null | 'cancelled' | 'completed' | 'failed' | 'interrupted' }>} */
  const prompts = new Map();
  /** @type {Array<{ check: () => boolean, resolve: (value?: unknown) => void, reject: (error: unknown) => void }>} */
  const progressWaiters = [];
  let resultSeq = 0;
  let lastTerminal = null;
  let activeTurn = false;

  function settlePrompt(id, outcome) {
    const entry = prompts.get(id);
    if (entry?.phase !== 'written' || entry.outcome !== null) return;
    entry.outcome = outcome;
    if (outcome === 'cancelled' && receiptWaiters.has(id)) {
      receiptWaiters.get(id).resolve({ uuid: id, state: 'cancelled' });
      receiptWaiters.delete(id);
    }
  }

  function wakeProgress() {
    for (const w of [...progressWaiters]) {
      if (!w.check()) continue;
      progressWaiters.splice(progressWaiters.indexOf(w), 1);
      w.resolve();
    }
  }

  function waitProgress(check, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = progressWaiters.indexOf(waiter);
        if (i >= 0) progressWaiters.splice(i, 1);
        reject(new ClaudeBackendError('reconciling', 'interrupt_unsettled'));
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
  let closed = false;

  const control = createClaudeControl(controlChannel, {
    onControlRequest: ({ requestId, request }) => onRequest(requestId, request),
    onCancelRequest: ({ requestId }) => {
      const entry = pending.get(requestId);
      const waiter = writeWaiters.get(requestId);
      if (waiter && !waiter.attempted) waiter.resolve('withdrawn');
      if (!entry) return;
      entry.withdrawn = true;
      pending.delete(requestId);
      entry.release();
      output.push({ kind: 'attention', nativeEventId: `request:${requestId}:withdrawn`, payload: { nativeRequestId: requestId, state: 'withdrawn', reason: 'native_cancelled' } });
    },
  });

  function failWaiters(error) {
    for (const [, w] of receiptWaiters) w.reject(error);
    receiptWaiters.clear();
    for (const w of progressWaiters.splice(0)) w.reject(error);
    for (const [, w] of writeWaiters) {
      if (w.attempted) w.reject(error);
      else w.resolve('withdrawn');
    }
  }

  (async () => {
    for await (const event of control.events) {
      const items = normalizeClaudeEvent(event, ctx);
      for (const item of items) output.push(item);
      if (event.type === 'command_lifecycle' && event.state === 'started') activeTurn = true;
      if (event.type === 'user' && event.isReplay === true && receiptWaiters.has(event.uuid)) {
        receiptWaiters.get(event.uuid).resolve({ uuid: event.uuid, state: 'replayed' });
        receiptWaiters.delete(event.uuid);
      }
      if (event.type === 'command_lifecycle' && event.state === 'cancelled') {
        settlePrompt(event.command_uuid, 'cancelled');
        if (receiptWaiters.has(event.command_uuid)) {
          receiptWaiters.get(event.command_uuid).resolve({ uuid: event.command_uuid, state: 'cancelled' });
          receiptWaiters.delete(event.command_uuid);
        }
      }
      if (event.type === 'result') {
        activeTurn = false;
        const terminal = items.find((item) => item.terminal)?.terminal ?? null;
        resultSeq += 1;
        lastTerminal = terminal;
        for (const id of Array.isArray(event.user_message_uuids) ? event.user_message_uuids : []) settlePrompt(id, terminal);
      }
      wakeProgress();
    }
  })()
    .catch((err) => {
      log.warn({ msg: 'claude-code event stream ended with an error', reason: err?.code ?? 'stream_error' });
    })
    .finally(() => {
      closed = true;
      failWaiters(new ClaudeBackendError('reconciling', 'native_stream_closed'));
      output.end();
    });

  function onRequest(requestId, request) {
    if (request?.subtype !== 'can_use_tool') throw new Error(`unsupported control request ${request?.subtype}`);
    const fingerprint = createHash('sha256').update(canonical({ requestId, request })).digest('hex');
    const isQuestion = request.tool_name === 'AskUserQuestion';
    const sessionSuggestions = (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []).filter(
      (s) => s?.type === 'addRules' && s.behavior === 'allow' && s.destination === 'session',
    );
    const choices = isQuestion
      ? [{ id: 'deny', label: LABELS.deny, scope: 'once', behavior: 'deny' }]
      : [
          { id: 'allow_once', label: LABELS.allowOnce, scope: 'once', behavior: 'allow' },
          ...(sessionSuggestions.length ? [{ id: 'allow_session', label: LABELS.allowSession, scope: 'session', behavior: 'allow' }] : []),
          { id: 'deny', label: LABELS.deny, scope: 'once', behavior: 'deny' },
        ];
    const questions = isQuestion
      ? (Array.isArray(request.input?.questions) ? request.input.questions : []).map((q, i) => ({
          id: `q${i}`,
          header: q.header,
          question: q.question,
          options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description ?? null })) : null,
          multiSelect: q.multiSelect === true,
          allowOther: true,
          secret: false,
        }))
      : null;
    const publicRequest = {
      nativeRequestId: requestId,
      kind: isQuestion ? 'question' : 'permission',
      fingerprint,
      secret: false,
      choices,
      questions,
      tool: { name: request.tool_name, displayName: request.display_name ?? request.tool_name, description: request.description ?? null, input: request.input },
    };
    return new Promise((resolve) => {
      pending.set(requestId, { publicRequest, request, sessionSuggestions, settled: false, resolve, release: () => resolve({}) });
      output.push({ kind: 'attention', nativeEventId: `request:${requestId}`, payload: { ...publicRequest, state: 'pending' } });
    });
  }

  function questionAnswer(entry, selections) {
    const questions = entry.publicRequest.questions;
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return null;
    const ids = new Set(questions.map((q) => q.id));
    if (Object.keys(selections).some((k) => !ids.has(k))) return null;
    if (new Set(questions.map((q) => q.question)).size !== questions.length) return null;
    const answers = {};
    const annotations = {};
    for (const q of questions) {
      const sel = selections[q.id];
      if (!sel || !Array.isArray(sel.selected)) return null;
      const labels = (q.options ?? []).map((o) => o.label);
      if (sel.selected.some((l) => typeof l !== 'string' || !labels.includes(l))) return null;
      if (new Set(sel.selected).size !== sel.selected.length) return null;
      if (!q.multiSelect && sel.selected.length > 1) return null;
      if (sel.other !== undefined && sel.other !== null && typeof sel.other !== 'string') return null;
      answers[q.question] = q.multiSelect ? JSON.stringify(sel.selected) : (sel.selected[0] ?? '');
      if (typeof sel.other === 'string' && sel.other !== '') annotations[q.question] = { notes: sel.other };
    }
    const updatedInput = { ...entry.request.input, answers };
    if (Object.keys(annotations).length) updatedInput.annotations = annotations;
    return { behavior: 'allow', updatedInput };
  }

  const requireBarrier = (barrier, method) => {
    if (typeof barrier !== 'function') throw new BackendContractError(`${method}() needs its per-call barrier`);
  };

  const worker = {
    nativeSessionId: uuid,
    identity,
    events: output,

    async send({ commandId, text, mode, barrier }) {
      requireBarrier(barrier, 'send');
      if (typeof commandId !== 'string' || !UUID.test(commandId)) throw new BackendContractError('send needs a UUID commandId');
      if (typeof text !== 'string' || text === '') throw new BackendContractError('send needs text');
      if (mode !== 'start' && mode !== 'steer') throw new BackendContractError('send mode must be start or steer');
      if (closed) throw new ClaudeBackendError('reconciling', 'worker_closed');
      if (!proc.admission?.ok) throw new ClaudeBackendError(proc.admission?.code ?? 'startup_failed', proc.admission?.reason ?? 'not_admitted');
      if (prompts.has(commandId)) throw new BackendContractError('send commandIds are single-use');
      const entry = { phase: /** @type {'pending' | 'written' | 'undispatched'} */ ('pending'), outcome: null };
      prompts.set(commandId, entry);
      const receipt = new Promise((resolve, reject) => receiptWaiters.set(commandId, { resolve, reject }));
      receipt.catch(() => {
      });
      try {
        await barrier({ uuid: commandId });
      } catch (err) {
        prompts.delete(commandId);
        receiptWaiters.delete(commandId);
        throw err;
      }
      if (entry.phase === 'undispatched') {
        receiptWaiters.delete(commandId);
        return { receipt: { uuid: commandId, state: 'cancelled', dispatched: false } };
      }
      if (closed) {
        prompts.delete(commandId);
        receiptWaiters.delete(commandId);
        throw new ClaudeBackendError('reconciling', 'worker_closed');
      }
      entry.phase = 'written';
      try {
        await control.sendUser({ uuid: commandId, sessionId: uuid, text });
      } catch (err) {
        receiptWaiters.delete(commandId);
        throw new ClaudeBackendError('reconciling', 'prompt_write_failed', { cause: err });
      }
      return { receipt: await receipt };
    },

    async respond({ commandId, nativeRequestId, response, source, barrier }) {
      requireBarrier(barrier, 'respond');
      if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('respond needs a commandId');
      if (source !== 'web' && source !== 'local') throw new BackendContractError('respond source must be web or local');
      const entry = pending.get(nativeRequestId);
      if (closed || !entry || entry.settled) return { state: 'failed', errorCode: 'request_unavailable' };
      const { publicRequest } = entry;
      if (response?.fingerprint !== undefined && response.fingerprint !== publicRequest.fingerprint) return { state: 'failed', errorCode: 'request_unavailable' };

      let answer;
      let ref;
      const base = { nativeRequestId, requestKind: publicRequest.kind, fingerprint: publicRequest.fingerprint };
      if (publicRequest.kind === 'question' && response?.selections !== undefined) {
        answer = questionAnswer(entry, response.selections);
        if (!answer) return { state: 'failed', errorCode: 'invalid_response' };
        ref = { ...base, source, operation: 'answer' };
      } else {
        const choice = publicRequest.choices.find((c) => c.id === response?.selectedActionId);
        if (!choice || response.behavior !== choice.behavior) return { state: 'failed', errorCode: 'request_unavailable' };
        if (choice.id === 'deny') answer = { behavior: 'deny', message: 'The user denied this request.' };
        else if (choice.id === 'allow_session') answer = { behavior: 'allow', updatedInput: entry.request.input, updatedPermissions: entry.sessionSuggestions };
        else answer = { behavior: 'allow', updatedInput: entry.request.input };
        ref = { ...base, source, operation: choice.behavior === 'deny' ? 'decline' : 'answer' };
      }

      entry.settled = true;
      try {
        await barrier(ref);
      } catch (err) {
        entry.settled = false;
        throw err;
      }
      if (closed || entry.withdrawn || pending.get(nativeRequestId) !== entry) return { state: 'failed', errorCode: 'request_unavailable' };
      const written = new Promise((resolve, reject) => writeWaiters.set(nativeRequestId, { attempted: false, resolve, reject }));
      pending.delete(nativeRequestId);
      entry.resolve(answer);
      try {
        if ((await written) === 'withdrawn') return { state: 'failed', errorCode: 'request_unavailable' };
      } catch (err) {
        log.warn({ msg: 'claude-code answer write failed after its barrier', nativeRequestId, reason: err?.code ?? 'write_failed' });
        return { state: 'reconciling' };
      } finally {
        writeWaiters.delete(nativeRequestId);
      }
      output.push({ kind: 'attention', nativeEventId: `request:${nativeRequestId}:resolved`, payload: { nativeRequestId, state: 'resolved', source } });
      return { state: 'dispatched' };
    },

    async interrupt({ commandId, barrier }) {
      requireBarrier(barrier, 'interrupt');
      if (typeof commandId !== 'string' || commandId === '') throw new BackendContractError('interrupt needs a commandId');
      if (closed) throw new ClaudeBackendError('reconciling', 'worker_closed');
      await barrier({ cancelQueued: true });
      if (closed) throw new ClaudeBackendError('reconciling', 'worker_closed');
      for (const [id, entry] of prompts) if (entry.phase === 'written' && entry.outcome !== null) prompts.delete(id);
      const boundary = [...prompts.entries()];
      const undispatched = boundary.filter(([, e]) => e.phase === 'pending').map(([id]) => id);
      for (const id of undispatched) prompts.get(id).phase = 'undispatched';
      const watched = boundary.filter(([, e]) => e.phase === 'written').map(([id]) => id);
      const turnRunning = activeTurn;
      const seqAtWrite = resultSeq;
      const settledList = () =>
        boundary.map(([id, e]) => (e.phase === 'undispatched' ? { commandId: id, outcome: 'cancelled', dispatched: false } : { commandId: id, outcome: e.outcome, dispatched: true }));
      try {
        const receipt = await control.request('interrupt', { cancel_queued: true }, { timeoutMs: 30_000 });
        for (const id of Array.isArray(receipt?.cancelled) ? receipt.cancelled : []) settlePrompt(id, 'cancelled');
        if (watched.length === 0 && !turnRunning) return { receipt, terminal: null, settled: settledList() };
        const done = () => watched.every((id) => prompts.get(id).outcome !== null) && (watched.length > 0 || resultSeq > seqAtWrite);
        if (!done()) await waitProgress(done, INTERRUPT_SETTLE_MS);
        const settled = settledList();
        for (const id of watched) prompts.delete(id);
        return { receipt, terminal: resultSeq > seqAtWrite ? lastTerminal : null, settled };
      } catch (err) {
        if (err instanceof ClaudeBackendError) throw err;
        throw new ClaudeBackendError('reconciling', 'interrupt_unconfirmed', { cause: err });
      } finally {
        for (const id of undispatched) prompts.delete(id);
      }
    },

    pending() {
      return [...pending.values()].filter((e) => !e.settled).map((e) => e.publicRequest);
    },

    idle() {
      return !closed && !activeTurn && ![...prompts.values()].some((e) => e.phase === 'pending' || (e.phase === 'written' && e.outcome === null));
    },

    /** @param {{ reason?: string }} [opts] */
    async close({ reason } = {}) {
      log.info({ msg: 'claude-code worker closing', generation, reason: reason ?? 'unspecified' });
      await proc.kill();
    },
  };

  const proc = {
    control,
    worker,
    admission: null,
    stderr: () => stderr,
    async waitExit(ms) {
      return Promise.race([exited, new Promise((r) => setTimeout(() => r(null), ms).unref())]);
    },
    async kill() {
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      channel.end().catch(() => {
      });
      if ((await proc.waitExit(EXIT_WAIT_MS)) === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  return proc;
}
