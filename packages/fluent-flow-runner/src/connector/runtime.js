import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConnectorConfig, ConnectorConfigError } from './config.js';
import { resolveLocalDaemon } from './paseo-local.js';
import { resolvePaseoCli, createStopAgent } from './paseo-cli.js';
import { buildCatalog, paseoSnapshot, readPaseoProfiles } from './catalog.js';
import { createJournal } from './journal.js';
import { createConnectorClient } from './connector-client.js';
import { createPaseoAdapter } from './paseo-adapter.js';
import { createExecutor, ExecutorError } from './executor.js';
import { createObserver } from './observer.js';
import { createConnectorLoop } from './loop.js';
import { createGitReader } from './workpad.js';
import { createArtifactReader } from './artifacts.js';
import { createNativeWrapup, createWrapup } from './wrapup.js';
import { nativeWorkspaceId } from './uuid-v5.js';
import { createObservationPrivacy } from './observation-privacy.js';
import { createRedactionContext } from './redaction-context.js';
import { createNativeEventPump } from './native-events.js';
import { connectSupervisor } from '../supervisor/client.js';
import { launchSupervisor, OwnerLockHeld, SupervisorUnavailable } from '../supervisor/owner-lock.js';
import { assistantTextOf } from '../supervisor/summary.js';

const NATIVE_BACKENDS = new Set(['claude-code', 'codex']);
const SHUTDOWN_TIMEOUT_MS = 30_000;
const TERMINAL_SESSION_STATES = new Set(['idle', 'failed', 'cancelled']);

async function importPaseoClient() {
  try {
    return await import('@getpaseo/client');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).startsWith("Cannot find package '@getpaseo/client' ")) {
      throw new ConnectorConfigError('paseo_not_installed', { cause: error });
    }
    throw error;
  }
}

export async function connectLocalPaseo(connection) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('The Paseo connector requires Node 22 or newer with native WebSocket support.');
  }
  const { createPaseoClient } = await importPaseoClient();
  const client = createPaseoClient({ url: connection.url, password: connection.password, reconnect: { enabled: true } });
  try { await client.connect(); } catch (error) { await client.close(); throw error; }
  return client;
}

export async function attachOrLaunchSupervisor({ stateDir, instanceId, configFile, connect = connectSupervisor, launch = launchSupervisor }) {
  const attach = () => connect({ instanceId, stateDir, role: 'connector' });
  try {
    return await attach();
  } catch (error) {
    if (!(error instanceof SupervisorUnavailable)) throw error;
  }
  try {
    await launch({ stateDir, instanceId, configFile });
  } catch (error) {
    if (!(error instanceof OwnerLockHeld)) throw error;
  }
  return attach();
}

/**
 * @returns {Promise<{ directory: string } | null>}
 */
export async function workspaceForBinding(binding, { paseo, supervisor }) {
  if (!binding) return null;
  if (NATIVE_BACKENDS.has(binding.backend)) {
    if (!supervisor) return null;
    const { workspaceDir } = await supervisor.request('workspace', { runId: binding.runId });
    return workspaceDir ? { directory: workspaceDir } : null;
  }
  if (!binding.workspaceId || !paseo) return null;
  const workspace = await paseo.workspaces.ref(binding.workspaceId).refresh();
  if (workspace?.id !== binding.workspaceId || workspace.workspaceKind !== 'worktree' || workspace.archivingAt || !workspace.workspaceDirectory) return null;
  return { directory: workspace.workspaceDirectory };
}

