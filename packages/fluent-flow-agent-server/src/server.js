import { readFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { resolveAcpCommand } from './acp/command.js';
import { createClient as createDefaultClient } from './client.js';
import { createHealthServer as createDefaultHealthServer } from './health-server.js';
import { createLogger } from './logger.js';
import { probeExecutables } from './probe.js';
import { createRunner as createDefaultRunner } from './runner.js';
import { safeError } from './safe-error.js';
import { loadOrCreateState as loadDefaultState, storeRuntimeToken as storeDefaultToken } from './state.js';
import { cleanStaleWorktrees as cleanStaleWorktreesDefault } from './worktree.js';
import { validateChatProfiles } from './chat-profiles.js';
import { createChatWorkspaceManager } from './chat-workspace.js';

const DEFAULT_RESTART_BASE_MS = 2000;
const DEFAULT_RESTART_MAX_MS = 60000;
const SESSION_POLL_MS = 100;

function nonemptyToken(value, source) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${source} did not contain a durable credential.`);
  }
  return value;
}

function errorsFrom(results) {
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

export function createAgentServer(options) {
  const {
    capacity,
    serverUrl,
    provider,
    deployment,
    stateDir,
    workDir,
    tokenFile = null,
    packageVersion,
    healthHost,
    healthPort,
    providerEnvironment = {},
    acpCommand = null,
    acpArgs = [],
    chatProfilesFile,
    restartBaseMs = DEFAULT_RESTART_BASE_MS,
    restartMaxMs = DEFAULT_RESTART_MAX_MS,
    executionTimeoutMs,
    log = createLogger(false),
    loadOrCreateState = loadDefaultState,
    storeRuntimeToken = storeDefaultToken,
    readTokenFile = (path) => readFile(path, 'utf8'),
    probeTools = probeExecutables,
    cleanStaleWorktrees = cleanStaleWorktreesDefault,
    createClient = createDefaultClient,
    createRunner = createDefaultRunner,
    createHealthServer = createDefaultHealthServer,
  } = options;

  let enrollmentCredential = options.enrollmentToken ?? null;
  let instanceId = null;
  let healthServer = null;
  let setupPromise = null;
  let startPromise = null;
  let shutdownPromise = null;
  let shutdownStarted = false;
  let stopRestartWaits;
  const restartWaitsStopped = new Promise((resolve) => {
    stopRestartWaits = resolve;
  });
  const slots = [];

  function slotOnline(slot) {
    const { runner } = slot;
    return !slot.failed && Boolean(runner.sessionId) && !((runner.consecutivePollFailures ?? 0) > 0);
  }

  function getStatus() {
    const online = slots.filter(slotOnline);
    const onlineSlots = online.length;
    let status = 'unhealthy';
    if (onlineSlots === capacity) {
      status = online.some((slot) => slot.runner.cleanupFailed === true) ? 'degraded' : 'healthy';
    } else if (onlineSlots > 0) {
      status = 'degraded';
    }
    return {
      status,
      instance_id: instanceId,
      provider,
      capacity,
      active: online.filter((slot) => slot.runner.activeWork).length,
      online_slots: onlineSlots,
    };
  }

  async function resolveDurableToken(state) {
    if (tokenFile !== null) {
      const contents = await readTokenFile(tokenFile);
      const token = String(contents).trimEnd();
      return nonemptyToken(token, 'Token file');
    }
    if (state.token !== null) return nonemptyToken(state.token, 'Private state');
    if (enrollmentCredential === null) throw new Error('No durable credential or enrollment credential is available.');

    const enrollmentClient = createClient({ serverUrl, token: enrollmentCredential });
    const exchanged = await enrollmentClient.enroll(enrollmentCredential, state.instanceId);
    enrollmentCredential = null;
    const token = nonemptyToken(exchanged, 'Enrollment exchange');
    await storeRuntimeToken(stateDir, state.instanceId, token);
    return token;
  }

  async function waitForRestart(delayMs) {
    let timer;
    try {
      await Promise.race([
        new Promise((resolve) => {
          timer = setTimeout(resolve, delayMs);
        }),
        restartWaitsStopped,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function superviseSlot(slot, slotId) {
    let failures = 0;
    let restarted = false;
    for (;;) {
      const priorSessionId = slot.runner.sessionId;
      const sessionReported = () => {
        const current = slot.runner.sessionId;
        return Boolean(current) && current !== priorSessionId;
      };
      let reported = false;
      let sessionTimer = null;
      const observeSession = () => {
        if (!sessionReported()) return false;
        reported = true;
        slot.failed = false;
        return true;
      };
      const scheduleObservation = () => {
        sessionTimer = setTimeout(() => {
          if (!observeSession()) scheduleObservation();
        }, SESSION_POLL_MS);
      };

      slot.failed = restarted;
      let failure;
      try {
        const run = (async () => slot.runner.start())();
        if (!observeSession()) scheduleObservation();
        await run;
        return;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(sessionTimer);
      }

      if (sessionReported()) reported = true;
      slot.failed = true;
      failures = reported ? 1 : failures + 1;
      const restartInMs = Math.min(restartBaseMs * 2 ** (failures - 1), restartMaxMs);
      const slotFailure = { instanceId, slotId, reason: safeError(failure) };
      if (shutdownStarted) {
        log.error('Agent server slot failed', { event: 'slot_failed', ...slotFailure });
        return;
      }
      log.error('Agent server slot failed', {
        event: 'slot_restart_scheduled',
        ...slotFailure,
        attempt: failures,
        restartInMs,
      });
      await waitForRestart(restartInMs);
      if (shutdownStarted) return;
      restarted = true;
    }
  }

  async function setup() {
    let chat;
    let chatWorkspaceManager;
    if (chatProfilesFile !== undefined) {
      const contents = await readFile(chatProfilesFile);
      if (contents.byteLength > 64 * 1024) throw new Error('Local chat catalog is too large');
      chat = { enabled: true, profiles: validateChatProfiles(JSON.parse(contents.toString('utf8'))) };
      chatWorkspaceManager = createChatWorkspaceManager({ workDir, storageDir: stateDir, environment: providerEnvironment });
      await chatWorkspaceManager.reconcileStartup();
    }
    const adapter = resolveAcpCommand({ agentType: provider, command: acpCommand, args: acpArgs });
    await probeTools({ names: ['git', 'gh', adapter.bin], environment: providerEnvironment });
    await cleanStaleWorktrees({ workDir, environment: providerEnvironment, log });
    const state = await loadOrCreateState(stateDir);
    instanceId = state.instanceId;
    if (shutdownStarted) throw new Error('Agent server shutdown has begun.');
    const durableToken = await resolveDurableToken(state);
    if (shutdownStarted) throw new Error('Agent server shutdown has begun.');
    const client = createClient({ serverUrl, token: durableToken });

    for (let slotId = 0; slotId < capacity; slotId += 1) {
      if (shutdownStarted) throw new Error('Agent server shutdown has begun.');
      const runner = createRunner({
        client,
        log: log.child({ instanceId, slotId }),
        cwd: workDir,
        childEnvironment: providerEnvironment,
        meta: {
          runtime: 'agent-server',
          instance_id: instanceId,
          slot_id: slotId,
          capacity,
          version: packageVersion,
          provider,
          deployment,
          hostname: hostname(),
          os: platform(),
        },
        acpCommand,
        provider,
        acpArgs,
        runnerToken: durableToken,
        ...(chat && { chat, chatWorkspaceManager }),
        ...(executionTimeoutMs !== undefined && { executionTimeoutMs }),
      });
      slots.push({ runner, failed: false, drainPromise: null });
    }

    healthServer = createHealthServer({ getStatus, host: healthHost, port: healthPort, log });
    await healthServer.start();
    if (shutdownStarted) throw new Error('Agent server shutdown has begun.');

    for (let slotId = 0; slotId < slots.length; slotId += 1) {
      const slot = slots[slotId];
      slot.drainPromise = superviseSlot(slot, slotId);
    }
    log.info('Agent server started', {
      event: 'agent_server_started',
      instanceId,
      capacity,
      provider,
      deployment,
      version: packageVersion,
    });
    return slots.map((slot) => slot.drainPromise);
  }

  function start() {
    if (shutdownStarted) return Promise.reject(new Error('Agent server shutdown has begun.'));
    if (startPromise) return startPromise;
    const attempt = setup();
    setupPromise = attempt;
    startPromise = attempt.then((drains) => Promise.all(drains).then(() => undefined));
    attempt.catch(() => {
      if (setupPromise === attempt && slots.length === 0 && healthServer === null && !shutdownStarted) {
        setupPromise = null;
        startPromise = null;
      }
    });
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownStarted = true;
    stopRestartWaits();
    shutdownPromise = (async () => {
      if (setupPromise) await Promise.allSettled([setupPromise]);

      const shutdownTasks = [];
      if (healthServer) shutdownTasks.push(Promise.resolve().then(() => healthServer.stop()));
      for (const slot of slots) {
        shutdownTasks.push(Promise.resolve().then(() => slot.runner.shutdown()));
      }
      const shutdownResults = await Promise.allSettled(shutdownTasks);
      const drains = slots.map((slot) => slot.drainPromise).filter(Boolean);
      const drainResults = await Promise.allSettled(drains);
      const errors = [...errorsFrom(shutdownResults), ...errorsFrom(drainResults)];
      for (const error of errors) {
        log.error('Agent server shutdown error', { reason: safeError(error) });
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Agent server shutdown failed.');
      log.info('Agent server shutdown complete', { event: 'agent_server_shutdown_complete', instanceId });
    })();
    return shutdownPromise;
  }

  return { start, shutdown, getStatus };
}
