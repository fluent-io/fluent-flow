import { execFile as execFileCb } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { createAcpRuntime as createDefaultAcpRuntime } from './acp/runtime.js';
import { canonicalAdapter, resolveAcpCommand } from './acp/command.js';
import { createAcpStreamRedactor, normalizeAcpUpdate, redactAcpPayload } from './acp/normalize.js';
import { buildChildEnvironment, withClaimGitHubToken } from './environment.js';
import { prepareWorktree } from './worktree.js';
import { CLAIM_TYPES, promptSizeViolation, resolvePrompt } from './prompts.js';
import { safeError } from './safe-error.js';
import { runVerifyClaim } from './verify.js';

const DEFAULT_MAX_POLL_FAILURES = 30;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const MAX_BACKOFF_TOTAL_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_COMMAND_POLL_MS = 1000;
const DEFAULT_COMMAND_LEASE_RENEW_MS = 30_000;
const DEFAULT_EVENT_FLUSH_MS = 250;
const DEFAULT_EVENT_BATCH_SIZE = 25;
const DEFAULT_AGENT_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const REPORT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const SECRET_ENV_NAME = /(?:token|secret|password|credential|api[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|(?:^|[_-])key(?:[_-]|$))/iu;
const IGNORED_ENV_SECRET_VALUES = new Set(['true', 'false', 'null', 'undefined', 'none', 'yes', 'no', 'on', 'off']);
const DEFINITE_COMMAND_REJECTION = /(invalid|required|unknown or not open|not ready|not active|not open|has not started|already|unsupported|must be|non-empty)/iu;

function numFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandFailureIsUncertain(error) {
  const message = String(error?.message ?? '');
  return !DEFINITE_COMMAND_REJECTION.test(message);
}

function collectText(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'text' && typeof item === 'string') output.push(item);
    else collectText(item, output);
  }
}

function createRuntimeLog(log) {
  return {
    debug: () => log.debug('ACP runtime activity'),
    info: () => log.info('ACP runtime activity'),
    warn: () => log.warn('ACP runtime warning'),
    error: () => log.error('ACP runtime failure'),
  };
}

function environmentSecrets(environment) {
  const values = [];
  for (const [name, value] of Object.entries(environment)) {
    if (
      (!SECRET_ENV_NAME.test(name) && !/^GIT_CONFIG_VALUE_\d+$/u.test(name))
      || typeof value !== 'string'
    ) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 8 || IGNORED_ENV_SECRET_VALUES.has(normalized)) continue;
    if (/^[+-]?(?:0+(?:\.0+)?|1(?:\.0+)?)$/u.test(normalized)) continue;
    values.push(value);
    const authorization = /^Authorization: Basic (.+)$/iu.exec(value);
    if (authorization) values.push(authorization[1]);
  }
  return values;
}

function executeCommand(command, cwd, timeoutMs = 0, environment = {}, signal) {
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'Command aborted',
      timedOut: false,
    });
  }
  return new Promise((resolve) => {
    const child = execFileCb(
      command.bin,
      command.args ?? [],
      {
        cwd,
        env: environment,
        signal,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const result = {
          exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error?.killed && error?.signal),
        };
        if (error?.code === 'ABORT_ERR') {
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
          killTimer.unref?.();
          child.once('close', () => {
            clearTimeout(killTimer);
            resolve(result);
          });
          return;
        }
        resolve(result);
      },
    );
  });
}

