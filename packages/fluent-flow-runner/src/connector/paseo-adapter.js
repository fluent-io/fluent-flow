import { createHash } from 'node:crypto';
import { sessionUuid, nativeWorkspaceId } from './uuid-v5.js';

/**
 * Paseo lifecycle adapter over the pinned @getpaseo/client 0.12.0 public API.
 *
 * Duplicate-prevention model (no assumed exactly-once create/send):
 * - Explicit stable ids: workspace `wks_<16 hex of run-key hash>` + idempotencyKey
 *   `ff:workspace:<runId>`; agent `sessionUuid(sessionId)` (UUIDv5) +
 *   idempotencyKey `ff:session:<sessionId>`. Agent labels carry task/run/session
 *   metadata; durable bindings, rather than labels, establish ownership.
 * - Workspace and agent are created IDLE first; the binding is journaled
 *   BEFORE the initial prompt leaves the process.
 * - A prompt's daemon message id is the server command id. A lost send
 *   acknowledgment is repaired against the agent timeline (real
 *   FetchAgentTimelineResponse shape): entries scanned for that message id,
 *   `gap`/`staleCursor`/`reset`/`error` make the answer UNKNOWN (hold), never
 *   "absent". Provably absent → send once with the SAME id. Neither →
 *   `ambiguous` reconciliation hold. Never a blind resend.
 * - A Paseo `idle` snapshot is NOT terminal turn evidence; only timeline
 *   turn_completed/turn_failed/turn_canceled drive run state.
 *
 * @param {object} opts
 * @param {import('@getpaseo/client').PaseoClient} opts.paseo - connected client
 * @param {object} opts.journal - durable journal (createJournal({dir}) result)
 * @param {(obj: object, msg?: string) => void} [opts.log]
 * @param {() => string} [opts.now]
 * @param {ReturnType<typeof import('./observation-privacy.js').createObservationPrivacy>} [opts.privacy]
 */
