import { createPaseoClient } from '@getpaseo/client';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConnectorConfig } from './config.js';
import { resolveLocalDaemon } from './paseo-local.js';
import { resolvePaseoCli, createStopAgent } from './paseo-cli.js';
import { buildCatalog } from './catalog.js';
import { createJournal } from './journal.js';
import { createConnectorClient } from './connector-client.js';
import { createPaseoAdapter } from './paseo-adapter.js';
import { createExecutor } from './executor.js';
import { createObserver } from './observer.js';
import { createConnectorLoop } from './loop.js';
import { createGitReader } from './workpad.js';
import { createArtifactReader } from './artifacts.js';
import { createWrapup } from './wrapup.js';
import { nativeWorkspaceId } from './uuid-v5.js';
import { createObservationPrivacy } from './observation-privacy.js';
import { createRedactionContext } from './redaction-context.js';

/** The public high-level SDK uses the native WebSocket. The connector has a
 * narrower runtime requirement than the existing Node 20 review runner. */
export async function connectLocalPaseo(connection) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('The Paseo connector requires Node 22 or newer with native WebSocket support.');
  }
  const client = createPaseoClient({ url: connection.url, password: connection.password, reconnect: { enabled: true } });
  try { await client.connect(); } catch (error) { await client.close(); throw error; }
  return client;
}

/** Compose the executable connector. Only the external SDK/CLI boundaries are
 * replaceable for acceptance tests; the journal, protocol and executor remain real. */
