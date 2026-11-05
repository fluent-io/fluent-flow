import { createHash } from 'node:crypto';
import { servedPaseoProfileIds } from './config.js';
import { harnessVersionFor, paseoExecutionProfile, paseoSnapshot, profileRevision } from './catalog.js';
import { nativeCursorEpoch } from '../supervisor/summary.js';


const NATIVE_BACKENDS = new Set(['claude-code', 'codex']);
const EXECUTION_BACKENDS = new Set(['claude-code', 'codex', 'paseo']);
const SUPERVISOR_TRANSPORT_ERRORS = new Set(['SupervisorRequestError', 'SupervisorUnavailable', 'SupervisorRefused']);
const RUN_LEVEL_KINDS = new Set(['artifact_read', 'wrapup_preflight', 'wrapup']);
const summaryUnavailable = () => new ExecutorError('summary_unavailable', 'Summary generation is disabled or unavailable.');

export class ExecutorError extends Error {
  /**
   * @param {string} code - stable machine-readable error code for the ack
   * @param {string} message - safe message (no provider/config internals)
   */
  constructor(code, message) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

export function canonicalSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize(value[k])}`).join(',')}}`;
}

export function canonicalDigest(payload) {
  return createHash('sha256').update(canonicalSerialize(payload)).digest('hex');
}

/**
 * @param {object} opts
 * @param {object} opts.config - loaded connector config (allowlists)
 * @param {object} opts.adapter - createPaseoAdapter(...) result
 * @param {object} opts.journal
 * @param {Array<object>} [opts.catalogProfiles] - sanitized local catalog profiles
 * @param {Array<object>} [opts.paseoProfiles] - the local saved Paseo profiles
 * @param {{ request: (method: string, params?: object) => Promise<any> } | null} [opts.native] - supervisor client
 * @param {(obj: object, msg?: string) => void} [opts.log]
 * @param {object} [opts.capabilities] - injected host capabilities
 * @param {(agentId: string) => Promise<void>} [opts.capabilities.stopAgent]
 * @param {Function} [opts.capabilities.readArtifact]
 * @param {Function} [opts.capabilities.wrapupPreflight]
 * @param {Function} [opts.capabilities.wrapupArchive]
 * @param {(credential: string) => void} [opts.capabilities.rememberReportingCredential]
 * @param {ReturnType<typeof import('./observation-privacy.js').createObservationPrivacy>} [opts.privacy]
 */
