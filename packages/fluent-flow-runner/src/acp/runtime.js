import { isAbsolute } from 'node:path';
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  CreateElicitationResponse,
  PROTOCOL_VERSION,
  RequestPermissionOutcome,
  client,
  ndJsonStream,
} from '@agentclientprotocol/sdk/experimental/v2';
import { spawnAcpProcess } from './process.js';

const restartHistory = new Map();

class IncompatibleAcpError extends Error {}

const DEFAULT_LIMITS = Object.freeze({
  requestTimeoutMs: 15_000,
  silenceMs: 30_000,
  shutdownIdleMs: 5_000,
  shutdownExitMs: 5_000,
  shutdownKillMs: 5_000,
  restartWindowMs: 60_000,
  maxRestarts: 3,
});

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

function safeError(message) {
  return new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteLimit(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw safeError(`${name} is invalid`);
  return value;
}

function integerLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw safeError(`${name} is invalid`);
  return value;
}

function createLimits(input = {}) {
  const values = { ...DEFAULT_LIMITS, ...input };
  return {
    requestTimeoutMs: finiteLimit(values.requestTimeoutMs, 'ACP request timeout', 1),
    silenceMs: finiteLimit(values.silenceMs, 'ACP silence threshold', 1),
    shutdownIdleMs: finiteLimit(values.shutdownIdleMs, 'ACP idle shutdown timeout'),
    shutdownExitMs: finiteLimit(values.shutdownExitMs, 'ACP exit shutdown timeout'),
    shutdownKillMs: finiteLimit(values.shutdownKillMs, 'ACP kill shutdown timeout'),
    restartWindowMs: finiteLimit(values.restartWindowMs, 'ACP restart window', 1),
    maxRestarts: integerLimit(values.maxRestarts, 'ACP restart limit'),
  };
}

function publicExit(result) {
  return {
    code: result?.code ?? null,
    signal: result?.signal ?? null,
    error: result?.error ? safeError('ACP child process failed') : null,
  };
}

function validStringValue(value, schema) {
  if (typeof value !== 'string') return false;
  if (schema.minLength != null && value.length < schema.minLength) return false;
  if (schema.maxLength != null && value.length > schema.maxLength) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((option) => option?.const === value)) return false;
  if (schema.pattern != null) {
    try {
      if (!new RegExp(schema.pattern, 'u').test(value)) return false;
    } catch {
      return false;
    }
  }
  if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return false;
  if (schema.format === 'uri') {
    try {
      new URL(value);
    } catch {
      return false;
    }
  }
  if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) return false;
  return true;
}

function validFormValue(value, schema) {
  if (!isObject(schema)) return false;
  if (schema.type === 'string') return validStringValue(value, schema);
  if (schema.type === 'number') {
    return typeof value === 'number'
      && Number.isFinite(value)
      && (schema.minimum == null || value >= schema.minimum)
      && (schema.maximum == null || value <= schema.maximum);
  }
  if (schema.type === 'integer') {
    return Number.isSafeInteger(value)
      && (schema.minimum == null || value >= schema.minimum)
      && (schema.maximum == null || value <= schema.maximum);
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
    if (schema.minItems != null && value.length < schema.minItems) return false;
    if (schema.maxItems != null && value.length > schema.maxItems) return false;
    const allowed = Array.isArray(schema.items?.enum)
      ? schema.items.enum
      : Array.isArray(schema.items?.anyOf)
        ? schema.items.anyOf.map((item) => item?.const)
        : null;
    return allowed === null || value.every((item) => allowed.includes(item));
  }
  return false;
}

function validFormContent(content, schema) {
  if (!isObject(content) || !isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => !Object.hasOwn(content, key))) return false;
  for (const [key, value] of Object.entries(content)) {
    if (!Object.hasOwn(schema.properties, key) || !validFormValue(value, schema.properties[key])) return false;
  }
  return true;
}

function validatePermissionAnswer(answer, request) {
  if (!isObject(answer) || !isObject(answer.outcome)) return false;
  if (RequestPermissionOutcome.isCancelled(answer.outcome)) return true;
  if (!RequestPermissionOutcome.isSelected(answer.outcome)) return false;
  return Array.isArray(request.options)
    && request.options.some((option) => option?.optionId === answer.outcome.optionId);
}