export async function createConnectorRuntime({ file, config: suppliedConfig, journalDir, paseo: suppliedPaseo, stopAgent: suppliedStop, client: suppliedClient, intervals = {}, log = (_obj) => {}, onFatal = (_error) => {} }) {
  const config = suppliedConfig ?? loadConnectorConfig({ file });
  const stateDir = journalDir ?? join(dirname(config.file), `connector-${config.instanceId}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const redactionContext = createRedactionContext({ dir: stateDir, secretsFile: config.redactionSecretsFile });
  const journal = createJournal({ dir: stateDir });
  const connection = suppliedPaseo && !config.paseo.home ? null : await resolveLocalDaemon({ home: config.paseo.home });
  const paseo = suppliedPaseo ?? await connectLocalPaseo(connection);
  const privacy = createObservationPrivacy({ sourceRoots: Object.values(config.repositories), paseoHome: connection?.home ?? config.paseo.home, secrets: [config.token, connection?.password, ...redactionContext.secrets] });
  try {
    const catalog = await buildCatalog({ config, paseo });
    const adapter = createPaseoAdapter({ paseo, journal, log, privacy });
    const git = createGitReader();
    const wrapup = createWrapup({ paseo, journal, git, log });
    const pendingArchives = new Map();
    const cli = suppliedStop ? null : await resolvePaseoCli({ cliPath: config.paseo.cliPath, cacheDir: join(stateDir, 'cli') });
    const stopAgent = suppliedStop ?? createStopAgent({ cliCommand: cli.command, home: connection.home });
    let loop;
    const remember = async (observations) => {
      const displayEvents = observations.map(privacy.observation);
      for (const observation of displayEvents) {
        if (!journal.observationById(observation.eventId)) await journal.append({ type: 'observation', ...observation, at: observation.observedAt });
      }
      loop.enqueueObservations(displayEvents);
    };
    const workspaceDirectory = async (binding) => {
      if (!binding?.workspaceId || !binding.repositoryKey || !config.repositories[binding.repositoryKey]) return null;
      const workspace = await paseo.workspaces.ref(binding.workspaceId).refresh();
      if (workspace?.id !== binding.workspaceId || workspace.workspaceKind !== 'worktree' || workspace.archivingAt) return null;
      privacy.addWorkspace(workspace.workspaceDirectory);
      return workspace.workspaceDirectory ?? null;
    };
    async function sampleGit(binding) {
      async function archivedEvidence() {
        // An archive may remove the directory before its native response is
        // delivered. Wait for that attempt's durable receipt or failure.
        await pendingArchives.get(binding.runId)?.catch(() => {});
        const receipt = journal.workspaceArchive(binding.runId, binding.workspaceId);
        if (!receipt) return null;
        const eventId = `git_archived:${binding.runId}:${binding.sessionId}:${binding.workspaceId}`;
        const payload = { headCommit: receipt.git.headCommit, dirty: false, workspaceState: 'archived', historical: true, source: 'owned_workspace_archive', workspaceId: binding.workspaceId, archivedAt: receipt.archivedAt };
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
      } catch { state = { ok: false }; } // Disconnection is unknown, never a clean HEAD.
      // The read can overlap a newly confirmed archive; its receipt supersedes
      // any now-missing/old working directory result.
      const archivedAfterRead = await archivedEvidence();
      if (archivedAfterRead) return archivedAfterRead;
      const payload = { headCommit: state.ok ? state.headCommit : null, dirty: state.ok ? state.uncommitted + state.untracked > 0 : null };
      const eventId = `git:${binding.sessionId}:${Date.now()}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)}`;
      const observation = { eventId, runId: binding.runId, sessionId: binding.sessionId, observedAt: new Date().toISOString(), kind: 'state', payload };
      await remember([observation]);
      return observation;
    }
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: catalog.profiles, log, privacy, capabilities: {
      stopAgent,
      rememberReportingCredential: redactionContext.rememberReportingCredential,
      readArtifact: async ({ runId, reference }) => {
        const binding = journal.bindingForRun(runId);
        const directory = await workspaceDirectory(binding);
        if (!directory) return { status: 'unavailable', reason: 'workspace_unavailable' };
        return createArtifactReader({ roots: { workspace: directory }, limits: { maxBytes: 512 * 1024 } }).read({ repositoryKey: 'workspace', reference });
      },
      wrapupPreflight: ({ runId }) => wrapup.preflight({ runId, workspaceId: journal.bindingForRun(runId)?.workspaceId ?? nativeWorkspaceId(runId) }),
      wrapupArchive: async (input) => {
        const attempt = Promise.resolve().then(() => wrapup.archive(input));
        pendingArchives.set(input.runId, attempt);
        try { return await attempt; } finally { pendingArchives.delete(input.runId); }
      },
    } });
    const observer = createObserver({ paseo, journal, adapter, log, privacy, onObservations: async (observations) => {
      await remember(observations);
      for (const observation of observations) {
        if (observation.kind === 'state' && ['idle', 'failed', 'cancelled'].includes(observation.payload.state)) {
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
    } });
    async function reconcile() {
      const bindings = new Map();
      for (const commandId of journal.boundCommandIds()) {
        const binding = journal.byCommand(commandId)?.binding;
        if (binding?.paseoAgentId) bindings.set(binding.paseoAgentId, binding);
      }
      for (const binding of bindings.values()) await sampleGit(binding);
      await observer.sync();
    }
    loop = createConnectorLoop({ client: suppliedClient ?? createConnectorClient({ serverUrl: config.serverUrl, token: config.token }), executor, journal, catalog, instanceId: config.instanceId, sdkVersion: '0.12.0', daemonVersion: 'unknown',
      capabilities: { timeline: true, permissions: true, cancel: true, artifacts: true, wrapup: true }, intervals, log, onFatal, privacy,
      onBeforeDeliver: async (binding) => {
        const owned = journal.bindingForSession(binding.runId, binding.sessionId);
        if (owned) await sampleGit(owned);
        await observer.ensureReady(binding);
      }, onReconcile: reconcile,
    });
    return { loop, journal, executor, observer, catalog, sampleGit,
      async start() { await loop.start(); },
      async close() { loop.stop(); await observer.close(); await paseo.close(); },
    };
  } catch (error) { await paseo.close(); throw error; }
}