export function createPaseoAdapter({ paseo, journal, log = () => {}, now = () => new Date().toISOString(), privacy = null }) {
  const nativeStates = new Map();
  const pendingRequests = new Map();
  /**
   * @param {object} p
   * @returns {Promise<{workspaceId: string, reused: boolean}>}
   */
  async function ensureWorkspace({ commandId, runId, sessionId, repoPath, branchName, baseRef, title }) {
    const existing = journal.byCommand(commandId)?.binding;
    if (existing?.workspaceId) {
      const handle = paseo.workspaces.ref(existing.workspaceId);
      const workspace = await handle.refresh();
      privacy?.addWorkspace(workspace?.workspaceDirectory ?? handle.directory);
      return { workspaceId: existing.workspaceId, reused: true };
    }
    const handle = await paseo.workspaces.create({
      workspaceId: nativeWorkspaceId(runId),
      idempotencyKey: workspaceKey(runId),
      title: title ?? `Fluent Flow run ${runId}`,
      source: {
        kind: 'worktree',
        cwd: repoPath,
        action: 'branch-off',
        ...(baseRef ? { baseBranch: baseRef } : {}),
        branchName,
      },
    });
    privacy?.addWorkspace(handle.directory);
    return { workspaceId: handle.id, reused: false };
  }

  /**
   * @param {object} p
   * @returns {Promise<{paseoAgentId: string, reused: boolean}>}
   */
  async function ensureAgent({ commandId, runId, sessionId, workspaceId, profile, model, title, mcpServers, labels }) {
    const binding = journal.byCommand(commandId)?.binding;
    if (binding?.paseoAgentId) {
      const handle = paseo.agents.ref(binding.paseoAgentId);
      await handle.refresh();
      return { paseoAgentId: binding.paseoAgentId, reused: true };
    }
    const effectiveModel = model ?? profile.model ?? null;
    const provider = effectiveModel ? `${profile.provider}/${effectiveModel}` : profile.provider;
    const handle = await paseo.workspaces.ref(workspaceId).agents.create({
      agentId: sessionUuid(sessionId),
      idempotencyKey: sessionKey(sessionId),
      labels: { ...(labels ?? {}), 'fluent-flow.run': runId, 'fluent-flow.session': sessionId },
      config: {
        provider,
        ...(mcpServers ? { mcpServers } : {}),
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        ...(profile.features && Object.keys(profile.features).length ? { featureValues: profile.features } : {}),
      },
      title: title ?? `Fluent Flow session ${sessionId}`,
      // Deliberately no `prompt`: the agent must exist idle and journaled
      // before any billable send.
    });
    return { paseoAgentId: handle.id, reused: false };
  }

  /**
   * Verify whether the prompt with this message id reached the daemon's
   * timeline, paginating the real FetchAgentTimelineResponse payload in BOTH
   * directions: start at the tail, then walk OLDER pages before any absence
   * claim — the initial prompt may sit in history behind a full tail window.
   * Returns 'present' | 'absent' | null (UNKNOWN: gap/stale/reset/error/transport).
   */
  async function verifyPromptDelivered(paseoAgentId, messageId) {
    let handle;
    try {
      handle = paseo.agents.ref(paseoAgentId);
    } catch (err) {
      log({ msg: 'timeline verify unavailable', agentId: paseoAgentId, error: err.message });
      return null;
    }
    const scanPage = async (cursor, direction) => {
      try {
        return await handle.timeline.refetch({ ...(cursor ? { cursor } : {}), direction, projection: 'canonical' });
      } catch (err) {
        log({ msg: 'timeline verify failed', agentId: paseoAgentId, error: err.message });
        return null;
      }
    };
    const pageHasMessage = (payload) =>
      (payload.entries ?? []).some(
        (entry) =>
          entry.item?.type === 'user_message' &&
          (entry.item.messageId === messageId || entry.item.clientMessageId === messageId),
      );

    // Pass 1: from the tail toward newer.
    let cursor;
    let direction = 'tail';
    let sawGap = false;
    for (let page = 0; page < 50; page++) {
      const payload = await scanPage(cursor, direction);
      if (!payload) return null;
      // Response-level problems make history incomplete: UNKNOWN, never absence.
      if (payload.error || payload.gap || payload.staleCursor || payload.reset) {
        log({ msg: 'timeline verify inconclusive', agentId: paseoAgentId, gap: payload.gap, staleCursor: payload.staleCursor, reset: payload.reset, error: payload.error ?? undefined });
        return null;
      }
      if (pageHasMessage(payload)) return 'present';
      if (payload.hasNewer && payload.endCursor) {
        cursor = payload.endCursor;
        direction = 'after';
        continue;
      }
      break;
    }

    // Pass 2: from the oldest cursor we saw toward older history.
    const oldest = await scanPage(undefined, 'before');
    if (!oldest) return null;
    if (oldest.error || oldest.gap || oldest.staleCursor || oldest.reset) {
      log({ msg: 'timeline verify inconclusive (older)', agentId: paseoAgentId, gap: oldest.gap, staleCursor: oldest.staleCursor, reset: oldest.reset, error: oldest.error ?? undefined });
      return null;
    }
    if (pageHasMessage(oldest)) return 'present';
    let olderCursor = oldest.startCursor;
    for (let page = 0; page < 50 && olderCursor; page++) {
      const payload = await scanPage(olderCursor, 'before');
      if (!payload) return null;
      if (payload.error || payload.gap || payload.staleCursor || payload.reset) {
        sawGap = true;
        break;
      }
      if (pageHasMessage(payload)) return 'present';
      if (!payload.hasOlder) break;
      olderCursor = payload.startCursor;
    }
    if (sawGap) {
      log({ msg: 'timeline verify inconclusive (older gap)', agentId: paseoAgentId });
      return null;
    }
    return 'absent';
  }

  /**
   * @param {object} p
   * @returns {Promise<'applied'|'ambiguous'>}
   */
  async function deliverPrompt({ commandId, paseoAgentId, prompt, activeTurnBehavior }) {
    const record = journal.byCommand(commandId);
    const alreadySent = (record?.sent?.length ?? 0) > 0;
    if (alreadySent) {
      const verdict = await verifyPromptDelivered(paseoAgentId, commandId);
      if (verdict === 'present') return 'applied';
      if (verdict === null) return 'ambiguous';
      // Provably absent: the recorded send never landed. Send once with the
      // SAME message id — a daemon-side duplicate would dedupe by id anyway.
    }
    await journal.append({ type: 'sent', commandId, messageId: commandId, at: now() });
    let handle;
    try {
      // ref() outside the guarded send: an unknown/archived agent is a
      // DEFINITE failure, safe to report as terminal.
      handle = paseo.agents.ref(paseoAgentId);
      await handle.refresh();
    } catch (err) {
      if (isAmbiguousError(err)) return 'ambiguous';
      throw err;
    }
    try {
      await handle.send(prompt, { messageId: commandId, ...(activeTurnBehavior ? { activeTurnBehavior } : {}) });
    } catch (err) {
      // The send may or may not have reached the daemon. The 'sent' intent is
      // durable: recovery redelivery verifies the timeline by message id and
      // yields ONE prompt or a reconciliation hold — never a terminal failed
      // state that would invite a duplicate retry of billable work.
      log({ msg: 'prompt send unconfirmed', commandId, agentId: paseoAgentId, error: err.message });
      return 'ambiguous';
    }
    return 'applied';
  }

  return {
    /** Native 0.12 snapshots expose lastUsage even when no retained timeline
     * event carries usage. These are one cumulative sample per agent session,
     * never a fabricated turn or an inferred sum of cached/input counters. */
    normalizeAgentSnapshot({ runId, sessionId, agentId, snapshot }) {
      const native = snapshot?.lastUsage;
      const counter = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const payload = {
        ...normalizeUsage(native, 'native-session-snapshot'),
        source: 'native_snapshot', scope: 'session', cumulative: true,
        cachedInputTokens: counter(native?.cachedInputTokens),
        contextWindowMaxTokens: counter(native?.contextWindowMaxTokens),
        contextWindowUsedTokens: counter(native?.contextWindowUsedTokens),
      };
      const eventId = `usage_snapshot:${createHash('sha256').update(JSON.stringify({ agentId, payload })).digest('hex').slice(0, 32)}`;
      return [{ eventId, runId, sessionId, agentId, observedAt: now(), kind: 'usage', payload }];
    },

    /**
     * Execute a launch intent end to end. The wire-command intent/digest is
     * journaled by the EXECUTOR (single authoritative owner); the adapter
     * assumes it exists. Pass `prompt` only for the deliver stage — the bind
     * stage creates the idle workspace+agent and journals the binding first.
     *
     * Returns {status:'applied'|'ambiguous'|'failed', workspaceId,
     * paseoAgentId, providerSessionId:null, errorCode?}.
     */
    async launch(intent) {
      const { commandId, runId, sessionId, repositoryKey, repoPath, branchName, baseRef, title, profileSnapshot, model, prompt, mcpServers, labels } = intent;
      let workspaceId;
      let paseoAgentId;
      const binding = journal.byCommand(commandId)?.binding;
      try {
        ({ workspaceId } = await ensureWorkspace({ commandId, runId, sessionId, repoPath, branchName, baseRef, title }));
        ({ paseoAgentId } = await ensureAgent({ commandId, runId, sessionId, workspaceId, profile: profileSnapshot, model, title, mcpServers, labels }));
      } catch (err) {
        // With a journaled binding the side effects already exist but cannot be
        // confirmed reachable right now: hold for reconciliation, never relaunch.
        if (binding) {
          return { status: 'ambiguous', workspaceId: binding.workspaceId ?? null, paseoAgentId: binding.paseoAgentId ?? null, providerSessionId: null, errorCode: 'recover_unconfirmed' };
        }
        if (isAmbiguousError(err)) {
          return { status: 'ambiguous', workspaceId: null, paseoAgentId: null, providerSessionId: null, errorCode: 'create_unconfirmed' };
        }
        throw err;
      }
      if (!journal.byCommand(commandId)?.binding) {
        await journal.append({
          type: 'binding',
          commandId,
          runId,
          sessionId,
          workspaceId,
          paseoAgentId,
          providerSessionId: null,
          repositoryKey: repositoryKey ?? null,
        });
      }
      if (prompt) {
        const status = await deliverPrompt({ commandId, paseoAgentId, prompt });
        if (status === 'ambiguous') {
          return { status: 'ambiguous', workspaceId, paseoAgentId, providerSessionId: null, errorCode: 'send_unconfirmed' };
        }
      }
      return { status: 'applied', workspaceId, paseoAgentId, providerSessionId: null };
    },

    /**
     * Send a follow-up/steer/interrupt prompt to an existing journaled session.
     * `activeTurnBehavior` is forwarded verbatim: 'steer' joins the running
     * turn, 'interrupt' replaces it; omitted lets the daemon decide.
     */
    async sendPrompt({ commandId, runId, sessionId, paseoAgentId, text, activeTurnBehavior }) {
      // The wire-command intent is journaled by the executor (single owner).
      const status = await deliverPrompt({ commandId, paseoAgentId, prompt: text, activeTurnBehavior });
      return { status };
    },

    /**
     * Normalize public timeline subscription events (PaseoAgentTimelineEvent:
     * the agent_stream payload object or the replacement/restored/error
     * variants) into protocol observations.
     *
     * @param {{runId: string, sessionId: string, agentId: string, events: Array<object>}} p
     * @returns {Array<{eventId:string, runId:string, sessionId:string, agentId:string, observedAt:string, kind:string, payload:object, providerCursor?:{epoch:string, seq:string}}>}
     */
    normalizeTimelineEvents({ runId, sessionId, agentId, events }) {
      const observations = [];
      for (const payload of events) {
        // Real subscription delivers {agentId, event, timestamp, seq?, epoch?,
        // subscriptionId?} — not an {type:'agent_stream'} envelope.
        const event = payload.event;
        if (!event || typeof event !== 'object') continue;
        const seq = payload.seq !== undefined ? String(payload.seq) : null;
        const epoch = payload.epoch ?? null;
        const base = {
          eventId: timelineEventId(agentId, epoch, seq, event),
          runId,
          sessionId,
          agentId,
          observedAt: payload.timestamp,
          providerCursor: epoch && seq ? { epoch, seq } : undefined,
        };
        const lifecycle = { turn_started: 'running', turn_completed: 'idle', turn_failed: 'failed', turn_canceled: 'cancelled' }[event.type];
        if (lifecycle) nativeStates.set(agentId, lifecycle);
        switch (event.type) {
          case 'thread_started':
            observations.push({ ...base, kind: 'session_bound', payload: { providerSessionId: event.sessionId } });
            break;
          case 'turn_started':
            observations.push({ ...base, kind: 'state', payload: { state: 'running', turnId: event.turnId ?? null } });
            break;
          case 'turn_completed':
            observations.push({ ...base, kind: 'state', payload: { state: 'idle', turnId: event.turnId ?? null } });
            if (event.usage) {
              observations.push({
                ...base,
                eventId: `${base.eventId}:usage`,
                kind: 'usage',
                payload: { turnId: event.turnId ?? null, ...normalizeUsage(event.usage, event.turnId ?? base.eventId) },
              });
            }
            break;
          case 'turn_failed':
            observations.push({ ...base, kind: 'state', payload: { state: 'failed', turnId: event.turnId ?? null, errorCode: event.code ?? 'turn_failed' } });
            break;
          case 'turn_canceled':
            observations.push({ ...base, kind: 'state', payload: { state: 'cancelled', turnId: event.turnId ?? null } });
            break;
          case 'usage_updated':
            observations.push({
              ...base,
              kind: 'usage',
              payload: { turnId: event.turnId ?? null, cumulative: true, ...normalizeUsage(event.usage, event.turnId ?? base.eventId) },
            });
            break;
          case 'permission_requested':
            if (!pendingRequests.has(agentId)) pendingRequests.set(agentId, new Set());
            pendingRequests.get(agentId).add(event.request.id);
            observations.push({
              ...base,
              kind: 'attention',
              payload: {
                attention: 'permission',
                requestId: event.request.id,
                name: event.request.name,
                permissionKind: event.request.kind,
                title: event.request.title ?? null,
                description: event.request.description ?? null,
                // Safe answer affordances for the dashboard; never credentials.
                input: sanitizeJson(event.request.input),
                actions: (event.request.actions ?? []).map((a) => ({ id: a.id, label: a.label, behavior: a.behavior })),
              },
            });
            observations.push({ ...base, eventId: `${base.eventId}:state`, kind: 'state', payload: { state: 'needs_input' } });
            break;
          case 'permission_resolved':
            pendingRequests.get(agentId)?.delete(event.requestId);
            observations.push({
              ...base,
              kind: 'attention',
              payload: { attention: 'permission_resolved', requestId: event.requestId },
            });
            if (!pendingRequests.get(agentId)?.size && ['running', 'idle'].includes(nativeStates.get(agentId))) {
              observations.push({ ...base, eventId: `${base.eventId}:state`, kind: 'state', payload: { state: nativeStates.get(agentId) } });
            }
            break;
          case 'attention_required':
            observations.push({
              ...base,
              kind: 'attention',
              payload: { attention: event.reason },
            });
            break;
          case 'timeline': {
            const item = event.item;
            if (item.type === 'error') {
              observations.push({ ...base, kind: 'attention', payload: { attention: 'error', message: item.message } });
            } else if (item.type === 'todo') {
              const items = (item.items ?? []).map((task) => ({ text: task.text, status: task.status ?? (task.completed ? 'completed' : 'pending') }));
              observations.push({ ...base, kind: 'timeline', payload: { item: sanitizeTimelineItem(item) } });
              observations.push({ ...base, eventId: `${base.eventId}:plan`, kind: 'state', payload: { plan: {
                body: items.map((task) => `- [${task.status === 'completed' ? 'x' : ' '}] ${task.text}`).join('\n'),
                format: 'markdown', items, sourceCursor: base.providerCursor ? JSON.stringify(base.providerCursor) : null,
              } } });
            } else {
              observations.push({ ...base, kind: 'timeline', payload: { item: sanitizeTimelineItem(item) } });
              if (item.type === 'tool_call') observations.push({ ...base, eventId: `${base.eventId}:progress`, kind: 'state', payload: { progress: { text: `${item.name ?? 'Tool'}: ${item.status ?? 'running'}`.slice(0, 1000), percent: null } } });
            }
            break;
          }
          case 'replacement':
            // Epoch replacement invalidates the cursor; history is preserved
            // server-side and refetched by the executor's backfill.
            observations.push({ ...base, kind: 'state', payload: { timelineEpochReplaced: { epoch: event.epoch } } });
            break;
          case 'subscription_restored':
            observations.push({ ...base, kind: 'state', payload: { subscriptionRestored: true } });
            break;
          case 'error':
            observations.push({ ...base, kind: 'state', payload: { timelineError: event.error } });
            break;
          default:
            break;
        }
      }
      return observations;
    },

    /**
     * Create an additional session (work or summary role) inside an existing
     * journaled run workspace, then deliver its prompt. Reuses the run's
     * workspace binding instead of creating a new one. The wire-command intent
     * is journaled by the executor (single digest owner).
     */
    async createSession({ commandId, runId, sessionId, workspaceId, profile, model, title, prompt, mcpServers, labels, role = 'work', sourceSessionId, sourceCursor }) {
      const { paseoAgentId } = await ensureAgent({ commandId, runId, sessionId, workspaceId, profile, model, title, mcpServers, labels });
      if (!journal.byCommand(commandId)?.binding) {
        await journal.append({
          type: 'binding',
          commandId,
          runId,
          sessionId,
          workspaceId,
          paseoAgentId,
          providerSessionId: null,
          role,
          sourceSessionId: sourceSessionId ?? null,
          sourceCursor: sourceCursor ?? null,
          model: model ?? profile.model ?? null,
          repositoryKey: journal.bindingForRun(runId)?.repositoryKey ?? null,
        });
      }
      if (prompt) {
        const status = await deliverPrompt({ commandId, paseoAgentId, prompt });
        if (status === 'ambiguous') {
          return { status: 'ambiguous', workspaceId, paseoAgentId, providerSessionId: null, errorCode: 'send_unconfirmed' };
        }
      }
      return { status: 'applied', workspaceId, paseoAgentId, providerSessionId: null };
    },

    /** Public handle resolver for control operations (permission answers). */
    resolveAgentHandle(paseoAgentId) {
      return paseo.agents.ref(paseoAgentId);
    },

    /**
     * Cancel via the supported local CLI `paseo stop` (the public agent handle
     * has no cancel method). The connector reconciles the observed
     * turn_canceled event afterwards; this call only requests the interrupt.
     */
    async cancel({ paseoAgentId, stopCommand }) {
      if (!stopCommand) throw new Error('cancel requires the local paseo stop command');
      await stopCommand(paseoAgentId);
      return { requested: true };
    },
  };
}