export function createExecutor({ config, adapter, native = null, journal, catalogProfiles = [], paseoProfiles = [], log = () => {}, capabilities = {}, privacy = null }) {
  function sessionOptions(payload, command) {
    let mcpServers;
    if (payload.reportingCredential !== undefined) {
      if (typeof payload.reportingCredential !== 'string' || !payload.reportingCredential || !config.serverUrl) {
        throw new ExecutorError('reporting_unavailable', 'Session reporting is unavailable.');
      }
      capabilities.rememberReportingCredential?.(payload.reportingCredential);
      privacy?.addSecret(payload.reportingCredential);
      mcpServers = { 'fluent-flow': { type: 'http', url: new URL('/mcp/collab', config.serverUrl).href,
        headers: { Authorization: `Bearer ${payload.reportingCredential}` } } };
    }
    return { mcpServers, sourceSessionId: payload.sourceSessionId, sourceCursor: payload.sourceCursor, role: command.kind === 'summarize' ? 'summary' : 'work', labels: { ...(payload.labels ?? {}), 'fluent-flow.run': command.runId, 'fluent-flow.session': command.sessionId } };
  }

  function resolveProfile(profileId) {
    if (!profileId) return null;
    if (!servedPaseoProfileIds(config).includes(profileId)) {
      throw new ExecutorError('profile_not_allowed', 'Profile is not allowlisted on this host.');
    }
    return profileId;
  }

  function pinProfile(payload) {
    const profileId = payload?.profileId;
    resolveProfile(profileId);
    const local = catalogProfiles.find((p) => p.id === profileId);
    if (!local) {
      throw new ExecutorError('profile_not_allowed', 'Profile is not allowlisted on this host.');
    }
    const snapshot = payload?.profileSnapshot;
    if (snapshot) {
      const pick = (p) => canonicalSerialize({ id: p.id, name: p.name ?? null, provider: p.provider, model: p.model ?? null, modeId: p.modeId ?? null, thinkingOptionId: p.thinkingOptionId ?? null, features: p.features ?? {} });
      if (pick(snapshot) !== pick(local)) {
        throw new ExecutorError('profile_snapshot_mismatch', 'Execution profile does not match the host allowlist.');
      }
    }
    const model = payload?.model ?? null;
    const localModel = local.model ?? null;
    if (model && model !== localModel) {
      throw new ExecutorError('model_not_allowed', 'Model is not the allowlisted model for this profile.');
    }
    return local;
  }

  function resolveRepo(repositoryKey) {
    const repoPath = config.repositories[repositoryKey];
    if (!repoPath) {
      throw new ExecutorError('repository_not_allowed', 'Repository is not allowlisted on this host.');
    }
    return repoPath;
  }

  function boundSession(runId, sessionId, payloadAgentId) {
    const binding = journal.bindingForSession(runId, sessionId);
    if (!binding) {
      throw new ExecutorError('session_not_bound', 'No live session is journaled for this address yet.');
    }
    if (payloadAgentId && payloadAgentId !== binding.paseoAgentId) {
      throw new ExecutorError('session_mismatch', 'The addressed session does not match this run.');
    }
    return binding;
  }

  async function observe(events) {
    const displayEvents = events.map((event) => privacy ? privacy.observation(event) : event);
    for (const event of displayEvents) {
      await journal.append({
        type: 'observation',
        eventId: event.eventId,
        commandId: event.commandId ?? null,
        runId: event.runId,
        sessionId: event.sessionId ?? null,
        kind: event.kind,
        payload: event.payload ?? null,
        at: event.observedAt ?? new Date().toISOString(),
      });
    }
    return displayEvents;
  }

  function intentFor(command) {
    return {
      type: 'intent',
      commandId: command.id,
      runId: command.runId,
      sessionId: command.sessionId,
      kind: command.kind,
      payloadDigest: canonicalDigest({ id: command.id, runId: command.runId, sessionId: command.sessionId, kind: command.kind, payload: command.payload ?? {} }),
      recordedAt: new Date().toISOString(),
    };
  }


  function executionOf(command) {
    if (!command.payload || !Object.hasOwn(command.payload, 'execution')) return undefined;
    const e = command.payload.execution;
    if (!e || typeof e !== 'object' || e.schemaVersion !== 2 || !EXECUTION_BACKENDS.has(e.backend) ||
        typeof e.profileId !== 'string' || e.profileId === '' || typeof e.profileRevision !== 'string' || e.profileRevision === '') {
      throw new ExecutorError('profile_unavailable', 'This execution profile is unavailable. Contact the execution host owner.');
    }
    return e;
  }

  const settingsChanged = () => new ExecutorError('execution_settings_changed', 'Execution settings changed. Ask a project administrator to select an available profile.');

  function verifyNativeRevision(execution) {
    const matches = (config.profiles ?? []).filter((p) => p && typeof p === 'object' && p.id === execution.profileId);
    const local = matches.length === 1 ? matches[0] : null;
    if (!local || local.backend !== execution.backend || local.complete !== true ||
        profileRevision(local, harnessVersionFor(local.backend)) !== execution.profileRevision) {
      log({ msg: 'execution profile revision differs from the frozen command', profileId: execution.profileId, backend: execution.backend });
      throw settingsChanged();
    }
    return local;
  }

  function verifyPaseoRevision(execution) {
    resolveProfile(execution.profileId);
    const matches = paseoProfiles.filter((p) => p?.id === execution.profileId);
    const local = matches.length === 1 ? matches[0] : null;
    if (!local || profileRevision(paseoExecutionProfile(local), harnessVersionFor('paseo')) !== execution.profileRevision) {
      log({ msg: 'execution profile revision differs from the frozen command', profileId: execution.profileId, backend: 'paseo' });
      throw settingsChanged();
    }
    return paseoSnapshot(local);
  }

  function paseoView(command, execution) {
    if (command.kind === 'prompt') {
      verifyPaseoRevision(execution);
      return command;
    }
    if (!['launch', 'create_session', 'summarize'].includes(command.kind)) return command;
    const snapshot = verifyPaseoRevision(execution);
    return { ...command, payload: { ...command.payload, profileSnapshot: snapshot } };
  }

  function nativeBinding(runId, sessionId) {
    const binding = journal.bindingForSession(runId, sessionId);
    return binding && NATIVE_BACKENDS.has(binding.backend) ? binding : null;
  }

  function nativeRunBinding(runId) {
    const binding = journal.bindingForRun(runId);
    return binding && NATIVE_BACKENDS.has(binding.backend) ? binding : null;
  }

  async function supervise(method, params) {
    try {
      return await native.request(method, params);
    } catch (err) {
      if (SUPERVISOR_TRANSPORT_ERRORS.has(err?.name)) {
        log({ msg: 'supervisor request outcome unknown', method, commandId: params.commandId, code: err.code });
        return { state: 'reconciling', errorCode: 'supervisor_unavailable', transport: true };
      }
      throw err;
    }
  }

  function unsuccessful(result) {
    if (result.state === 'deferred') return { state: 'deferred' };
    if (result.state === 'reconciling') return { state: 'ambiguous', errorCode: result.errorCode ?? 'reconciling' };
    if (result.state === 'failed') return { state: 'failed', errorCode: result.errorCode ?? 'startup_failed' };
    return null;
  }

  /**
   * @returns {{ sessionId: string, sourceCursor: { epoch: string, seq: number } }}
   */
  function nativeSummarySource(command, backend) {
    const payload = command.payload ?? {};
    const source = typeof payload.sourceSessionId === 'string' ? nativeBinding(command.runId, payload.sourceSessionId) : null;
    const cursor = payload.sourceCursor;
    const valid = source !== null && source.backend === backend && cursor !== null && typeof cursor === 'object' &&
      cursor.epoch === nativeCursorEpoch(backend) && typeof cursor.seq === 'string' && /^[1-9][0-9]{0,15}$/.test(cursor.seq) && Number.isSafeInteger(Number(cursor.seq));
    if (!valid) {
      log({ msg: 'native summary refused', commandId: command.id, reason: source === null ? 'source_session_not_bound' : 'source_cursor_invalid' });
      throw summaryUnavailable();
    }
    return { sessionId: source.sessionId, sourceCursor: { epoch: cursor.epoch, seq: Number(cursor.seq) } };
  }

  function nativeReporting(payload) {
    if (typeof payload.reportingCredential !== 'string' || !payload.reportingCredential || !config.serverUrl) {
      throw new ExecutorError('reporting_unavailable', 'Session reporting is unavailable.');
    }
    capabilities.rememberReportingCredential?.(payload.reportingCredential);
    privacy?.addSecret(payload.reportingCredential);
    return { url: new URL('/mcp/collab', config.serverUrl).href, credential: payload.reportingCredential };
  }

  function observation(command, kind, payload, eventId) {
    return { eventId, commandId: command.id, runId: command.runId, sessionId: command.sessionId, observedAt: new Date().toISOString(), kind, payload };
  }

  async function operatorClosed(command) {
    return { state: 'applied', result: { cancelRequested: true, closure: 'operator' }, observations: await observe([observation(command, 'state', { state: 'cancelled', closure: 'operator', cancelCommandId: command.id }, `cancelled:${command.id}`)]) };
  }

  async function nativeBound(command, binding) {
    const events = [];
    if (command.kind === 'launch') events.push(observation(command, 'workspace_bound', { workspaceRef: binding.workspaceRef, backend: binding.backend }, `workspace_bound:${command.id}`));
    events.push(observation(command, 'session_bound', { backend: binding.backend, nativeSessionId: binding.nativeSessionId, generation: binding.generation }, `session_bound:${command.id}`));
    return { stage: 'bound', state: 'accepted', result: { workspaceRef: binding.workspaceRef, nativeSessionId: binding.nativeSessionId }, observations: await observe(events) };
  }

  function boundObservations(command, binding) {
    return [
      {
        eventId: `workspace_bound:${command.id}`,
        commandId: command.id,
        runId: command.runId,
        sessionId: command.sessionId,
        observedAt: new Date().toISOString(),
        kind: 'workspace_bound',
        payload: { workspaceId: binding.workspaceId },
      },
      {
        eventId: `session_bound:${command.id}`,
        commandId: command.id,
        runId: command.runId,
        sessionId: command.sessionId,
        observedAt: new Date().toISOString(),
        kind: 'session_bound',
        payload: {
          paseoAgentId: binding.paseoAgentId,
          ...(binding.providerSessionId ? { providerSessionId: binding.providerSessionId } : {}),
          workspaceId: binding.workspaceId,
        },
      },
    ];
  }

  return {
    /**
     * @param {object} command - {id, runId, sessionId, kind, payload}
     * @returns {Promise<{stage?:string, state:string, result?:object, errorCode?:string, observations?:object[]}>}
     */
    async execute(command) {
      const intent = intentFor(command);
      try {
        await journal.append(intent);
      } catch (err) {
        if (/digest/i.test(err.message)) {
          log({ msg: 'command digest mismatch; refusing', commandId: command.id });
          return { state: 'failed', errorCode: 'digest_mismatch' };
        }
        throw err;
      }
      try {
        const execution = executionOf(command);
        if (execution === undefined) {
          const owned = nativeBinding(command.runId, command.sessionId);
          if (owned) return await this.executeNativeControl(command, owned);
          if (command.kind === 'cancel' && NATIVE_BACKENDS.has(command.nativeBackend)) return await this.executeOwnedCancel(command, command.nativeBackend);
          if (nativeRunBinding(command.runId) && (RUN_LEVEL_KINDS.has(command.kind) || command.kind === 'summarize')) return await this.executeNativeRunCommand(command);
          if (!adapter) throw new ExecutorError('integration_disabled', 'This run requires an integration that is not enabled.');
        } else if (execution.backend === 'paseo') {
          if (!adapter) throw new ExecutorError('integration_disabled', 'This run requires an integration that is not enabled.');
          command = paseoView(command, execution);
        } else {
          return await this.executeNative(command, execution, intent.payloadDigest);
        }
        switch (command.kind) {
          case 'launch':
            return await this.executeLaunch(command, intent.payloadDigest);
          case 'create_session':
            return await this.executeCreateSession(command);
          case 'prompt':
            return await this.executePrompt(command);
          case 'permission':
            return await this.executePermission(command);
          case 'cancel':
            return await this.executeCancel(command);
          case 'summarize':
            return await this.executeSummarize(command);
          case 'artifact_read':
            return await this.executeArtifactRead(command);
          case 'wrapup_preflight':
            return await this.executeWrapupPreflight(command);
          case 'wrapup':
            return await this.executeWrapup(command, command.payload ?? {});
          default:
            throw new ExecutorError('unknown_command_kind', 'Command kind is not supported by this connector.');
        }
      } catch (err) {
        if (err instanceof ExecutorError) {
          log({ msg: 'command rejected', commandId: command.id, code: err.code });
          return { state: 'failed', errorCode: err.code };
        }
        throw err;
      }
    },

    async executeLaunch(command, digest) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId } = command;
      let binding = journal.byCommand(commandId)?.binding;
      if (!binding) {
        const repoPath = resolveRepo(payload.repositoryKey);
        pinProfile(payload);
        const result = await adapter.launch({
          ...sessionOptions(payload, command),
          commandId,
          runId,
          sessionId,
          repositoryKey: payload.repositoryKey,
          repoPath,
          branchName: payload.workspace?.branchName,
          baseRef: payload.workspace?.baseRef,
          title: payload.title ?? null,
          profileSnapshot: payload.profileSnapshot,
          model: payload.model ?? null,
          prompt: undefined,
          digest,
        });
        if (result.status === 'ambiguous') {
          return { state: 'ambiguous', errorCode: result.errorCode, result: { workspaceId: result.workspaceId, paseoAgentId: result.paseoAgentId } };
        }
        binding = journal.byCommand(commandId)?.binding;
      } else {
        pinProfile(payload);
      }
      return {
        stage: 'bound',
        state: 'accepted',
        result: { workspaceId: binding.workspaceId, paseoAgentId: binding.paseoAgentId },
        observations: await observe(boundObservations(command, binding)),
      };
    },


    async complete(command) {
      const digest = intentFor(command).payloadDigest;
      const binding = journal.byCommand(command.id)?.binding;
      if (!binding) return { state: 'failed', errorCode: 'run_not_bound' };
      if (NATIVE_BACKENDS.has(binding.backend)) return this.completeNative(command, digest);
      let execution;
      try {
        execution = executionOf(command);
        if (execution?.backend === 'paseo') command = paseoView(command, execution);
      } catch (err) {
        if (err instanceof ExecutorError) return { state: 'failed', errorCode: err.code };
        throw err;
      }
      const payload = command.payload ?? {};
      const prompt = typeof payload.prompt === 'string' && payload.prompt.trim().length > 0
        ? payload.prompt : payload.instructions;
      if (['launch', 'create_session', 'summarize'].includes(command.kind)) {
        if (typeof prompt !== 'string' || prompt.trim().length === 0) {
          return { state: 'failed', errorCode: 'prompt_required' };
        }
        if (prompt.length > 200_000) {
          return { state: 'failed', errorCode: 'prompt_too_large' };
        }
      }
      let result;
      if (command.kind === 'launch') {
        result = await adapter.launch({
          ...sessionOptions(payload, command),
          commandId: command.id,
          runId: command.runId,
          sessionId: command.sessionId,
          repositoryKey: payload.repositoryKey,
          repoPath: config.repositories[payload.repositoryKey] ?? null,
          branchName: payload.workspace?.branchName,
          baseRef: payload.workspace?.baseRef,
          title: payload.title ?? null,
          profileSnapshot: payload.profileSnapshot,
          model: payload.model ?? null,
          prompt,
          digest,
        });
      } else {
        const runBinding = command.kind === 'create_session' ? journal.bindingForRun(command.runId) : binding;
        if (!runBinding) return { state: 'failed', errorCode: 'run_not_bound' };
        result = await adapter.createSession({
          ...sessionOptions(payload, command),
          commandId: command.id,
          runId: command.runId,
          sessionId: command.sessionId,
          workspaceId: runBinding.workspaceId,
          profile: payload.profileSnapshot,
          model: payload.model ?? null,
          title: payload.title ?? null,
          prompt,
        });
      }
      if (result.status === 'ambiguous') {
        return { state: 'ambiguous', errorCode: result.errorCode, result: { workspaceId: result.workspaceId, paseoAgentId: result.paseoAgentId } };
      }
      return { state: 'applied', result: { workspaceId: result.workspaceId, paseoAgentId: result.paseoAgentId } };
    },

    async executeNative(command, execution, digest) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId, kind } = command;
      if (!['launch', 'create_session', 'summarize', 'prompt'].includes(kind)) {
        const owned = nativeBinding(runId, sessionId);
        if (owned) return this.executeNativeControl(command, owned);
        if (RUN_LEVEL_KINDS.has(kind) && nativeRunBinding(runId)) return this.executeNativeRunCommand(command);
        throw new ExecutorError('session_not_bound', 'No live session is journaled for this address yet.');
      }
      if (kind === 'prompt') {
        const owned = nativeBinding(runId, sessionId);
        if (!owned) throw new ExecutorError('session_not_bound', 'No live session is journaled for this address yet.');
        if (owned.backend !== execution.backend) throw settingsChanged();
      }
      const local = verifyNativeRevision(execution);
      if (!native) {
        log({ msg: 'native command refused', commandId, reason: 'supervisor_not_composed' });
        throw new ExecutorError('profile_unavailable', 'This execution profile is unavailable. Contact the execution host owner.');
      }
      const base = { commandId, digest, runId, sessionId, backend: execution.backend, kind, profileId: execution.profileId, profileRevision: execution.profileRevision,
        ...(command.slotGranted === true ? { slotGranted: true } : {}), ...(command.slotHeld === true ? { slotHeld: true } : {}),
        ...(command.slotGranted === true && typeof command.grantId === 'string' ? { grantId: command.grantId } : {}) };
      if (kind === 'prompt') {
        const behavior = payload.behavior ?? payload.activeTurnBehavior;
        if (behavior !== undefined && behavior !== 'steer' && behavior !== 'interrupt') throw new ExecutorError('invalid_behavior', 'Prompt behavior must be steer or interrupt.');
        if (typeof payload.text !== 'string' || payload.text.trim() === '') throw new ExecutorError('prompt_required', 'A prompt is required.');
        if (payload.text.length > 200_000) throw new ExecutorError('prompt_too_large', 'The prompt is too large.');
        const result = await supervise('submit', { ...base, text: payload.text, ...(behavior ? { behavior } : {}), ...(payload.reportingCredential !== undefined ? { reporting: nativeReporting(payload) } : {}) });
        const failed = unsuccessful(result);
        if (failed) return failed;
        return { state: 'applied', result: { messageId: commandId }, observations: await observe([observation(command, 'state', { state: 'running' }, `prompt_dispatched:${commandId}`)]) };
      }

      const existing = journal.byCommand(commandId)?.binding;
      if (existing) return nativeBound(command, existing);
      let repositoryKey;
      if (kind === 'launch') {
        resolveRepo(payload.repositoryKey);
        repositoryKey = payload.repositoryKey;
      } else {
        const runBinding = nativeRunBinding(runId);
        if (!runBinding) throw new ExecutorError('run_not_bound', 'No launched workspace is journaled for this run yet.');
        if (runBinding.backend !== execution.backend) throw settingsChanged();
        repositoryKey = runBinding.repositoryKey;
        resolveRepo(repositoryKey);
      }
      const summarySource = kind === 'summarize' ? nativeSummarySource(command, execution.backend) : null;
      const result = await supervise('submit', {
        ...base,
        repositoryKey,
        ...(kind === 'launch' ? { branchName: payload.workspace?.branchName, baseRef: payload.workspace?.baseRef } : {}),
        role: kind === 'summarize' ? 'summary' : 'work',
        reporting: nativeReporting(payload),
        ...(summarySource ? { summarySource } : {}),
      });
      const failed = unsuccessful(result);
      if (failed) return failed;
      const b = result.binding;
      if (!b || typeof b.nativeSessionId !== 'string' || typeof b.workspaceRef !== 'string' || !Number.isSafeInteger(b.generation)) {
        log({ msg: 'supervisor bind result incomplete', commandId });
        return { state: 'ambiguous', errorCode: 'reconciling' };
      }
      const binding = { type: 'binding', commandId, runId, sessionId, backend: execution.backend, nativeSessionId: b.nativeSessionId, workspaceRef: b.workspaceRef, generation: b.generation, repositoryKey, role: kind === 'summarize' ? 'summary' : 'work',
        model: local.model, ...(kind === 'summarize' ? { sourceCursor: payload.sourceCursor ?? null } : {}) };
      await journal.append(binding);
      return nativeBound(command, binding);
    },

    async completeNative(command, digest) {
      const payload = command.payload ?? {};
      const prompt = typeof payload.prompt === 'string' && payload.prompt.trim().length > 0 ? payload.prompt : payload.instructions;
      if (typeof prompt !== 'string' || prompt.trim().length === 0) return { state: 'failed', errorCode: 'prompt_required' };
      if (prompt.length > 200_000) return { state: 'failed', errorCode: 'prompt_too_large' };
      if (!native) return { state: 'failed', errorCode: 'profile_unavailable' };
      const result = await supervise('deliver', { commandId: command.id, digest, text: prompt });
      const failed = unsuccessful(result);
      if (failed) return failed;
      return { state: 'applied', result: { messageId: command.id }, observations: await observe([observation(command, 'state', { state: 'running' }, `prompt_dispatched:${command.id}`)]) };
    },

    async executeNativeControl(command, binding) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId } = command;
      if (RUN_LEVEL_KINDS.has(command.kind)) return this.executeNativeRunCommand(command);
      if (command.kind !== 'cancel' && command.kind !== 'permission') throw settingsChanged();
      if (!native) throw new ExecutorError('profile_unavailable', 'This execution profile is unavailable. Contact the execution host owner.');
      const base = { commandId, digest: intentFor(command).payloadDigest, runId, sessionId, backend: binding.backend, kind: command.kind };
      if (command.kind === 'permission') {
        if (typeof payload.requestId !== 'string' || payload.requestId === '' || !payload.response || typeof payload.response !== 'object' || Array.isArray(payload.response)) {
          throw new ExecutorError('invalid_response', 'Permission response behavior must be allow or deny.');
        }
        const nativeRequestId = typeof payload.nativeRequestId === 'string' && payload.nativeRequestId !== '' ? payload.nativeRequestId : payload.requestId;
        const identity = {
          ...(Number.isSafeInteger(payload.generation) ? { generation: payload.generation } : {}),
          ...(typeof payload.fingerprint === 'string' ? { fingerprint: payload.fingerprint } : {}),
        };
        const result = await supervise('submit', { ...base, nativeRequestId, ...identity, response: payload.response });
        const failed = unsuccessful(result);
        if (failed) return failed;
        return { state: 'applied', result: { requestId: payload.requestId }, observations: await observe([observation(command, 'attention', { attention: 'permission_resolved', requestId: payload.requestId }, `permission_resolved:${commandId}`)]) };
      }
      const result = await supervise('submit', base);
      const failed = unsuccessful(result);
      if (failed) return failed;
      if (result.closure === 'operator') return operatorClosed(command);
      return { state: 'applied', result: { cancelRequested: true }, observations: await observe([observation(command, 'state', { state: 'cancel_requested', cancelRequested: true }, `cancel_requested:${commandId}`)]) };
    },

    async executeOwnedCancel(command, backend) {
      const { id: commandId, runId, sessionId } = command;
      const result = await supervise('submit', { commandId, digest: intentFor(command).payloadDigest, runId, sessionId, backend, kind: 'cancel' });
      const failed = unsuccessful(result);
      if (failed) return failed;
      if (result.dispatched === false) {
        return { state: 'applied', result: { cancelRequested: true, dispatched: false }, observations: await observe([observation(command, 'state', { state: 'cancelled', dispatched: false, cancelCommandId: commandId }, `cancelled:${commandId}`)]) };
      }
      if (result.closure === 'operator') return operatorClosed(command);
      return { state: 'applied', result: { cancelRequested: true }, observations: await observe([observation(command, 'state', { state: 'cancel_requested', cancelRequested: true }, `cancel_requested:${commandId}`)]) };
    },

    async executeNativeRunCommand(command) {
      switch (command.kind) {
        case 'artifact_read':
          return this.executeArtifactRead(command);
        case 'wrapup_preflight':
          return this.executeWrapupPreflight(command);
        case 'wrapup':
          return this.executeWrapup(command, command.payload ?? {});
        case 'summarize':
          throw new ExecutorError('summary_disabled', 'Summary generation is disabled or unavailable.');
        default:
          throw settingsChanged();
      }
    },

    async executeCreateSession(command) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId } = command;
      pinProfile(payload);
      const runBinding = journal.bindingForRun(runId);
      if (!runBinding) throw new ExecutorError('run_not_bound', 'No launched workspace is journaled for this run yet.');
      const existingBinding = journal.byCommand(commandId)?.binding;
      if (!existingBinding) {
        const result = await adapter.createSession({
          ...sessionOptions(payload, command),
          commandId,
          runId,
          sessionId,
          workspaceId: runBinding.workspaceId,
          profile: payload.profileSnapshot,
          model: payload.model ?? null,
          title: payload.title ?? null,
          prompt: undefined,
        });
        if (result.status === 'ambiguous') return { state: 'ambiguous', errorCode: result.errorCode };
        const binding = journal.byCommand(commandId)?.binding;
        return {
          stage: 'bound',
          state: 'accepted',
          result: { workspaceId: binding.workspaceId, paseoAgentId: binding.paseoAgentId },
          observations: await observe([{
            eventId: `session_bound:${commandId}`,
            commandId,
            runId,
            sessionId,
            observedAt: new Date().toISOString(),
            kind: 'session_bound',
            payload: { paseoAgentId: binding.paseoAgentId, providerSessionId: null, workspaceId: binding.workspaceId },
          }]),
        };
      }
      return {
        stage: 'bound',
        state: 'accepted',
        result: { workspaceId: existingBinding.workspaceId, paseoAgentId: existingBinding.paseoAgentId },
        observations: await observe([{
          eventId: `session_bound:${commandId}`,
          commandId,
          runId,
          sessionId,
          observedAt: new Date().toISOString(),
          kind: 'session_bound',
          payload: { paseoAgentId: existingBinding.paseoAgentId, providerSessionId: null, workspaceId: existingBinding.workspaceId },
        }]),
      };
    },

    async executePrompt(command) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId } = command;
      const binding = boundSession(runId, sessionId, payload.paseoAgentId);
      const behavior = payload.behavior ?? payload.activeTurnBehavior;
      if (behavior !== undefined && behavior !== 'steer' && behavior !== 'interrupt') {
        throw new ExecutorError('invalid_behavior', 'Prompt behavior must be steer or interrupt.');
      }
      const result = await adapter.sendPrompt({
        commandId,
        runId,
        sessionId,
        paseoAgentId: binding.paseoAgentId,
        text: payload.text,
        activeTurnBehavior: behavior,
      });
      if (result.status === 'ambiguous') return { state: 'ambiguous', errorCode: 'send_unconfirmed' };
      return { state: 'applied', result: { messageId: commandId } };
    },

    async executePermission(command) {
      const payload = command.payload ?? {};
      const { id: commandId, runId, sessionId } = command;
      const binding = boundSession(runId, sessionId, payload.paseoAgentId);
      const response = payload.response;
      if (!response || !['allow', 'deny'].includes(response.behavior)) {
        throw new ExecutorError('invalid_response', 'Permission response behavior must be allow or deny.');
      }
      if (response.behavior === 'deny' && (response.updatedInput || response.updatedPermissions || response.answers)) {
        throw new ExecutorError('invalid_response', 'Deny responses cannot carry updated input, permissions or answers.');
      }

      let sdkResponse;
      if (response.behavior === 'allow' && response.answers !== undefined) {
        if (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) {
          throw new ExecutorError('invalid_response', 'Answers must be an object of header to string.');
        }
        const entries = Object.entries(response.answers);
        if (!entries.length || !entries.every(([, v]) => typeof v === 'string')) {
          throw new ExecutorError('invalid_response', 'Answers must map headers to string values.');
        }
        const handle = adapter.resolveAgentHandle(binding.paseoAgentId);
        let current = null;
        try {
          const refetched = await handle.refresh();
          const snapshot = refetched?.agent ?? refetched ?? null;
          current = (snapshot?.pendingPermissions ?? []).find((r) => r?.id === payload.requestId) ?? null;
        } catch (err) {
          log({ msg: 'permission current-request lookup failed', commandId, error: err.message });
          throw new ExecutorError('request_inactive', 'This request is no longer active.');
        }
        if (!current) {
          throw new ExecutorError('request_inactive', 'This request is no longer active.');
        }
        const questions = current.input?.questions;
        if (current.kind !== 'question' || !Array.isArray(questions) || !questions.length ||
            questions.length !== entries.length || new Set(questions.map((q) => q.header)).size !== questions.length) {
          throw new ExecutorError('invalid_response', 'This request does not accept these answers.');
        }
        const display = (value) => privacy ? privacy.redact(value) : value;
        if (new Set(questions.map((question) => display(question.header))).size !== questions.length) {
          throw new ExecutorError('invalid_response', 'This request does not accept these answers.');
        }
        const nativeAnswers = Object.create(null);
        for (const question of questions) {
          let answer = Object.hasOwn(response.answers, question.header) ? response.answers[question.header] : response.answers[display(question.header)];
          if (typeof question.header !== 'string' || typeof question.question !== 'string' || !Array.isArray(question.options) ||
              typeof answer !== 'string' || answer.length > 8_000 || question.options.some((option) => typeof option.label !== 'string')) {
            throw new ExecutorError('invalid_response', 'This request does not accept these answers.');
          }
          const labels = question.options.map((option) => option.label);
          const nativeOption = (selection) => {
            if (labels.includes(selection)) return selection;
            const matches = [...new Set(labels.filter((label) => display(label) === selection))];
            if (matches.length > 1) throw new ExecutorError('invalid_response', 'The answered option is ambiguous.');
            return matches[0] ?? selection;
          };
          answer = nativeOption(answer);
          if (question.multiSelect === true && !labels.includes(answer)) answer = answer.split(', ').map(nativeOption).join(', ');
          const acceptsText = !labels.length || question.allowOther === true || question.isOther === true;
          if ((!answer.trim() && !(question.allowEmpty === true && acceptsText)) ||
              (!acceptsText && !labels.includes(answer) && !(question.multiSelect === true && answer.split(', ').every((value) => labels.includes(value))))) {
            throw new ExecutorError('invalid_response', 'The answered option was not offered.');
          }
          nativeAnswers[question.header] = answer;
        }
        sdkResponse = {
          behavior: 'allow',
          ...(response.selectedActionId ? { selectedActionId: response.selectedActionId } : {}),
          updatedInput: { ...current.input, answers: nativeAnswers },
        };
      } else {
        sdkResponse = {
          behavior: response.behavior,
          ...(response.selectedActionId ? { selectedActionId: response.selectedActionId } : {}),
        };
      }

      const handle = adapter.resolveAgentHandle(binding.paseoAgentId);
      try {
        await handle.respondToPermission({ requestId: payload.requestId, response: sdkResponse });
      } catch (err) {
        log({ msg: 'permission response rejected', commandId, error: err.message });
        throw new ExecutorError('request_inactive', 'This request is no longer active.');
      }
      const observations = [{
        eventId: `permission_resolved:${commandId}`,
        commandId,
        runId,
        sessionId,
        observedAt: new Date().toISOString(),
        kind: 'attention',
        payload: { attention: 'permission_resolved', requestId: payload.requestId },
      }];
      return { state: 'applied', result: { requestId: payload.requestId }, observations: await observe(observations) };
    },

    async executeCancel(command) {
      const binding = boundSession(command.runId, command.sessionId, command.payload?.paseoAgentId);
      if (!capabilities.stopAgent) {
        throw new ExecutorError('cancel_unavailable', 'Local cancel command is not available on this host.');
      }
      await capabilities.stopAgent(binding.paseoAgentId);
      const observations = [{
        eventId: `cancel_requested:${command.id}`,
        commandId: command.id,
        runId: command.runId,
        sessionId: command.sessionId,
        observedAt: new Date().toISOString(),
        kind: 'state',
        payload: { state: 'cancel_requested', cancelRequested: true },
      }];
      return { state: 'applied', result: { cancelRequested: true }, observations: await observe(observations) };
    },

    async executeSummarize(command) {
      const payload = command.payload ?? {};
      if (!payload.profileId || !payload.profileSnapshot) {
        throw new ExecutorError('summary_disabled', 'Summary generation is disabled or unavailable.');
      }
      pinProfile(payload);
      return this.executeCreateSession(command);
    },

    async executeArtifactRead(command) {
      const { id: commandId, runId, sessionId } = command;
      if (!capabilities.readArtifact) {
        throw new ExecutorError('artifact_read_unavailable', 'Artifact reads are not available on this host.');
      }
      const binding = journal.bindingForRun(runId);
      if (!binding?.repositoryKey) {
        throw new ExecutorError('run_not_bound', 'No allowlisted workspace is journaled for this run yet.');
      }
      const result = await capabilities.readArtifact({ ...command.payload, repositoryKey: binding.repositoryKey, runId });
      const observations = [{
        eventId: `artifact:${commandId}`,
        commandId,
        runId,
        sessionId,
        observedAt: new Date().toISOString(),
        kind: 'artifact',
        payload: result,
      }];
      return { state: 'applied', result, observations: await observe(observations) };
    },

    async executeWrapupPreflight(command) {
      const { id: commandId, runId, sessionId } = command;
      if (!capabilities.wrapupPreflight) {
        throw new ExecutorError('preflight_unavailable', 'Wrap-up preflight is not available on this host.');
      }
      const result = await capabilities.wrapupPreflight({ runId: command.runId });
      const observations = [{
        eventId: `wrapup_preflight:${commandId}`,
        commandId,
        runId,
        sessionId,
        observedAt: new Date().toISOString(),
        kind: 'wrapup',
        payload: { phase: 'preflight', ...result },
      }];
      return { state: 'applied', result, observations: await observe(observations) };
    },

    async executeWrapup(command, payload) {
      const { id: commandId, runId, sessionId } = command;
      if (!capabilities.wrapupArchive) {
        throw new ExecutorError('wrapup_unavailable', 'Wrap-up archival is not available on this host.');
      }
      const result = await capabilities.wrapupArchive({ runId, preflightId: payload.preflightId, mode: payload.mode });
      const observations = [{
        eventId: `wrapup:${commandId}`,
        commandId,
        runId,
        sessionId,
        observedAt: new Date().toISOString(),
        kind: 'wrapup',
        payload: { phase: 'archive', ...result },
      }];
      return { state: result.ok ? 'applied' : 'failed', errorCode: result.ok ? undefined : 'wrapup_blocked', result, observations: await observe(observations) };
    },
  };
}