function validateElicitationAnswer(answer, request) {
  if (!isObject(answer)) return false;
  if (CreateElicitationResponse.isDecline(answer) || CreateElicitationResponse.isCancel(answer)) return true;
  if (!CreateElicitationResponse.isAccept(answer)) return false;
  if (request.mode !== 'form') return answer.content == null || isObject(answer.content);
  return validFormContent(answer.content, request.requestedSchema);
}

export function createAcpRuntime({
  command,
  cwd,
  env,
  onEvent = async () => {},
  onRequest = async () => {},
  log = {},
  spawnProcess = spawnAcpProcess,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  limits: limitInput,
} = {}) {
  if (!isObject(command) || typeof command.bin !== 'string' || command.bin.length === 0) {
    throw safeError('ACP command is required');
  }
  if (!Array.isArray(command.args) || command.args.some((argument) => typeof argument !== 'string')) {
    throw safeError('ACP command arguments are invalid');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw safeError('ACP working directory must be absolute');
  if (typeof onEvent !== 'function' || typeof onRequest !== 'function' || typeof spawnProcess !== 'function') {
    throw safeError('ACP runtime callbacks are invalid');
  }
  if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw safeError('ACP timers are invalid');
  }

  const limits = createLimits(limitInput);
  const budgetKey = JSON.stringify([command.bin, command.args]);
  const finalExit = deferred();
  const pendingRequests = new Map();
  const activeRequestControllers = new Set();
  const app = client({ name: 'fluent-flow-runner' });
  let phase = 'new';
  let initialPromptStarted = false;
  let current = null;
  let lastRecord = null;
  let sessionId = null;
  let foreground = null;
  let recoveryUsed = false;
  let eventTail = Promise.resolve();
  let silenceTimer = null;
  let livenessRunning = false;
  let closePromise = null;
  let terminalCleanup = null;
  let eventOrdinal = 0;
  let connectionOrdinal = 0;

  function report(level, message) {
    const writer = log?.[level];
    if (typeof writer === 'function') writer.call(log, { msg: message });
  }

  function consumeRestart() {
    const timestamp = now();
    const cutoff = timestamp - limits.restartWindowMs;
    const history = (restartHistory.get(budgetKey) ?? []).filter((entry) => entry > cutoff);
    if (history.length >= limits.maxRestarts) {
      restartHistory.set(budgetKey, history);
      throw safeError('ACP restart budget is exhausted');
    }
    history.push(timestamp);
    restartHistory.set(budgetKey, history);
  }

  function waitWithDeadline(promise, milliseconds) {
    if (milliseconds === 0) return Promise.resolve({ timedOut: true });
    return new Promise((resolve) => {
      let settled = false;
      const timer = timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, milliseconds);
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timer);
          resolve({ timedOut: false, value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timer);
          resolve({ timedOut: false, error });
        },
      );
    });
  }

  async function requestWithDeadline(agent, method, params, message) {
    const controller = new AbortController();
    activeRequestControllers.add(controller);
    const timer = timers.setTimeout(() => controller.abort(safeError(message)), limits.requestTimeoutMs);
    try {
      return await agent.request(method, params, {
        cancellationSignal: controller.signal,
        stopWaitingOnCancel: true,
      });
    } catch {
      throw safeError(message);
    } finally {
      timers.clearTimeout(timer);
      activeRequestControllers.delete(controller);
    }
  }

  async function notifyWithDeadline(agent, method, params, message) {
    const result = await waitWithDeadline(agent.notify(method, params), limits.requestTimeoutMs);
    if (result.timedOut || result.error) throw safeError(message);
  }

  function clearSilenceTimer() {
    if (silenceTimer !== null) {
      timers.clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function cancelResponse(record) {
    return record.kind === 'permission'
      ? { outcome: { outcome: 'cancelled' } }
      : { action: 'cancel' };
  }

  function settleRequest(record, response) {
    if (record.closed) return;
    record.closed = true;
    record.signal.removeEventListener('abort', record.cancel);
    pendingRequests.delete(record.requestKey);
    record.reply.resolve(response);
  }

  function settlePendingRequests() {
    for (const record of [...pendingRequests.values()]) settleRequest(record, cancelResponse(record));
  }

  function rejectForeground(error) {
    if (!foreground) return;
    foreground.completion.reject(error);
    foreground = null;
  }

  async function shutdownRecord(record) {
    if (!record) return null;
    if (record.shutdownPromise) return record.shutdownPromise;
    record.shutdownPromise = (async () => {
      record.intentional = true;
      record.connection.close(safeError('ACP connection closed'));
      record.process.closeInput();
      let result = await waitWithDeadline(record.process.exited, limits.shutdownExitMs);
      if (result.timedOut) {
        record.process.kill('SIGTERM');
        result = await waitWithDeadline(record.process.exited, limits.shutdownKillMs);
      }
      if (result.timedOut) {
        record.process.kill('SIGKILL');
        result = { timedOut: false, value: await record.process.exited };
      }
      const exitResult = result.value ?? { code: null, signal: null, error: result.error ?? null };
      record.exitResult = exitResult;
      if (current === record) current = null;
      return exitResult;
    })();
    return record.shutdownPromise;
  }

  function terminalFailure(error) {
    const failure = error instanceof Error ? error : safeError('ACP runtime failed');
    if (phase === 'closed' || phase === 'closing') return failure;
    if (phase !== 'failed') {
      phase = 'failed';
      clearSilenceTimer();
      settlePendingRequests();
      rejectForeground(failure);
      report('warn', 'ACP runtime failed');
    }
    if (!terminalCleanup) {
      const record = current ?? lastRecord;
      terminalCleanup = shutdownRecord(record).then((result) => {
        if (!finalExit.settled) finalExit.resolve(publicExit(result));
      }, () => {
        if (!finalExit.settled) finalExit.resolve(publicExit(null));
      });
    }
    return failure;
  }

  function completeForegroundIfReady() {
    if (!foreground || !foreground.accepted || !foreground.stop) return;
    const turn = foreground;
    foreground = null;
    if (phase !== 'closing') phase = 'idle';
    clearSilenceTimer();
    turn.completion.resolve({
      sessionId,
      messageId: turn.messageId,
      stopReason: turn.stop.stopReason,
    });
  }

  function applyUpdate(params, updatePhase, ordinal) {
    if (params.sessionId !== sessionId || !isObject(params.update)) return;
    const update = params.update;
    if (update.sessionUpdate !== 'state_update') return;
    if (updatePhase?.record === current && updatePhase.awaitingSnapshot) {
      const snapshot = update.state === 'idle'
        ? 'idle'
        : update.state === 'running' || update.state === 'requires_action'
          ? update.state
          : null;
      if (snapshot && !updatePhase.snapshot) {
        updatePhase.snapshot = snapshot;
        updatePhase.sawActive = snapshot !== 'idle';
        updatePhase.firstState.resolve(snapshot);
      } else if (snapshot === 'running' || snapshot === 'requires_action') {
        updatePhase.sawActive = true;
      } else if (snapshot === 'idle' && updatePhase.sawActive && !updatePhase.retainedStop) {
        updatePhase.retainedStop = { stopReason: update.stopReason };
      }
    }
    if (!foreground || ordinal <= foreground.startEventOrdinal) return;
    if (update.state === 'running') foreground.sawRunning = true;
    if (update.state === 'idle' && foreground.sawRunning && phase !== 'recovering') {
      foreground.stop = { stopReason: update.stopReason };
      completeForegroundIfReady();
    }
  }

  function queueEvent(params) {
    const ordinal = ++eventOrdinal;
    const record = current;
    const updatePhase = record?.resumeState ?? null;
    const delivery = eventTail.then(async () => {
      await onEvent(params);
      if (record === current) {
        applyUpdate(params, updatePhase, ordinal);
        scheduleSilence(record);
      }
    });
    eventTail = delivery.then(
      () => undefined,
      () => {
        terminalFailure(safeError('ACP event delivery failed'));
      },
    );
    return delivery.catch(() => {
      throw safeError('ACP event delivery failed');
    });
  }

  async function handleRequest(kind, context) {
    const origin = current;
    if (!origin || origin.connection.signal.aborted) throw safeError('ACP request connection is unavailable');
    const requestKey = `${origin.ordinal}:${kind}:${String(context.requestId)}`;
    if (pendingRequests.has(requestKey)) throw safeError('ACP request is already open');
    const reply = deferred();
    const record = {
      kind,
      requestKey,
      request: context.params,
      reply,
      signal: context.signal,
      origin,
      closed: false,
      cancel: null,
    };
    record.cancel = () => settleRequest(record, cancelResponse(record));
    pendingRequests.set(requestKey, record);
    context.signal.addEventListener('abort', record.cancel, { once: true });
    try {
      await onRequest({ requestKey, kind, payload: context.params });
    } catch {
      settleRequest(record, cancelResponse(record));
      throw terminalFailure(safeError('ACP request delivery failed'));
    }
    if (context.signal.aborted) settleRequest(record, cancelResponse(record));
    return reply.promise;
  }

  app
    .onNotification(CLIENT_METHODS.session_update, ({ params }) => queueEvent(params))
    .onRequest(CLIENT_METHODS.session_request_permission, (context) => handleRequest('permission', context))
    .onRequest(CLIENT_METHODS.elicitation_create, (context) => handleRequest('elicitation', context));

  async function watchRecord(record) {
    const loss = deferred();
    record.process.exited.then((result) => {
      record.exitResult = result;
      loss.resolve();
    }, () => loss.resolve());
    record.connection.closed.then(() => loss.resolve(), () => loss.resolve());
    await loss.promise;
    if (record.intentional || record.lossHandled || current !== record) return;
    record.lossHandled = true;
    if (phase === 'setting_up') return;
    if (phase === 'recovering') {
      terminalFailure(safeError('ACP session resume failed with a transient error'));
      return;
    }
    if (phase === 'foreground' && foreground) {
      if (!foreground.accepted) {
        terminalFailure(safeError('ACP prompt acceptance is uncertain'));
        return;
      }
      void recover(record).catch(() => {
        terminalFailure(safeError('ACP session recovery failed with a transient error'));
      });
      return;
    }
    if (phase === 'idle') terminalFailure(safeError('ACP connection ended unexpectedly'));
  }

  async function openConnection() {
    let processHandle;
    try {
      processHandle = spawnProcess({
        bin: command.bin,
        args: [...command.args],
        cwd,
        env,
      });
    } catch {
      throw safeError('ACP child process could not be started');
    }
    const connection = app.connect(ndJsonStream(processHandle.input, processHandle.output));
    const record = {
      ordinal: ++connectionOrdinal,
      process: processHandle,
      connection,
      agent: connection.agent,
      intentional: false,
      lossHandled: false,
      shutdownPromise: null,
      exitResult: null,
      resumeState: null,
    };
    current = record;
    lastRecord = record;
    void watchRecord(record);
    let initialized;
    try {
      initialized = await requestWithDeadline(record.agent, AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: 'fluent-flow-runner', version: '0.1.0' },
        capabilities: { elicitation: { form: {} } },
      }, 'ACP initialization failed');
    } catch {
      await shutdownRecord(record);
      throw safeError('ACP initialization failed');
    }
    if (initialized.protocolVersion !== PROTOCOL_VERSION || initialized.capabilities?.session == null) {
      await shutdownRecord(record);
      throw new IncompatibleAcpError('ACP agent is incompatible: session capability is required');
    }
    return record;
  }

  async function setup() {
    const record = await openConnection();
    let created;
    try {
      created = await requestWithDeadline(record.agent, AGENT_METHODS.session_new, {
        cwd,
        mcpServers: [],
      }, 'ACP session setup failed');
    } catch {
      await shutdownRecord(record);
      throw safeError('ACP session setup failed');
    }
    sessionId = created.sessionId;
    try {
      const listed = await requestWithDeadline(record.agent, AGENT_METHODS.session_list, { cwd }, 'ACP session/list compatibility probe failed');
      if (!Array.isArray(listed.sessions)) throw safeError('ACP session/list compatibility probe failed');
    } catch {
      const disconnected = record.connection.signal.aborted || record.exitResult !== null;
      await shutdownRecord(record);
      if (disconnected) throw safeError('ACP session setup failed');
      throw new IncompatibleAcpError('ACP agent is incompatible: session/list is unavailable');
    }
    return record;
  }

  function setupCannotContinue() {
    return phase === 'closing' || phase === 'closed' || phase === 'failed';
  }

  async function acceptSetupRecord(record) {
    if (setupCannotContinue()) {
      await shutdownRecord(record);
      throw safeError('ACP runtime closed during setup');
    }
    phase = 'idle';
    return record;
  }

  async function setupWithRetry() {
    if (setupCannotContinue()) throw safeError('ACP runtime is not available');
    phase = 'setting_up';
    try {
      return await acceptSetupRecord(await setup());
    } catch (error) {
      if (setupCannotContinue()) throw safeError('ACP runtime closed during setup');
      if (error instanceof IncompatibleAcpError) {
        phase = 'failed';
        if (!finalExit.settled) finalExit.resolve(publicExit(lastRecord?.exitResult));
        throw error;
      }
      try {
        consumeRestart();
      } catch (budgetError) {
        if (setupCannotContinue()) throw safeError('ACP runtime closed during setup');
        phase = 'failed';
        if (!finalExit.settled) finalExit.resolve(publicExit(lastRecord?.exitResult));
        throw budgetError;
      }
      if (setupCannotContinue()) throw safeError('ACP runtime closed during setup');
      try {
        return await acceptSetupRecord(await setup());
      } catch (retryError) {
        if (setupCannotContinue()) throw safeError('ACP runtime closed during setup');
        phase = 'failed';
        if (!finalExit.settled) finalExit.resolve(publicExit(lastRecord?.exitResult));
        throw retryError instanceof IncompatibleAcpError ? retryError : safeError('ACP session setup failed after retry');
      }
    }
  }

  function scheduleSilence(record) {
    clearSilenceTimer();
    if (record !== current || !foreground || (phase !== 'foreground' && phase !== 'recovering')) return;
    silenceTimer = timers.setTimeout(() => {
      silenceTimer = null;
      void probeLiveness(record).catch(() => {
        terminalFailure(safeError('ACP liveness recovery failed'));
      });
    }, limits.silenceMs);
  }

  async function probeLiveness(record) {
    if (livenessRunning || record !== current || phase !== 'foreground' || !foreground) return;
    livenessRunning = true;
    try {
      await requestWithDeadline(record.agent, AGENT_METHODS.session_list, { cwd }, 'ACP liveness probe failed');
      if (record === current && phase === 'foreground') scheduleSilence(record);
    } catch {
      if (record === current && phase === 'foreground' && foreground) {
        record.lossHandled = true;
        if (foreground.accepted) {
          await recover(record);
        } else {
          terminalFailure(safeError('ACP prompt acceptance is uncertain'));
        }
      }
    } finally {
      livenessRunning = false;
    }
  }

  async function recover(failedRecord) {
    if (recoveryUsed) throw terminalFailure(safeError('ACP session recovery is exhausted'));
    recoveryUsed = true;
    phase = 'recovering';
    clearSilenceTimer();
    await eventTail;
    await shutdownRecord(failedRecord);
    if (phase === 'closing' || phase === 'closed' || phase === 'failed') return;
    consumeRestart();
    const replacement = await openConnection();
    if (phase === 'closing' || phase === 'closed' || phase === 'failed') {
      await shutdownRecord(replacement);
      return;
    }
    replacement.resumeState = {
      record: replacement,
      awaitingSnapshot: true,
      snapshot: null,
      sawActive: false,
      retainedStop: null,
      firstState: deferred(),
    };
    try {
      await requestWithDeadline(replacement.agent, AGENT_METHODS.session_resume, {
        sessionId,
        cwd,
        mcpServers: [],
      }, 'ACP session resume failed with a transient error');
      await eventTail;
    } catch {
      throw terminalFailure(safeError('ACP session resume failed with a transient error'));
    }
    if (!replacement.resumeState.snapshot) {
      await waitWithDeadline(replacement.resumeState.firstState.promise, limits.requestTimeoutMs);
      await eventTail;
    }
    const snapshot = replacement.resumeState.snapshot;
    replacement.resumeState.awaitingSnapshot = false;
    if (snapshot === 'idle') {
      throw terminalFailure(safeError('ACP resumed idle state is uncertain'));
    }
    if (snapshot !== 'running' && snapshot !== 'requires_action') {
      throw terminalFailure(safeError('ACP session resume did not provide a valid state'));
    }
    if (!foreground || phase === 'failed' || phase === 'closing' || phase === 'closed') return;
    foreground.sawRunning = true;
    phase = 'foreground';
    if (replacement.resumeState.retainedStop) {
      foreground.stop = replacement.resumeState.retainedStop;
      completeForegroundIfReady();
    }
    if (phase === 'foreground') scheduleSilence(replacement);
  }

  async function submitPrompt(text) {
    if (typeof text !== 'string' || text.trim().length === 0) throw safeError('ACP prompt must be non-empty text');
    if (phase !== 'idle' || !current || !sessionId) throw safeError('ACP session is not ready for a prompt');
    const turn = {
      accepted: false,
      messageId: null,
      sawRunning: false,
      stop: null,
      completion: deferred(),
      startEventOrdinal: eventOrdinal,
    };
    foreground = turn;
    phase = 'foreground';
    scheduleSilence(current);
    try {
      const response = await requestWithDeadline(current.agent, AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: 'text', text }],
      }, 'ACP prompt acceptance is uncertain');
      if (foreground !== turn || phase === 'failed') return await turn.completion.promise;
      turn.accepted = true;
      turn.messageId = response.messageId;
      completeForegroundIfReady();
    } catch {
      if (!turn.accepted) terminalFailure(safeError('ACP prompt acceptance is uncertain'));
    }
    return turn.completion.promise;
  }

  async function runInitialPrompt(text) {
    if (initialPromptStarted) throw safeError('ACP initial prompt has already started');
    initialPromptStarted = true;
    await setupWithRetry();
    return submitPrompt(text);
  }

  async function prompt(text) {
    if (!initialPromptStarted) throw safeError('ACP initial prompt has not started');
    return submitPrompt(text);
  }

  async function cancel() {
    if (!current || !sessionId || !foreground || (phase !== 'foreground' && phase !== 'recovering')) {
      throw safeError('ACP foreground work is not active');
    }
    settlePendingRequests();
    try {
      await notifyWithDeadline(current.agent, AGENT_METHODS.session_cancel, { sessionId }, 'ACP cancellation failed');
    } catch {
      throw terminalFailure(safeError('ACP cancellation failed'));
    }
    return { accepted: true };
  }

  async function answerRequest(requestKey, answer) {
    const record = pendingRequests.get(requestKey);
    if (!record || record.closed) throw safeError('ACP request is unknown or not open');
    if (record.origin !== current || record.origin.connection.signal.aborted) {
      settleRequest(record, cancelResponse(record));
      throw safeError('ACP request is unknown or not open');
    }
    const valid = record.kind === 'permission'
      ? validatePermissionAnswer(answer, record.request)
      : validateElicitationAnswer(answer, record.request);
    if (!valid) throw safeError('ACP request answer is invalid');
    settleRequest(record, answer);
    return { accepted: true };
  }

  async function closeRuntime() {
    if (phase === 'closed') return;
    const priorPhase = phase;
    phase = 'closing';
    for (const controller of [...activeRequestControllers]) {
      controller.abort(safeError('ACP runtime is shutting down'));
    }
    clearSilenceTimer();
    settlePendingRequests();
    if (terminalCleanup) await terminalCleanup;
    const record = current;
    if (record && sessionId && foreground && (priorPhase === 'foreground' || priorPhase === 'recovering')) {
      try {
        await notifyWithDeadline(record.agent, AGENT_METHODS.session_cancel, { sessionId }, 'ACP cancellation timed out');
      } catch {
        report('debug', 'ACP cancellation was unavailable during shutdown');
      }
      const idle = await waitWithDeadline(foreground.completion.promise, limits.shutdownIdleMs);
      if (idle.timedOut || idle.error) rejectForeground(safeError('ACP foreground shutdown did not complete'));
    } else {
      rejectForeground(safeError('ACP runtime closed'));
    }
    if (record && sessionId) {
      try {
        await requestWithDeadline(record.agent, AGENT_METHODS.session_close, { sessionId }, 'ACP session close timed out');
      } catch {
        report('debug', 'ACP session close was unavailable during shutdown');
      }
    }
    const result = record ? await shutdownRecord(record) : lastRecord?.exitResult ?? null;
    phase = 'closed';
    if (!finalExit.settled) finalExit.resolve(publicExit(result));
  }

  function close() {
    if (!closePromise) closePromise = closeRuntime();
    return closePromise;
  }

  return {
    runInitialPrompt,
    prompt,
    cancel,
    answerRequest,
    close,
    exited: finalExit.promise,
  };
}
