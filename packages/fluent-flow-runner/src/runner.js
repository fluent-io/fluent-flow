import { execFile as execFileCb } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { createAcpRuntime as createDefaultAcpRuntime } from './acp/runtime.js';
import { resolveAcpCommand } from './acp/command.js';
import { createAcpStreamRedactor, normalizeAcpUpdate, redactAcpPayload } from './acp/normalize.js';
import { prepareWorktree } from './worktree.js';
import { resolvePrompt } from './prompts.js';

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
    if (!SECRET_ENV_NAME.test(name) || typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 8 || IGNORED_ENV_SECRET_VALUES.has(normalized)) continue;
    if (/^[+-]?(?:0+(?:\.0+)?|1(?:\.0+)?)$/u.test(normalized)) continue;
    values.push(value);
  }
  return values;
}

export function createRunner({
  client,
  log,
  createAcpRuntime = createDefaultAcpRuntime,
  cwd,
  meta,
  maxPollFailures,
  heartbeatIntervalMs,
  acpCommand,
  acpArgs = [],
  commandPollMs = DEFAULT_COMMAND_POLL_MS,
  commandLeaseRenewMs = DEFAULT_COMMAND_LEASE_RENEW_MS,
  eventFlushMs = DEFAULT_EVENT_FLUSH_MS,
  eventBatchSize = DEFAULT_EVENT_BATCH_SIZE,
  agentTextLimitBytes = DEFAULT_AGENT_TEXT_LIMIT_BYTES,
  runnerToken,
  secretValues = [],
  runtimeLimits,
}) {
  let running = false;
  let sessionId = null;
  let activeState = null;
  let shutdownPromise = null;
  let heartbeatTimer = null;
  let heartbeatDead = false;
  let claimPollController = null;
  const maxFailures = maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES;
  const heartbeatMs = heartbeatIntervalMs ?? numFromEnv('FLUENT_FLOW_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
  const leaseRenewMs = Math.max(1, Math.floor(commandLeaseRenewMs));
  const baseCwd = resolvePath(cwd ?? process.cwd());
  const batchSize = Math.max(1, Math.floor(eventBatchSize));
  const textLimit = Math.max(0, Math.floor(agentTextLimitBytes));
  const sessionMeta = meta ?? {
    hostname: hostname(),
    os: platform(),
    ...(cwd && { cwd }),
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
    if (state.reportPromise) return state.reportPromise;
    const finalStatus = state.shuttingDown ? 'failed' : status;
    const finalExtra = state.shuttingDown ? { failure_kind: 'transient' } : extra;
    const finalOptions = state.shuttingDown ? { delays: [1000] } : options;
    state.reportPromise = reportClaimWithRetry(claimPayload(state.work, finalStatus, finalExtra), finalOptions).catch(() => {
      log.error('Failed to report claim');
    });
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



  function stopHeartbeat() {
    heartbeatDead = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(claimId) {
    if (!claimId || !client.heartbeat || heartbeatMs <= 0) return;
    heartbeatDead = false;
    heartbeatTimer = setInterval(async () => {
      if (heartbeatDead || !sessionId) return;
      try {
        await client.heartbeat(sessionId, claimId);
      } catch (error) {
        if (/failed: 410/u.test(error?.message ?? '')) {
          heartbeatDead = true;
          stopHeartbeat();
          log.warn('Claim heartbeat ownership expired', { claimId });
          return;
        }
        log.warn('Claim heartbeat failed', { claimId });
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  async function authenticateClaimGithubToken(githubToken) {
    if (!githubToken) return;
    try {
      await new Promise((resolve, reject) => {
        const child = execFileCb('gh', ['auth', 'login', '--with-token'], { stdio: ['pipe', 'pipe', 'pipe'] }, (error) => {
          if (error) reject(error);
          else resolve();
        });
        child.stdin.write(`${githubToken}\n`);
        child.stdin.end();
      });
      log.info('GitHub CLI claim authentication refreshed');
    } catch {
      log.warn('GitHub CLI claim authentication failed; continuing with existing authentication');
    }
  }

  function createInteractionBridge(state, claimId, runtimeEnvironment) {
    const eventQueue = [];
    const agentText = [];
    let agentTextBytes = 0;
    let sequence = 0;
    let flushTimer = null;
    let flushTail = Promise.resolve();
    const redactionValues = [runnerToken, ...secretValues, state.work.githubToken, ...environmentSecrets(runtimeEnvironment)]
      .filter((value) => typeof value === 'string' && value.length > 0);
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
      log.info('Worktree cleaned up');
    } catch {
      log.warn('Worktree cleanup failed; continuing claim finalization');
    }
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
      commandTransportOptions: null,
      turnTail: null,
      cancelBarrier: null,
      commandStopPromise,
      commandStopResolve,
      commandFailurePromise,
      commandFailureResolve,
      interactionFailurePromise,
      interactionFailureResolve,
      commandFailure: null,
      interactionFailure: null,
      dashboardCancelApplied: false,
      shuttingDown: false,
      reportPromise: null,
    };
    state.commandTransportOptions = { signal: state.commandTransportController.signal };
    activeState = state;
    startHeartbeat(claimId);
    let worktreeCleanup = null;
    let bridge = null;
    let runtimeResult = null;
    let runtimeFailure = null;

    try {
      log.info('Work received', { claimId, attempt: work.attempt });
      await authenticateClaimGithubToken(work.githubToken);

      let prompt;
      let command;
      try {
        const claimType = work.claim_type ?? work.claimType ?? 'review_fix';
        prompt = resolvePrompt({ claimType, work });
        if (!work.agentType) throw new Error('Claim agent type is missing');
        command = resolveAcpCommand({ agentType: work.agentType, command: acpCommand, args: acpArgs });
      } catch {
        log.error('ACP claim setup failed');
        stopHeartbeat();
        await reportState(state, 'failed', { failure_kind: 'transient' });
        return;
      }

      let agentCwd = baseCwd;
      if (work.branch && work.repo) {
        try {
          const prepared = await prepareWorktree({
            workDir: baseCwd,
            repo: work.repo,
            prNumber: work.prNumber ?? work.pr_number,
            attempt: work.attempt,
            branch: work.branch,
          });
          agentCwd = resolvePath(prepared.worktreePath);
          worktreeCleanup = prepared.cleanup;
          log.info('Worktree ready');
        } catch {
          log.error('Worktree preparation failed');
          stopHeartbeat();
          await reportState(state, 'failed', { failure_kind: 'transient' });
          return;
        }
      }

      if (state.shuttingDown) {
        stopHeartbeat();
        await reportState(state, 'failed', { failure_kind: 'transient' }, { delays: [1000] });
        return;
      }

      const runtimeEnvironment = { ...process.env };
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
            ]);
            if (settled.commandFailure) {
              runtimeFailure = runtimeFailure ?? settled.commandFailure;
              break;
            }
            if (settled.interactionFailure) {
              runtimeFailure = runtimeFailure ?? settled.interactionFailure;
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
          if (state.commandFailure || state.interactionFailure || state.shuttingDown) {
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
      stopHeartbeat();

      if (state.shuttingDown || runtimeFailure || state.commandFailure || state.interactionFailure || !runtimeResult) {
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
      bridge?.clearFlushTimer();
      stopHeartbeat();
      await cleanupWorktree(worktreeCleanup);
      if (activeState === state) activeState = null;
    }
  }

  async function ensureGhAuth() {
    if (!process.env.GITHUB_TOKEN) return;
    try {
      await new Promise((resolve, reject) => {
        execFileCb('gh', ['auth', 'status'], { stdio: 'pipe' }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch {
      try {
        await new Promise((resolve, reject) => {
          const child = execFileCb('gh', ['auth', 'login', '--with-token'], { stdio: ['pipe', 'pipe', 'pipe'] }, (error) => {
            if (error) reject(error);
            else resolve();
          });
          child.stdin.write(`${process.env.GITHUB_TOKEN}\n`);
          child.stdin.end();
        });
        log.info('GitHub CLI authentication refreshed');
      } catch {
        log.info('GitHub CLI authentication unavailable; continuing');
      }
    }
  }

  async function doShutdown() {
    log.info('Shutting down');
    running = false;
    claimPollController?.abort();
    stopHeartbeat();
    const state = activeState;
    if (!state) return;
    state.shuttingDown = true;
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
      await ensureGhAuth();
      log.info('Registering session');
      const registration = await client.register(sessionMeta);
      sessionId = registration.session_id;
      log.info('Session registered', { sessionId, status: registration.status });

      let consecutiveFailures = 0;
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
            log.error('Poll watchdog exceeded its retry window', { consecutiveFailures });
            process.exit(1);
          }
          log.error('Poll failed', { consecutiveFailures, maxFailures, nextRetryMs: backoff });
          if (error?.message?.startsWith('Poll failed: 410')) {
            try {
              const replacement = await client.register(sessionMeta);
              sessionId = replacement.session_id;
              consecutiveFailures = 0;
              backoffStart = null;
              log.info('Session re-registered', { sessionId, status: replacement.status });
              continue;
            } catch {
              log.error('Session re-registration failed');
            }
          }
          if (consecutiveFailures >= maxFailures) {
            log.error('Poll failure circuit opened', { consecutiveFailures, maxFailures });
            running = false;
            break;
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
    get activeWork() {
      return activeState?.work ?? null;
    },
  };
}
