import { createHash } from 'node:crypto';

/**
 * Command executor: turns control-plane commands into journal-guarded,
 * allowlist-checked Paseo operations and normalized observations.
 *
 * Responsibilities:
 * - SINGLE authoritative intent/digest writer: the wire command's canonical
 *   digest is journaled here and nowhere else (nested keys included), so a
 *   redelivered command with a changed payload can never execute.
 * - Launch is STAGED per contract: bind (idle workspace+agent, journal
 *   binding, `accepted` ack with IDs) happens BEFORE the initial prompt is
 *   sent (`applied` ack).
 * - Prompts/permissions/cancels resolve the EXACT (runId, sessionId) binding;
 *   foreign agent ids in payloads are rejected.
 * - Lost/uncertain prompt sends surface as `ambiguous` (reconciliation),
 *   never terminal failed — a paid run may have started.
 */

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

/** Recursively canonical serialization: sorted keys at every depth. */
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
 *   (exactly what was published at registration). Command profileSnapshots are
 *   pinned against these: a control plane cannot swap provider/mode/model
 *   behind the host's allowlist.
 * @param {(obj: object, msg?: string) => void} [opts.log]
 * @param {object} [opts.capabilities] - injected host capabilities
 * @param {(agentId: string) => Promise<void>} [opts.capabilities.stopAgent]
 * @param {Function} [opts.capabilities.readArtifact]
 * @param {Function} [opts.capabilities.wrapupPreflight]
 * @param {Function} [opts.capabilities.wrapupArchive]
 * @param {(credential: string) => void} [opts.capabilities.rememberReportingCredential]
 * @param {ReturnType<typeof import('./observation-privacy.js').createObservationPrivacy>} [opts.privacy]
 */
export function createExecutor({ config, adapter, journal, catalogProfiles = [], log = () => {}, capabilities = {}, privacy = null }) {
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
    if (!config.profiles.includes(profileId)) {
      throw new ExecutorError('profile_not_allowed', 'Profile is not allowlisted on this host.');
    }
    return profileId;
  }

  /**
   * The command's profile snapshot must EXACTLY match the local allowlisted
   * catalog descriptor, and a run-level model override must equal the
   * snapshot's model: the host only executes its own allowlisted
   * profile+model pairs, whatever a (possibly compromised or buggy) control
   * plane sends.
   */
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
        // Omit null providerSessionId: a partial merge on the server would
        // otherwise wipe the previously bound Paseo id.
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
     * Execute one control-plane command up to its next ack boundary.
     * Launch commands return {stage:'bound', state:'accepted',...} first (IDs
     * persisted/acked before the billable prompt); call complete() for the
     * deliver stage. All other kinds resolve in one call.
     *
     * @param {object} command - {id, runId, sessionId, kind, payload}
     * @returns {Promise<{stage?:string, state:string, result?:object, errorCode?:string, observations?:object[]}>}
     *   state: 'applied' | 'accepted' | 'failed' | 'ambiguous'
     */
    async execute(command) {
      const intent = intentFor(command);
      try {
        await journal.append(intent);
      } catch (err) {
        if (/digest/i.test(err.message)) {
          // Same command id, different payload: refuse to execute.
          log({ msg: 'command digest mismatch; refusing', commandId: command.id });
          return { state: 'failed', errorCode: 'digest_mismatch' };
        }
        throw err;
      }
      try {
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
        // Domain rejections (allowlist, snapshot pinning, session identity,
        // inactive permission requests) are DEFINITE outcomes: terminal
        // failed with a stable code. Uncertain transport failures surface as
        // ambiguous from the adapter, never as failed.
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
        // BIND STAGE: allowlist resolution + idle workspace/agent + journal.
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
        // Redelivery after a bind whose ack never reached the control plane:
        // re-present the SAME journaled IDs for the accepted ack. The prompt
        // is only ever delivered after that ack is CONFIRMED (loop gating).
        pinProfile(payload);
      }
      return {
        stage: 'bound',
        state: 'accepted',
        result: { workspaceId: binding.workspaceId, paseoAgentId: binding.paseoAgentId },
        observations: await observe(boundObservations(command, binding)),
      };
    },

    /**
     * DELIVER STAGE of a bound prompt-bearing command (launch, create_session,
     * summarize): send the initial prompt once, guarded by the journaled
     * `sent` intent. The caller must have a CONFIRMED control-plane
     * acceptance of the bind stage first.
     *
     * LAUNCH GUARD: an initial launch without a real bounded prompt is a
     * failed `prompt_required` — never an applied no-op (a blank Start must
     * still produce exactly one actual task prompt, composed server-side).
     * Additional work and summary sessions require the same bounded prompt.
     */

    async complete(command) {
      const payload = command.payload ?? {};
      const binding = journal.byCommand(command.id)?.binding;
      if (!binding) return { state: 'failed', errorCode: 'run_not_bound' };
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
          digest: intentFor(command).payloadDigest,
        });
      } else {
        // create_session / summarize deliver inside the run's workspace.
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
      // WIRE contract (A3): behavior allow|deny with optional answers
      // (header->string). There is NO 'answer' behavior anywhere: question
      // answers are TRANSLATED into the real SDK union below.
      if (!response || !['allow', 'deny'].includes(response.behavior)) {
        throw new ExecutorError('invalid_response', 'Permission response behavior must be allow or deny.');
      }
      if (response.behavior === 'deny' && (response.updatedInput || response.updatedPermissions || response.answers)) {
        throw new ExecutorError('invalid_response', 'Deny responses cannot carry updated input, permissions or answers.');
      }

      let sdkResponse;
      if (response.behavior === 'allow' && response.answers !== undefined) {
        // Question-kind translation: answers must be an object of
        // header->string and every value must be among the CURRENT request's
        // offered options when it offers exactly one option list.
        if (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) {
          throw new ExecutorError('invalid_response', 'Answers must be an object of header to string.');
        }
        const entries = Object.entries(response.answers);
        if (!entries.length || !entries.every(([, v]) => typeof v === 'string')) {
          throw new ExecutorError('invalid_response', 'Answers must map headers to string values.');
        }
        // CURRENT request authority: the response is only valid for a request
        // that is pending RIGHT NOW on this exact session.
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
          // Resolve only current offered options; never expand arbitrary
          // user text or display placeholders into local paths/credentials.
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
      // Summary settings come from the AUTHORIZED server command/run snapshot
      // (project executionDefaults frozen by the control plane); the connector
      // re-pins the profile against the local allowlist. No snapshot means
      // summaries are disabled/unconfigured for this project.
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
      // The workspace root comes from the JOURNALED run binding — the payload
      // cannot select (or spoof) a root.
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