export async function createConnectorRuntime({ file, enableIntegrations = [], config: suppliedConfig, journalDir, paseo: suppliedPaseo, supervisor: suppliedSupervisor, stopAgent: suppliedStop, client: suppliedClient, intervals = {}, log = (_obj) => {}, onFatal = (_error) => {} }) {
  const config = suppliedConfig ?? loadConnectorConfig({ file, enableIntegrations });
  const paseoEnabled = config.integrations ? config.integrations.paseo.enabled : true;
  const standalone = (config.profiles ?? []).some((p) => p && typeof p === 'object' && NATIVE_BACKENDS.has(p.backend));
  if (paseoEnabled && !suppliedPaseo) {
    await importPaseoClient();
  }
  const stateDir = journalDir ?? join(dirname(config.file), `connector-${config.instanceId}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const redactionContext = createRedactionContext({ dir: stateDir, secretsFile: config.redactionSecretsFile });
  const journal = createJournal({ dir: stateDir });
  let connection = null;
  let paseo = null;
  if (paseoEnabled) {
    connection = suppliedPaseo && !config.paseo.home ? null : await resolveLocalDaemon({ home: config.paseo.home });
    paseo = suppliedPaseo ?? await connectLocalPaseo(connection);
  }
  let supervisor = null;
  const ownSupervisor = standalone && !suppliedSupervisor;
  try {
    if (standalone) supervisor = suppliedSupervisor ?? await attachOrLaunchSupervisor({ stateDir, instanceId: config.instanceId, configFile: config.file });
  } catch (error) {
    await paseo?.close();
    throw error;
  }
  const privacy = createObservationPrivacy({ sourceRoots: Object.values(config.repositories), paseoHome: connection?.home ?? config.paseo?.home, secrets: [config.token, connection?.password, ...redactionContext.secrets] });
  const closeAll = async () => {
    await paseo?.close();
    if (ownSupervisor) await supervisor?.close();
  };
  try {
    const catalog = await buildCatalog({ config, paseo, supervisor });
    const paseoProfiles = paseo && config.integrations ? await readPaseoProfiles({ config, paseo }) : [];
    const adapter = paseo ? createPaseoAdapter({ paseo, journal, log, privacy }) : null;
    const git = createGitReader();
    const wrapup = paseo ? createWrapup({ paseo, journal, git, log }) : null;
    const nativeWrapup = supervisor ? createNativeWrapup({ supervisor, journal, log }) : null;
    const pendingArchives = new Map();
    const cli = !paseo || suppliedStop ? null : await resolvePaseoCli({ cliPath: config.paseo.cliPath, cacheDir: join(stateDir, 'cli') });
    const stopAgent = !paseo ? null : suppliedStop ?? createStopAgent({ cliCommand: cli.command, home: connection.home });
    let loop;
    const remember = async (observations) => {
      const displayEvents = observations.map(privacy.observation);
      for (const observation of displayEvents) {
        if (!journal.observationById(observation.eventId)) await journal.append({ type: 'observation', ...observation, at: observation.observedAt });
      }
      loop.enqueueObservations(displayEvents);
    };
    const isNative = (binding) => NATIVE_BACKENDS.has(binding?.backend);
    const workspaceDirectory = async (binding) => {
      if (!binding?.repositoryKey || !config.repositories[binding.repositoryKey]) return null;
      const workspace = await workspaceForBinding(binding, { paseo, supervisor });
      if (workspace) privacy.addWorkspace(workspace.directory);
      return workspace?.directory ?? null;
    };
    async function sampleGit(binding) {
      const workspaceKey = isNative(binding) ? binding.workspaceRef : binding.workspaceId;
      async function archivedEvidence() {
        await pendingArchives.get(binding.runId)?.catch(() => {});
        const receipt = journal.workspaceArchive(binding.runId, workspaceKey);
        if (!receipt) return null;
        const eventId = `git_archived:${binding.runId}:${binding.sessionId}:${workspaceKey}`;
        const payload = { headCommit: receipt.git.headCommit, dirty: false, workspaceState: 'archived', historical: true, source: 'owned_workspace_archive', ...(isNative(binding) ? { workspaceRef: workspaceKey } : { workspaceId: workspaceKey }), archivedAt: receipt.archivedAt };
        const observation = { eventId, runId: binding.runId, sessionId: binding.sessionId, observedAt: receipt.archivedAt, kind: 'state', payload };
        if (!journal.observationById(eventId)) await remember([observation]);
        return observation;
      }
      const archived = await archivedEvidence();
      if (archived) return archived;
      let state;
      try {
        const directory = await workspaceDirectory(binding);
        state = directory ? await git.state(directory) : { ok: false };
      } catch { state = { ok: false }; }
      const archivedAfterRead = await archivedEvidence();
      if (archivedAfterRead) return archivedAfterRead;
      const payload = { headCommit: state.ok ? state.headCommit : null, dirty: state.ok ? state.uncommitted + state.untracked > 0 : null };
      const eventId = `git:${binding.sessionId}:${Date.now()}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)}`;
      const observation = { eventId, runId: binding.runId, sessionId: binding.sessionId, observedAt: new Date().toISOString(), kind: 'state', payload };
      await remember([observation]);
      return observation;
    }
    const executor = createExecutor({ config, adapter, native: supervisor, journal,
      catalogProfiles: catalog.formatVersion === 2 ? paseoProfiles.map(paseoSnapshot) : catalog.profiles, paseoProfiles, log, privacy, capabilities: {
      stopAgent,
      rememberReportingCredential: redactionContext.rememberReportingCredential,
      readArtifact: async ({ runId, reference }) => {
        const binding = journal.bindingForRun(runId);
        const directory = await workspaceDirectory(binding);
        if (!directory) return { status: 'unavailable', reason: 'workspace_unavailable' };
        return createArtifactReader({ roots: { workspace: directory }, limits: { maxBytes: 512 * 1024 } }).read({ repositoryKey: 'workspace', reference });
      },
      ...(wrapup || nativeWrapup ? {
        wrapupPreflight: ({ runId }) => {
          if (isNative(journal.bindingForRun(runId))) return nativeWrapup ? nativeWrapup.preflight({ runId }) : Promise.reject(new ExecutorError('preflight_unavailable', 'Wrap-up preflight is not available on this host.'));
          if (!wrapup) throw new ExecutorError('integration_disabled', 'This run requires an integration that is not enabled.');
          return wrapup.preflight({ runId, workspaceId: journal.bindingForRun(runId)?.workspaceId ?? nativeWorkspaceId(runId) });
        },
        wrapupArchive: async (input) => {
          /** @type {{ archive: (input: any) => Promise<any> } | null} */
          const target = isNative(journal.bindingForRun(input.runId)) ? nativeWrapup : wrapup;
          if (!target) throw new ExecutorError(wrapup ? 'wrapup_unavailable' : 'integration_disabled', wrapup ? 'Wrap-up archival is not available on this host.' : 'This run requires an integration that is not enabled.');
          const attempt = Promise.resolve().then(() => target.archive(input));
          pendingArchives.set(input.runId, attempt);
          try { return await attempt; } finally { pendingArchives.delete(input.runId); }
        },
      } : {}),
    } });
    const observer = paseo ? createObserver({ paseo, journal, adapter, log, privacy, onObservations: async (observations) => {
      await remember(observations);
      for (const observation of observations) {
        if (observation.kind === 'state' && TERMINAL_SESSION_STATES.has(observation.payload.state)) {
          const binding = journal.bindingForSession(observation.runId, observation.sessionId);
          if (binding) {
            await sampleGit(binding);
            if (binding.role === 'summary' && observation.payload.state === 'idle') {
              const page = await paseo.agents.ref(binding.paseoAgentId).timeline.refetch({ direction: 'tail', projection: 'canonical' });
              if (page.error || page.gap || page.reset || page.hasOlder || page.hasNewer) throw new Error('Summary history is incomplete.');
              const body = (page.entries ?? []).filter((entry) => entry.item?.type === 'assistant_message').map((entry) => entry.item.text ?? '').join('\n\n');
              if (body.trim()) await remember([{ eventId: `summary:${observation.eventId}`, runId: binding.runId, sessionId: binding.sessionId, observedAt: observation.observedAt, kind: 'summary', payload: { body: body.slice(0, 100_000), model: binding.model, sourceCursor: binding.sourceCursor ?? null } }]);
            }
          }
        }
      }
    } }) : null;
    async function nativeSummary(binding, observation) {
      const texts = journal.observationsForSession(binding.runId, binding.sessionId)
        .filter((o) => o.kind === 'timeline')
        .map((o) => assistantTextOf(o.payload))
        .filter((t) => t !== null);
      const body = texts.join('\n\n');
      if (!body.trim()) return;
      await remember([{ eventId: `summary:${observation.eventId}`, runId: binding.runId, sessionId: binding.sessionId, observedAt: observation.observedAt, kind: 'summary', payload: { body: body.slice(0, 100_000), model: binding.model ?? null, sourceCursor: binding.sourceCursor ?? null } }]);
    }
    const nativePump = supervisor ? createNativeEventPump({ supervisor, log, remember: async (observations) => {
      await remember(observations);
      for (const observation of observations) {
        if (observation.kind === 'state' && TERMINAL_SESSION_STATES.has(observation.payload.state)) {
          const binding = journal.bindingForSession(observation.runId, observation.sessionId);
          if (!binding) continue;
          await sampleGit(binding);
          if (binding.role === 'summary' && observation.payload.state === 'idle') await nativeSummary(binding, observation);
        }
      }
    } }) : null;
    async function reconcile() {
      const bindings = new Map();
      for (const commandId of journal.boundCommandIds()) {
        const binding = journal.byCommand(commandId)?.binding;
        if (binding?.paseoAgentId && paseo) bindings.set(binding.paseoAgentId, binding);
      }
      for (const binding of bindings.values()) await sampleGit(binding);
      await observer?.sync();
    }
    loop = createConnectorLoop({ client: suppliedClient ?? createConnectorClient({ serverUrl: config.serverUrl, token: config.token }), executor, journal, catalog, instanceId: config.instanceId, sdkVersion: '0.12.0', daemonVersion: 'unknown',
      capabilities: { timeline: true, permissions: true, cancel: true, artifacts: true, wrapup: true }, intervals, log, onFatal, privacy,
      onControlPlaneStatus: supervisor ? (online) => supervisor.request('controlPlaneStatus', { online }) : null,
      capacity: supervisor ? {
        reserve: (params) => supervisor.request('reserveSlots', params ?? {}),
        release: ({ grantId, unused, version }) => supervisor.request('releaseSlots', { ...(grantId ? { grantId } : {}), unused, ...(version !== undefined ? { version } : {}) }),
      } : null,
      onBeforeDeliver: async (binding) => {
        const owned = journal.bindingForSession(binding.runId, binding.sessionId);
        if (owned) await sampleGit(owned);
        if (observer && !isNative(owned)) await observer.ensureReady(binding);
      }, onReconcile: reconcile,
    });
    return { loop, journal, executor, observer, catalog, sampleGit, nativePump, supervisor,
      async start() {
        nativePump?.start();
        await loop.start();
      },
      async close({ intentional = false } = {}) {
        loop.stop();
        let stop = null;
        if (intentional && supervisor) {
          try {
            const result = await supervisor.request('stop', { scope: 'all', timeoutMs: SHUTDOWN_TIMEOUT_MS });
            stop = result?.state === 'stopped' ? 'stopped' : 'uncertain';
          } catch (error) {
            log({ msg: 'supervisor stop unconfirmed', error: error instanceof Error ? error.message : String(error) });
            stop = 'uncertain';
          }
        }
        await nativePump?.stop();
        await observer?.close();
        await closeAll();
        return { stop };
      },
    };
  } catch (error) { await closeAll(); throw error; }
}