export function workspaceKey(runId) {
  return `ff:workspace:${runId}`;
}

export function sessionKey(sessionId) {
  return `ff:session:${sessionId}`;
}

function normalizeUsage(usage, sampleKey) {
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const tokensIn = numeric(usage?.inputTokens);
  const tokensOut = numeric(usage?.outputTokens);
  const costUsd = numeric(usage?.totalCostUsd);
  return { sampleKey, tokensIn, tokensOut, costUsd, reason: tokensIn === null && tokensOut === null && costUsd === null ? 'Provider usage unavailable.' : null };
}

function sanitizeTimelineItem(item) {
  // Keep client-normalizable content only; provider internals are dropped.
  const { type, text, message, items, name, level } = item;
  if (type === 'todo') return { type, items };
  if (type === 'tool_call') return { type, callId: item.callId, name: item.name, status: item.status, error: item.error ? 'Tool execution failed.' : null, detail: sanitizeJson(item.detail) };
  if (type === 'assistant_message' || type === 'user_message' || type === 'reasoning') return { type, text };
  if (type === 'notification' || type === 'error') return { type, message: message ?? text ?? null, level };
  return { type, name: name ?? null };
}

/**
 * Bounded JSON-safe copy of permission input metadata: depth/breadth/length
 * caps, credential-named fields stripped, everything else preserved so the
 * dashboard can render the request and answer it.
 */
const MAX_INPUT_DEPTH = 6;
const MAX_KEYS_PER_OBJECT = 50;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_CHARS = 8_000;
const CREDENTIAL_KEY_RE = /api[-_]?key|token|secret|password|credential|authorization|cookie/i;

function sanitizeJson(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > MAX_INPUT_DEPTH) return { truncated: 'depth' };
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    let dropped = 0;
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS_PER_OBJECT)) {
      if (CREDENTIAL_KEY_RE.test(key)) continue;
      out[key] = sanitizeJson(item, depth + 1);
    }
    dropped = Math.max(0, Object.keys(value).length - MAX_KEYS_PER_OBJECT);
    if (dropped > 0) out.truncatedKeys = dropped;
    return out;
  }
  return null;
}

function timelineEventId(agentId, epoch, seq, event) {
  return sha256({ agentId, epoch, seq, event }).slice(0, 32);
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isAmbiguousError(err) {
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return false;
}