export function createRunner({
  client,
  log,
  createAcpRuntime = createDefaultAcpRuntime,
  cwd,
  childEnvironment = buildChildEnvironment(),
  meta,
  maxPollFailures,
  heartbeatIntervalMs,
  acpCommand,
  provider,
  acpArgs = [],
  commandPollMs = DEFAULT_COMMAND_POLL_MS,
  commandLeaseRenewMs = DEFAULT_COMMAND_LEASE_RENEW_MS,
  eventFlushMs = DEFAULT_EVENT_FLUSH_MS,
  eventBatchSize = DEFAULT_EVENT_BATCH_SIZE,
  agentTextLimitBytes = DEFAULT_AGENT_TEXT_LIMIT_BYTES,
  runnerToken,
  secretValues = [],
  runtimeLimits,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
}) {
  if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs < 1) {
    throw new Error('Execution timeout must be a positive number of milliseconds.');
  }
  let running = false;
  let sessionId = null;
  let activeState = null;
  let consecutiveFailures = 0;
  let cleanupFailed = false;
  let shutdownPromise = null;
  let claimPollController = null;
  const maxFailures = maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES;
  const heartbeatMs = heartbeatIntervalMs ?? numFromEnv('FLUENT_FLOW_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
  const leaseRenewMs = Math.max(1, Math.floor(commandLeaseRenewMs));
  const baseCwd = resolvePath(cwd ?? process.cwd());
  const batchSize = Math.max(1, Math.floor(eventBatchSize));
  const textLimit = Math.max(0, Math.floor(agentTextLimitBytes));
  const sessionMeta = {
    ...(meta ?? {
      hostname: hostname(),
      os: platform(),
      ...(cwd && { cwd }),
    }),
    supported_claim_types: CLAIM_TYPES,
  };

  function claimIdOf(work) {
    return work.claim_id ?? work.claimId ?? work.id ?? null;
  }

  function claimPayload(work, status, extra = {}) {
    const payload = {
      status,
      repo: work.repo,
      pr_number: work.prNumber ?? work.pr_number ?? null,
      attempt: work.attempt,
      session_id: sessionId,
    };
    const claimId = claimIdOf(work);
    if (claimId != null) payload.claim_id = claimId;
    return { ...payload, ...extra };
  }

  async function reportClaimWithRetry(payload, { delays = REPORT_RETRY_DELAYS_MS } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        return await client.reportClaim(payload);
      } catch (error) {
        lastError = error;
        const match = /failed: (\d{3})/u.exec(error?.message ?? '');
        const status = match ? Number(match[1]) : null;
        if (status !== null && status < 500 && status !== 429) throw error;
        if (attempt < delays.length) {
          log.warn('Claim report failed, retrying', {
            attempt: attempt + 1,
            nextRetryMs: delays[attempt],
            httpStatus: status,
          });
          await delay(delays[attempt]);
        }
      }
    }
    throw lastError;
  }

  function reportState(state, status, extra = {}, options) {
    if (state.ownershipLost) return Promise.resolve();
    if (state.reportPromise) return state.reportPromise;
    state.reportPromise = (async () => {
      await drainHeartbeat(state);
      if (state.ownershipLost) return;
      const finalStatus = state.shuttingDown ? 'failed' : status;
      const finalExtra = state.shuttingDown ? { failure_kind: 'transient' } : extra;
      const finalOptions = state.shuttingDown ? { delays: [1000] } : options;
      const claimFields = {
        claimId: claimIdOf(state.work),
        repo: state.work.repo,
        attempt: state.work.attempt,
      };
      try {
        await reportClaimWithRetry(claimPayload(state.work, finalStatus, finalExtra), finalOptions);
        log.info('Claim reported', {
          event: 'claim_reported',
          ...claimFields,
          status: finalStatus,
          ...(finalExtra.failure_kind && { failureKind: finalExtra.failure_kind }),
        });
      } catch (error) {
        log.error('Failed to report claim', { event: 'claim_report_failed', ...claimFields, reason: safeError(error) });
      }
    })();
    return state.reportPromise;
  }
  function closeStateRuntime(state) {
    if (!state.runtime) return Promise.resolve();
    state.closePromise = state.closePromise ?? (async () => {
      await state.runtime.close();
      await state.runtime.exited;
    })();
    return state.closePromise;
  }
  function clearExecutionTimeout(state) {
    if (!state.executionTimer) return;
    clearTimeout(state.executionTimer);
    state.executionTimer = null;
  }
  function armExecutionTimeout(state, claimId) {
    clearExecutionTimeout(state);
    if (state.executionTimedOut || state.ownershipLost || state.shuttingDown) return;
    state.executionTimer = setTimeout(() => {
      state.executionTimer = null;
      if (activeState !== state || state.ownershipLost || state.shuttingDown || state.reportPromise) return;
      state.executionTimedOut = true;
      log.warn('Claim execution timed out', {
        event: 'claim_execution_timed_out',
        claimId,
        repo: state.work.repo,
        attempt: state.work.attempt,
      });
      state.executionTimeoutResolve(new Error('Claim execution timed out'));
      state.verificationController.abort();
      closeStateRuntime(state).catch((error) => {
        log.warn('ACP runtime close failed after claim execution timeout', { claimId, reason: safeError(error) });
      });
    }, executionTimeoutMs);
    state.executionTimer.unref?.();
  }
  function stopCommandService(state) {
    state.commandsRunning = false;
    state.commandPollController?.abort();
    const wake = state.commandWake;
    state.commandWake = null;
    wake?.();
    state.commandStopResolve?.();
  }
  function installTurnTail(state, turn) {
    const tail = Promise.resolve(turn);
    state.turnTail = tail;
    return tail;
  }

  function waitForCommandPoll(state) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.commandWake === wake) state.commandWake = null;
        resolve();
      };
      state.commandWake = wake;
      timer = setTimeout(wake, commandPollMs);
      timer.unref?.();
      if (!state.commandsRunning || state.shuttingDown) wake();
    });
  }

  function stopHeartbeat(state) {
    state.heartbeatStopped = true;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  async function drainHeartbeat(state) {
    stopHeartbeat(state);
    while (state.heartbeatRequests.size > 0) {
      await Promise.allSettled([...state.heartbeatRequests]);
    }
  }

  function releaseOwnership(state, claimId) {
    if (state.ownershipLost) return state.ownershipLossPromise ?? Promise.resolve();
    state.ownershipLost = true;
    stopHeartbeat(state);
    clearExecutionTimeout(state);
    state.verificationController.abort();
    state.commandTransportController.abort();
    stopCommandService(state);
    state.ownershipLossPromise = (async () => {
      if (!state.runtime) return;
      try {
        await closeStateRuntime(state);
      } catch (error) {
        log.warn('ACP runtime close failed after claim ownership loss', { claimId, reason: safeError(error) });
      }
    })();
    log.warn('Claim ownership released by control plane', { claimId });
    return state.ownershipLossPromise;
  }

  function startHeartbeat(state, claimId) {
    if (!claimId || !client.heartbeat || heartbeatMs <= 0) return;
    state.heartbeatStopped = false;
    const tick = () => {
      if (state.heartbeatStopped || !sessionId || activeState !== state) return;
      const request = (async () => {
        try {
          const response = await client.heartbeat(sessionId, claimId);
          if (activeState !== state) return;
          if (response?.claim === null) await releaseOwnership(state, claimId);
        } catch (error) {
          if (activeState !== state) return;
          if (/failed: 410/u.test(error?.message ?? '')) {
            await releaseOwnership(state, claimId);
            return;
          }
          log.warn('Claim heartbeat failed', { claimId });
        }
      })();
      state.heartbeatRequests.add(request);
      void request.then(
        () => state.heartbeatRequests.delete(request),
        () => state.heartbeatRequests.delete(request),
      );
    };
    state.heartbeatTimer = setInterval(tick, heartbeatMs);
    state.heartbeatTimer.unref?.();
  }

  function createInteractionBridge(state, claimId, runtimeEnvironment) {
    const eventQueue = [];
    const agentText = [];
    let agentTextBytes = 0;
    let sequence = 0;
    let flushTimer = null;
    let flushTail = Promise.resolve();
    const redactionValues = [
      runnerToken,
      ...secretValues,
      state.work.githubToken,
      ...environmentSecrets(runtimeEnvironment),
      ...environmentSecrets(process.env),
    ].filter((value) => typeof value === 'string' && value.length > 0);
    const streamRedactor = createAcpStreamRedactor(redactionValues);
    let eventSessionId = null;

    function appendAgentText(text) {
      if (textLimit === 0 || text.length === 0) return;
      let chunk = Buffer.from(text, 'utf8');
      if (chunk.length >= textLimit) {
        agentText.length = 0;
        chunk = Buffer.from(chunk.subarray(chunk.length - textLimit));
        agentText.push(chunk);
        agentTextBytes = chunk.length;
        return;
      }
      agentText.push(chunk);
      agentTextBytes += chunk.length;
      while (agentTextBytes > textLimit && agentText.length > 0) {
        const excess = agentTextBytes - textLimit;
        const first = agentText[0];
        if (first.length <= excess) {
          agentText.shift();
          agentTextBytes -= first.length;
        } else {
          agentText[0] = Buffer.from(first.subarray(excess));
          agentTextBytes -= excess;
        }
      }
    }

    function clearFlushTimer() {
      if (!flushTimer) return;
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    function flushEvents() {
      clearFlushTimer();
      const operation = flushTail.then(async () => {
        while (eventQueue.length > 0) {
          const events = eventQueue.slice(0, batchSize);
          await client.postClaimEvents(sessionId, claimId, events);
          eventQueue.splice(0, events.length);
        }
      });
      flushTail = operation.catch(() => undefined);
      return operation;
    }

    function failFromBackgroundUpload() {
      if (!state.interactionFailure) {
        state.interactionFailure = new Error('ACP event delivery failed');
        state.interactionFailureResolve?.(state.interactionFailure);
      }
      stopCommandService(state);
    }

    function scheduleFlush() {
      if (flushTimer || eventFlushMs <= 0) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushEvents().catch(failFromBackgroundUpload);
      }, eventFlushMs);
      flushTimer.unref?.();
    }

    async function queueUpdate(sessionId, update) {
      const nextSequence = sequence + 1;
      const event = normalizeAcpUpdate({
        claimId,
        sessionId,
        seq: nextSequence,
        update,
        secretValues: redactionValues,
      });
      sequence = nextSequence;
      if (event.kind === 'agent_message') {
        const pieces = [];
        collectText(event.payload.raw, pieces);
        for (const piece of pieces) appendAgentText(piece);
      }
      eventQueue.push(event);
      if (event.payload.raw.sessionUpdate === 'state_update') {
        if (event.payload.raw.state === 'running' || event.payload.raw.state === 'requires_action') {
          state.turnSawActive = true;
          state.turnReachedIdle = false;
        } else if (event.payload.raw.state === 'idle' && state.turnSawActive) {
          state.turnSawActive = false;
          state.turnReachedIdle = true;
          if (state.queuedPromptCount === 0 && !state.commandBatchActive) stopCommandService(state);
        }
      }
      if (eventQueue.length >= batchSize) await flushEvents();
      else scheduleFlush();
    }

    async function onEvent(params) {
      if (state.interactionFailure) throw state.interactionFailure;
      eventSessionId = params.sessionId;
      for (const update of streamRedactor.push(params.update)) {
        await queueUpdate(params.sessionId, update);
      }
    }

    async function finalizeEvents() {
      for (const update of streamRedactor.flush()) {
        await queueUpdate(eventSessionId, update);
      }
      await flushEvents();
    }

    async function onRequest(request) {
      await client.postClaimRequest(sessionId, claimId, {
        ...request,
        payload: redactAcpPayload(request.payload, redactionValues),
      });
    }

    async function onRequestCancelled(request) {
      await client.cancelClaimRequest(sessionId, claimId, request.requestKey);
    }

    return {
      onEvent,
      onRequest,
      onRequestCancelled,
      flushEvents,
      clearFlushTimer,
      finalizeEvents,
      agentMessageText: () => Buffer.concat(agentText, agentTextBytes).toString('utf8'),
    };
  }

  function commandIdOf(command) {
    const commandId = command?.id ?? command?.command_id;
    if ((typeof commandId !== 'string' || commandId.length === 0) && !Number.isSafeInteger(commandId)) {
      throw new Error('Claim command identifier is invalid');
    }
    return commandId;
  }

  function recordCommandFailure(state, error) {
    if (!state.commandFailure) {
      state.commandFailure = error;
      state.commandFailureResolve?.(error);
    }
    stopCommandService(state);
  }

  async function acknowledgeNotApplied(state, claimId, command) {
    try {
      await client.ackClaimCommand(
        sessionId,
        claimId,
        commandIdOf(command),
        'failed',
        { error: 'Command was not applied' },
        state.commandTransportOptions,
      );
    } catch (error) {
      recordCommandFailure(state, error);
    }
  }

  async function acknowledgeNotAppliedBatch(state, claimId, commands) {
    for (const command of commands) await acknowledgeNotApplied(state, claimId, command);
  }

  function schedulePromptCommand(state, claimId, command) {
    state.queuedPromptCount += 1;
    let queued = true;
    let turnSettled = false;
    let resolveTurn;
    const turn = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    const settleTurn = (outcome) => {
      if (turnSettled) return;
      turnSettled = true;
      resolveTurn(outcome);
    };
    const leaveQueue = () => {
      if (!queued) return;
      queued = false;
      state.queuedPromptCount -= 1;
      if (
        state.queuedPromptCount === 0
        && state.turnReachedIdle
        && !state.commandBatchActive
      ) {
        stopCommandService(state);
      }
    };
    const previousTurn = state.turnTail;
    installTurnTail(state, turn);

    const task = (async () => {
      let prior;
      while (!prior) {
        let renewalTimer;
        const renewalDue = new Promise((resolve) => {
          renewalTimer = setTimeout(() => resolve({ renewalDue: true }), leaseRenewMs);
          renewalTimer.unref?.();
        });
        const next = await Promise.race([
          previousTurn.then((outcome) => ({ outcome })),
          state.commandStopPromise.then(() => ({ stopped: true })),
          renewalDue,
        ]);
        clearTimeout(renewalTimer);
        if (!next.renewalDue) {
          prior = next;
          continue;
        }
        const renewal = await client.renewClaimCommand(sessionId, claimId, commandIdOf(command));
        if (!renewal?.renewed) {
          leaveQueue();
          const outcome = await previousTurn;
          settleTurn(outcome);
          return outcome;
        }
      }
      if (prior.stopped) {
        leaveQueue();
        const outcome = state.dashboardCancelApplied
          ? await previousTurn
          : {
              error: state.commandFailure
                ?? state.interactionFailure
                ?? new Error('Command service stopped before applying prompt'),
            };
        settleTurn(outcome);
        await acknowledgeNotApplied(state, claimId, command);
        return outcome;
      }

      const previousOutcome = prior.outcome;
      if (state.cancelBarrier) await state.cancelBarrier;
      if (
        previousOutcome.error
        || state.dashboardCancelApplied
        || state.shuttingDown
        || !state.commandsRunning
      ) {
        leaveQueue();
        settleTurn(previousOutcome);
        await acknowledgeNotApplied(state, claimId, command);
        return previousOutcome;
      }

      const commandId = commandIdOf(command);
      const payload = command.payload ?? {};
      const text = payload.text ?? payload.prompt;
      if (typeof text !== 'string' || text.trim().length === 0) {
        leaveQueue();
        settleTurn(previousOutcome);
        try {
          await client.ackClaimCommand(
            sessionId,
            claimId,
            commandId,
            'failed',
            { error: 'Command was rejected' },
            state.commandTransportOptions,
          );
        } catch (error) {
          recordCommandFailure(state, error);
        }
        return previousOutcome;
      }

      const renewal = await client.renewClaimCommand(sessionId, claimId, commandId);
      if (!renewal?.renewed) {
        leaveQueue();
        settleTurn(previousOutcome);
        return previousOutcome;
      }
      if (state.dashboardCancelApplied || state.shuttingDown || !state.commandsRunning) {
        leaveQueue();
        settleTurn(previousOutcome);
        await acknowledgeNotApplied(state, claimId, command);
        return previousOutcome;
      }

      state.turnReachedIdle = false;
      leaveQueue();
      state.turnSawActive = false;
      let result;
      let accepted = false;
      try {
        result = await state.runtime.prompt(text, {
          onAccepted: async ({ messageId }) => {
            accepted = true;
            await client.ackClaimCommand(
              sessionId,
              claimId,
              commandId,
              'acked',
              { applied: true, messageId },
              state.commandTransportOptions,
            );
          },
        });
        settleTurn({ result });
      } catch (error) {
        const uncertain = commandFailureIsUncertain(error);
        const outcome = uncertain ? { error } : previousOutcome;
        settleTurn(outcome);
        if (accepted) {
          recordCommandFailure(state, error);
          return outcome;
        }
        try {
          await client.ackClaimCommand(
            sessionId,
            claimId,
            commandId,
            uncertain ? 'uncertain' : 'failed',
            { error: uncertain ? 'Command outcome is uncertain' : 'Command was rejected' },
            state.commandTransportOptions,
          );
        } catch (ackError) {
          recordCommandFailure(state, ackError);
          return outcome;
        }
        if (uncertain) recordCommandFailure(state, error);
        return outcome;
      }
      return { result };
    })().catch((error) => {
      leaveQueue();
      settleTurn({ error });
      recordCommandFailure(state, error);
      return { error };
    });
    state.commandTasks.push(task);
  }

  async function applyImmediateCommand(state, claimId, command) {
    const commandId = commandIdOf(command);
    const renewal = await client.renewClaimCommand(sessionId, claimId, commandId);
    if (!renewal?.renewed) return;
    const payload = command.payload ?? {};
    let cancelBarrierResolve;
    let cancelBarrier;
    try {
      if (command.kind === 'cancel') {
        cancelBarrier = new Promise((resolve) => {
          cancelBarrierResolve = resolve;
        });
        state.cancelBarrier = cancelBarrier;
        await state.runtime.cancel();
        state.dashboardCancelApplied = true;
        stopCommandService(state);
        cancelBarrierResolve();
      } else if (command.kind === 'permission' || command.kind === 'elicitation') {
        const requestKey = command.request_key ?? command.requestKey ?? payload.requestKey;
        if (typeof requestKey !== 'string' || requestKey.length === 0) throw new Error('ACP request key is required');
        await state.runtime.answerRequest(requestKey, payload.answer ?? payload.response);
      } else {
        throw new Error('ACP command kind is unsupported');
      }
    } catch (error) {
      if (cancelBarrierResolve) cancelBarrierResolve();
      if (state.cancelBarrier === cancelBarrier) state.cancelBarrier = null;
      const uncertain = commandFailureIsUncertain(error);
      try {
        await client.ackClaimCommand(
          sessionId,
          claimId,
          commandId,
          uncertain ? 'uncertain' : 'failed',
          { error: uncertain ? 'Command outcome is uncertain' : 'Command was rejected' },
          state.commandTransportOptions,
        );
      } catch (ackError) {
        recordCommandFailure(state, ackError);
        return;
      }
      if (uncertain) recordCommandFailure(state, error);
      return;
    }

    try {
      await client.ackClaimCommand(
        sessionId,
        claimId,
        commandId,
        'acked',
        { applied: true },
        state.commandTransportOptions,
      );
    } catch (error) {
      recordCommandFailure(state, error);
    }
  }

  async function serviceCommands(state, claimId) {
    try {
      while (state.commandsRunning && !state.shuttingDown && !state.commandDraining) {
        const pollController = new AbortController();
        state.commandPollController = pollController;
        let response;
        try {
          response = await client.pollClaimCommands(
            sessionId,
            claimId,
            { signal: pollController.signal },
          );
        } catch (error) {
          if (pollController.signal.aborted && (!state.commandsRunning || state.shuttingDown || state.commandDraining)) break;
          throw error;
        } finally {
          if (state.commandPollController === pollController) state.commandPollController = null;
        }

        const commands = Array.isArray(response)
          ? response
          : Array.isArray(response?.commands)
            ? response.commands
            : response?.command
              ? [response.command]
              : [];

        if (!state.commandsRunning || state.shuttingDown) {
          await acknowledgeNotAppliedBatch(state, claimId, commands);
          break;
        }

        state.commandBatchActive = true;
        try {
          for (let index = 0; index < commands.length; index += 1) {
            if (!state.commandsRunning || state.shuttingDown) {
              await acknowledgeNotAppliedBatch(state, claimId, commands.slice(index));
              break;
            }
            const command = commands[index];
            if (command?.kind === 'prompt') schedulePromptCommand(state, claimId, command);
            else await applyImmediateCommand(state, claimId, command);
            if (!state.commandsRunning || state.shuttingDown) {
              await acknowledgeNotAppliedBatch(state, claimId, commands.slice(index + 1));
              break;
            }
          }
        } finally {
          state.commandBatchActive = false;
          if (
            state.commandsRunning
            && state.queuedPromptCount === 0
            && state.turnReachedIdle
          ) {
            stopCommandService(state);
          }
        }

        if (state.commandsRunning && !state.shuttingDown && commands.length === 0) {
          await waitForCommandPoll(state);
        }
      }
    } catch (error) {
      recordCommandFailure(state, error);
    }
  }

  function verdictFrom(text) {
    if (/<!--\s*reviewer-result:\s*\{\s*"status"\s*:\s*"FAIL"/iu.test(text)) return 'fail';
    if (/<!--\s*reviewer-result:/iu.test(text)) return 'pass';
    return undefined;
  }

  async function cleanupWorktree(cleanup) {
    if (!cleanup) return;
    try {
      await cleanup();
      cleanupFailed = false;
      log.info('Worktree cleaned up');
    } catch (error) {
      cleanupFailed = true;
      log.error('Worktree cleanup failed; continuing claim finalization', { reason: safeError(error) });
    }
  }

  function resetCommandSignals(state) {
    state.commandStopPromise = new Promise((resolve) => {
      state.commandStopResolve = resolve;
    });
    state.commandFailurePromise = new Promise((resolve) => {
      state.commandFailureResolve = resolve;
    });
    state.interactionFailurePromise = new Promise((resolve) => {
      state.interactionFailureResolve = resolve;
    });
    state.commandFailure = null;
    state.interactionFailure = null;
    state.commandDraining = false;
    state.commandBatchActive = false;
    state.commandLoop = null;
    state.commandTasks = [];
    state.queuedPromptCount = 0;
    state.turnSawActive = false;
    state.turnReachedIdle = false;
    state.turnTail = null;
    state.cancelBarrier = null;
    state.closePromise = null;
  }

  async function runAcpPrompt(state, claimId, { command, prompt, agentCwd, bridge, runtimeEnvironment }) {
    resetCommandSignals(state);
    try {
      state.runtime = createAcpRuntime({
        command,
        cwd: agentCwd,
        env: runtimeEnvironment,
        onEvent: bridge.onEvent,
        onRequest: bridge.onRequest,
        onRequestCancelled: bridge.onRequestCancelled,
        log: createRuntimeLog(log),
        ...(runtimeLimits && { limits: runtimeLimits }),
      });
    } catch {
      throw new Error('ACP runtime creation failed');
    }

    let runtimeResult;
    let runtimeFailure;
    state.commandsRunning = true;
    try {
      if (!state.claimDeadline) armExecutionTimeout(state, claimId);
      installTurnTail(
        state,
        (async () => state.runtime.runInitialPrompt(prompt))().then(
          (result) => ({ result }),
          (error) => ({ error }),
        ),
      );
      state.commandLoop = serviceCommands(state, claimId);
      let observedTurn;
      do {
        observedTurn = state.turnTail;
        const settled = await Promise.race([
          observedTurn.then((outcome) => ({ outcome })),
          state.commandFailurePromise.then((error) => ({ commandFailure: error })),
          state.interactionFailurePromise.then((error) => ({ interactionFailure: error })),
          state.executionTimeoutPromise.then((error) => ({ executionTimeout: error })),
        ]);
        if (settled.commandFailure) {
          runtimeFailure = runtimeFailure ?? settled.commandFailure;
          break;
        }
        if (settled.interactionFailure) {
          runtimeFailure = runtimeFailure ?? settled.interactionFailure;
          break;
        }
        if (settled.executionTimeout) {
          runtimeFailure = runtimeFailure ?? settled.executionTimeout;
          break;
        }
        if (settled.outcome.error) runtimeFailure = runtimeFailure ?? settled.outcome.error;
        else runtimeResult = settled.outcome.result;
        if (observedTurn === state.turnTail) {
          state.commandDraining = true;
          state.commandWake?.();
          let drainTimer;
          const commandLoopDrained = state.commandLoop ? await Promise.race([
            state.commandLoop.then(() => true),
            new Promise((resolve) => {
              drainTimer = setTimeout(() => resolve(false), commandPollMs);
              drainTimer.unref?.();
            }),
          ]) : true;
          clearTimeout(drainTimer);
          if (!commandLoopDrained) {
            state.commandPollController?.abort();
            await state.commandLoop;
          }
          if (observedTurn !== state.turnTail && state.commandsRunning && !state.shuttingDown) {
            state.commandDraining = false;
            state.commandLoop = serviceCommands(state, claimId);
          }
        }
      } while (observedTurn !== state.turnTail);
    } finally {
      stopCommandService(state);
      if (!state.claimDeadline) clearExecutionTimeout(state);
      if (state.commandFailure || state.interactionFailure || state.shuttingDown || state.executionTimedOut) {
        try {
          await closeStateRuntime(state);
        } catch (error) {
          runtimeFailure = runtimeFailure ?? error;
        }
      }
      if (state.commandLoop) await state.commandLoop;
      if (state.commandTasks.length > 0) await Promise.all(state.commandTasks);
      try {
        await closeStateRuntime(state);
      } catch (error) {
        runtimeFailure = runtimeFailure ?? error;
      }
      state.runtime = null;
      state.closePromise = null;
    }
    if (state.shuttingDown || state.executionTimedOut || runtimeFailure || state.commandFailure || state.interactionFailure || !runtimeResult) {
      throw runtimeFailure ?? state.commandFailure ?? state.interactionFailure ?? new Error('ACP turn did not complete');
    }
    return runtimeResult;
  }

  function agentMatchesProvider(agentType) {
    if (!provider || (acpCommand !== undefined && acpCommand !== null)) return true;
    const expected = canonicalAdapter(provider);
    return expected !== null && canonicalAdapter(agentType) === expected;
  }

  function logPromptTooLarge(claimId, work, { promptBytes, limitBytes }) {
    log.error('Claim prompt exceeds size limit', {
      event: 'claim_prompt_too_large',
      claimId,
      repo: work.repo,
      attempt: work.attempt,
      promptBytes,
      limitBytes,
    });
  }

  async function handleWork(work) {
    let commandStopResolve;
    let commandFailureResolve;
    let interactionFailureResolve;
    const commandStopPromise = new Promise((resolve) => {
      commandStopResolve = resolve;
    });
    const commandFailurePromise = new Promise((resolve) => {
      commandFailureResolve = resolve;
    });
    const interactionFailurePromise = new Promise((resolve) => {
      interactionFailureResolve = resolve;
    });
    let executionTimeoutResolve;
    const executionTimeoutPromise = new Promise((resolve) => {
      executionTimeoutResolve = resolve;
    });
    const claimId = claimIdOf(work);
    const state = {
      work,
      runtime: null,
      closePromise: null,
      bridge: null,
      commandsRunning: false,
      commandDraining: false,
      commandBatchActive: false,
      commandWake: null,
      commandLoop: null,
      commandTasks: [],
      queuedPromptCount: 0,
      turnSawActive: false,
      commandPollController: null,
      turnReachedIdle: false,
      commandTransportController: new AbortController(),
      verificationController: new AbortController(),
      commandTransportOptions: null,
      turnTail: null,
      cancelBarrier: null,
      commandStopPromise,
      commandStopResolve,
      commandFailurePromise,
      commandFailureResolve,
      interactionFailurePromise,
      interactionFailureResolve,
      executionTimer: null,
      executionTimedOut: false,
      claimDeadline: false,
      executionTimeoutPromise,
      executionTimeoutResolve,
      commandFailure: null,
      interactionFailure: null,
      dashboardCancelApplied: false,
      shuttingDown: false,
      ownershipLost: false,
      ownershipLossPromise: null,
      heartbeatTimer: null,
      heartbeatStopped: true,
      heartbeatRequests: new Set(),
      reportPromise: null,
    };
    state.commandTransportOptions = { signal: state.commandTransportController.signal };
    activeState = state;
    startHeartbeat(state, claimId);
    let worktreeCleanup = null;
    let bridge = null;
    let runtimeResult = null;
    let runtimeFailure = null;

    try {
      log.info('Claim accepted', { event: 'claim_accepted', claimId, repo: work.repo, attempt: work.attempt });
      const claimEnvironment = withClaimGitHubToken(childEnvironment, work.githubToken);

      if (!agentMatchesProvider(work.agentType)) {
        log.error('Claim agent type does not match the configured provider', {
          event: 'claim_provider_mismatch',
          claimId,
          repo: work.repo,
          attempt: work.attempt,
        });
        stopHeartbeat(state);
        await reportState(state, 'failed', { failure_kind: 'terminal' });
        return;
      }

      const requestedClaimType = work.claim_type ?? work.claimType ?? 'review_fix';
      if (requestedClaimType === 'verify') {
        const runtimeEnvironment = claimEnvironment;
        bridge = createInteractionBridge(state, claimId, runtimeEnvironment);
        state.bridge = bridge;
        state.claimDeadline = true;
        armExecutionTimeout(state, claimId);
        const verification = runVerifyClaim({
          work,
          cwd: baseCwd,
          environment: childEnvironment,
          githubToken: work.githubToken,
          onPromptTooLarge: (violation) => logPromptTooLarge(claimId, work, violation),
          execute: (command, commandCwd, timeoutMs) => (
            executeCommand(
              command,
              commandCwd,
              timeoutMs,
              claimEnvironment,
              state.verificationController.signal,
            )
          ),
          author: async ({ worktreePath, prompt: authorPrompt, work: authorWork }) => {
            if (state.shuttingDown || state.ownershipLost || state.executionTimedOut) throw new Error('Runner no longer owns the claim');
            if (!authorWork.agentType) throw new Error('Claim agent type is missing');
            const authorCommand = resolveAcpCommand({
              agentType: authorWork.agentType,
              command: acpCommand,
              args: acpArgs,
            });
            const turn = await runAcpPrompt(state, claimId, {
              command: authorCommand,
              prompt: authorPrompt,
              agentCwd: resolvePath(worktreePath),
              bridge,
              runtimeEnvironment,
            });
            if (turn.stopReason !== 'end_turn') throw new Error('ACP authoring turn did not complete');
          },
        });
        let result;
        try {
          result = await Promise.race([
            verification,
            state.executionTimeoutPromise.then(() => ({ status: 'failed', failure_kind: 'transient' })),
          ]);
        } catch (error) {
          log.error('Verification failed', { event: 'claim_verification_failed', claimId, reason: safeError(error) });
          result = { status: 'failed', failure_kind: 'transient' };
        }
        clearExecutionTimeout(state);
        if (state.executionTimedOut) {
          verification.catch((error) => {
            log.warn('Verification stopped with an error after claim execution timeout', { claimId, reason: safeError(error) });
          });
        }
        try {
          await bridge.finalizeEvents();
        } catch (error) {
          log.error('Verification events could not be delivered', { event: 'claim_events_failed', claimId, reason: safeError(error) });
          result = { status: 'failed', failure_kind: 'transient' };
        }
        if (state.executionTimedOut) result = { status: 'failed', failure_kind: 'transient' };
        stopHeartbeat(state);
        await reportState(state, result.status, {
          ...(result.failure_kind && { failure_kind: result.failure_kind }),
          ...(result.verification && { verification: result.verification }),
        });
        return;
      }

      let prompt;
      let command;
      try {
        const claimType = work.claim_type ?? work.claimType ?? 'review_fix';
        prompt = resolvePrompt({ claimType, work });
        if (!work.agentType) throw new Error('Claim agent type is missing');
        command = resolveAcpCommand({ agentType: work.agentType, command: acpCommand, args: acpArgs });
      } catch (error) {
        log.error('ACP claim setup failed', { claimId, reason: safeError(error) });
        stopHeartbeat(state);
        await reportState(state, 'failed', { failure_kind: 'transient' });
        return;
      }

      const violation = promptSizeViolation(prompt);
      if (violation) {
        logPromptTooLarge(claimId, work, violation);
        stopHeartbeat(state);
        await reportState(state, 'failed', { failure_kind: 'terminal' });
        return;
      }

      let agentCwd = baseCwd;
      if (work.branch && work.repo) {
        try {
          const prepared = await prepareWorktree({
            workDir: baseCwd,
            repo: work.repo,
            branch: work.branch,
            claimId,
            environment: childEnvironment,
            githubToken: work.githubToken,
          });
          agentCwd = resolvePath(prepared.worktreePath);
          worktreeCleanup = prepared.cleanup;
          log.info('Worktree ready');
        } catch (error) {
          log.error('Worktree preparation failed', { claimId, reason: safeError(error) });
          stopHeartbeat(state);
          await reportState(state, 'failed', { failure_kind: 'transient' });
          return;
        }
      }
      if (state.ownershipLost) return;

      if (state.shuttingDown) {
        stopHeartbeat(state);
        await reportState(state, 'failed', { failure_kind: 'transient' }, { delays: [1000] });
        return;
      }

      const runtimeEnvironment = claimEnvironment;
      try {
        bridge = createInteractionBridge(state, claimId, runtimeEnvironment);
        state.bridge = bridge;
        state.runtime = createAcpRuntime({
          command,
          cwd: agentCwd,
          env: runtimeEnvironment,
          onEvent: bridge.onEvent,
          onRequest: bridge.onRequest,
          onRequestCancelled: bridge.onRequestCancelled,
          log: createRuntimeLog(log),
          ...(runtimeLimits && { limits: runtimeLimits }),
        });
      } catch {
        runtimeFailure = new Error('ACP runtime creation failed');
      }

      if (state.runtime) {
        state.commandsRunning = true;
        state.turnSawActive = false;
        try {
          armExecutionTimeout(state, claimId);
          installTurnTail(
            state,
            (async () => state.runtime.runInitialPrompt(prompt))().then(
              (result) => ({ result }),
              (error) => ({ error }),
            ),
          );
          state.commandLoop = serviceCommands(state, claimId);
          let observedTurn;
          do {
            observedTurn = state.turnTail;
            const settled = await Promise.race([
              observedTurn.then((outcome) => ({ outcome })),
              state.commandFailurePromise.then((error) => ({ commandFailure: error })),
              state.interactionFailurePromise.then((error) => ({ interactionFailure: error })),
              state.executionTimeoutPromise.then((error) => ({ executionTimeout: error })),
            ]);
            if (settled.commandFailure) {
              runtimeFailure = runtimeFailure ?? settled.commandFailure;
              break;
            }
            if (settled.interactionFailure) {
              runtimeFailure = runtimeFailure ?? settled.interactionFailure;
              break;
            }
            if (settled.executionTimeout) {
              runtimeFailure = runtimeFailure ?? settled.executionTimeout;
              break;
            }
            if (settled.outcome.error) runtimeFailure = runtimeFailure ?? settled.outcome.error;
            else runtimeResult = settled.outcome.result;
            if (observedTurn === state.turnTail) {
              state.commandDraining = true;
              state.commandWake?.();
              let drainTimer;
              const commandLoopDrained = state.commandLoop ? await Promise.race([
                state.commandLoop.then(() => true),
                new Promise((resolve) => {
                  drainTimer = setTimeout(() => resolve(false), commandPollMs);
                  drainTimer.unref?.();
                }),
              ]) : true;
              clearTimeout(drainTimer);
              if (!commandLoopDrained) {
                state.commandPollController?.abort();
                await state.commandLoop;
              }
              if (observedTurn !== state.turnTail && state.commandsRunning && !state.shuttingDown) {
                state.commandDraining = false;
                state.commandLoop = serviceCommands(state, claimId);
              }
            }
          } while (observedTurn !== state.turnTail);
        } finally {
          stopCommandService(state);
          clearExecutionTimeout(state);
          if (state.commandFailure || state.interactionFailure || state.shuttingDown || state.executionTimedOut) {
            try {
              await closeStateRuntime(state);
            } catch (error) {
              runtimeFailure = runtimeFailure ?? error;
            }
          }
          if (state.commandLoop) await state.commandLoop;
          if (state.commandTasks.length > 0) await Promise.all(state.commandTasks);
          try {
            await closeStateRuntime(state);
          } catch (error) {
            runtimeFailure = runtimeFailure ?? error;
          }
          if (bridge) {
            bridge.clearFlushTimer();
            try {
              await bridge.finalizeEvents();
            } catch (error) {
              state.interactionFailure = state.interactionFailure ?? error;
            }
          }
        }
      }

      await cleanupWorktree(worktreeCleanup);
      worktreeCleanup = null;
      stopHeartbeat(state);

      if (state.shuttingDown || state.executionTimedOut || runtimeFailure || state.commandFailure || state.interactionFailure || !runtimeResult) {
        await reportState(state, 'failed', { failure_kind: 'transient' }, state.shuttingDown ? { delays: [1000] } : undefined);
        return;
      }

      const stopReason = runtimeResult.stopReason;
      let status;
      let failureKind;
      if (stopReason === 'end_turn') status = 'completed';
      else if (stopReason === 'cancelled' && state.dashboardCancelApplied) status = 'cancelled';
      else if (stopReason === 'cancelled') {
        status = 'failed';
        failureKind = 'transient';
      } else {
        status = 'failed';
      }

      const claimType = work.claim_type ?? work.claimType;
      const verdict = status === 'completed' && claimType === 'review' && bridge
        ? verdictFrom(bridge.agentMessageText())
        : undefined;
      await reportState(state, status, {
        ...(failureKind && { failure_kind: failureKind }),
        ...(verdict && { verdict }),
      });
    } finally {
      stopCommandService(state);
      clearExecutionTimeout(state);
      bridge?.clearFlushTimer();
      await drainHeartbeat(state);
      await cleanupWorktree(worktreeCleanup);
      if (activeState === state) activeState = null;
    }
  }


  async function doShutdown() {
    log.info('Shutting down');
    running = false;
    claimPollController?.abort();
    const state = activeState;
    if (!state) return;
    stopHeartbeat(state);
    clearExecutionTimeout(state);
    state.shuttingDown = true;
    state.verificationController.abort();
    state.commandTransportController.abort();
    stopCommandService(state);
    if (state.runtime) {
      try {
        await closeStateRuntime(state);
      } catch {
        log.warn('ACP runtime shutdown failed; reporting transient claim failure');
      }
    }
    if (state.commandLoop) await state.commandLoop;
    if (state.commandTasks.length > 0) await Promise.all(state.commandTasks);
    if (state.bridge) {
      state.bridge.clearFlushTimer();
      try {
        await state.bridge.finalizeEvents();
      } catch {
        state.interactionFailure = state.interactionFailure ?? new Error('ACP event delivery failed');
      }
    }
    await reportState(state, 'failed', { failure_kind: 'transient' }, { delays: [1000] });
  }

  return {
    async start() {
      running = true;
      log.info('Registering session');
      const registration = await client.register(sessionMeta);
      sessionId = registration.session_id;
      log.info('Session registered', { event: 'slot_registered', sessionId, status: registration.status });

      consecutiveFailures = 0;
      let backoffStart = null;
      while (running) {
        try {
          const controller = new AbortController();
          claimPollController = controller;
          let work;
          try {
            work = await client.poll(sessionId, { signal: controller.signal });
          } finally {
            if (claimPollController === controller) claimPollController = null;
          }
          consecutiveFailures = 0;
          backoffStart = null;
          if (work && !running) {
            await reportClaimWithRetry(
              claimPayload(work, 'failed', { failure_kind: 'transient' }),
              { delays: [1000] },
            );
            break;
          }
          if (work) await handleWork(work);
          else await delay(100);
        } catch (error) {
          if (!running) break;
          consecutiveFailures += 1;
          if (!backoffStart) backoffStart = Date.now();
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
          if (Date.now() - backoffStart >= MAX_BACKOFF_TOTAL_MS) {
            running = false;
            log.error('Poll watchdog exceeded its retry window', { consecutiveFailures });
            throw new Error('Poll watchdog exceeded its retry window', { cause: error });
          }
          log.error('Poll failed', { consecutiveFailures, maxFailures, nextRetryMs: backoff });
          if (error?.message?.startsWith('Poll failed: 410')) {
            try {
              const replacement = await client.register(sessionMeta);
              sessionId = replacement.session_id;
              consecutiveFailures = 0;
              backoffStart = null;
              log.info('Session re-registered', { event: 'slot_reregistered', sessionId, status: replacement.status });
              continue;
            } catch {
              log.error('Session re-registration failed');
            }
          }
          if (consecutiveFailures >= maxFailures) {
            running = false;
            log.error('Poll failure circuit opened', { consecutiveFailures, maxFailures });
            throw new Error('Poll failure circuit opened', { cause: error });
          }
          await delay(backoff);
        }
      }
      log.info('Runner stopped');
    },
    shutdown() {
      shutdownPromise = shutdownPromise ?? doShutdown();
      return shutdownPromise;
    },
    get sessionId() {
      return sessionId;
    },
    get consecutivePollFailures() {
      return consecutiveFailures;
    },
    get cleanupFailed() {
      return cleanupFailed;
    },
    get activeWork() {
      return activeState?.work ?? null;
    },
  };
}
