import { WorkspaceCreateRequestSchema, AgentCreateRequestSchema, FetchAgentTimelineRequestMessageSchema, SendAgentMessageSchema, AgentPermissionResponseSchema } from '@getpaseo/protocol/messages';

/**
 * Shared schema-faithful fake of the pinned @getpaseo/client 0.12.0 public
 * surface for connector tests. Only EXTERNAL daemon I/O is faked; tests use
 * the REAL journal + executor + adapter on top.
 *
 * The fake enforces the REAL response unions: respondToPermission accepts
 * behavior allow|deny ONLY (the wire-level 'answer' must be translated by the
 * executor before it reaches the SDK), and requires a CURRENT pending request.
 */
export function fakePaseoSdk() {
  const state = {
    workspaces: new Map(),
    workspacesById: new Map(),
    agents: new Map(),
    agentsById: new Map(),
    createCalls: [],
    agentCreateCalls: [],
    sends: [],
    timelineByAgent: new Map(),
    permissionResponses: [],
    pendingPermissions: new Map(), // requestId -> AgentPermissionRequest (with input)
    fail: {
      onSend: null,
      onWorkspaceCreate: null,
      unreachable: false,
    },
    customRefetch: null,
    subscribeGates: new Map(), // agentId or '*' -> Promise (ready gate)
    liveHandlers: new Map(), // agentId -> handler
  };
  state.deliverLive = (agentId, payload) => {
    const handler = state.liveHandlers.get(agentId);
    if (handler) handler(payload);
  };

  function timelinePayload(record) {
    const items = state.timelineByAgent.get(record.id)?.items ?? [];
    return {
      requestId: `req-${record.id}`,
      agentId: record.id,
      agent: null,
      direction: 'tail',
      projection: 'canonical',
      epoch: 'e1',
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 },
      startCursor: { epoch: 'e1', seq: 1 },
      endCursor: { epoch: 'e1', seq: items.length },
      hasOlder: false,
      hasNewer: false,
      entries: items.map((item, i) => ({
        provider: 'omp',
        item,
        timestamp: '2026-10-19T00:00:00Z',
        seqStart: i + 1,
        seqEnd: i + 1,
        sourceSeqRanges: [],
        collapsed: [],
      })),
      error: null,
    };
  }

  function agentHandle(record) {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      status: record.status,
      archivedAt: null,
      current: () => ({ ...record }),
      refresh: async () => {
        if (state.fail.unreachable) throw Object.assign(new Error('transport closed'), { cause: { code: 'ECONNRESET' } });
        return { agent: { ...record, pendingPermissions: [...state.pendingPermissions.values()] }, project: null };
      },
      send: async (text, opts) => {
        SendAgentMessageSchema.parse({ type: 'send_agent_message', agentId: record.id, text, ...opts });
        if (state.fail.unreachable) throw Object.assign(new Error('send failed: transport closed'), { cause: { code: 'ECONNRESET' } });
        if (state.fail.onSend) {
          const { error, recordFirst } = state.fail.onSend;
          if (recordFirst) {
            state.sends.push({ agentId: record.id, text, messageId: opts?.messageId ?? null, activeTurnBehavior: opts?.activeTurnBehavior ?? null });
            const timeline = state.timelineByAgent.get(record.id);
            timeline.items.push({ type: 'user_message', text, messageId: opts?.messageId ?? `auto-${state.sends.length}` });
          }
          state.fail.onSend = null;
          throw error;
        }
        state.sends.push({ agentId: record.id, text, messageId: opts?.messageId ?? null, activeTurnBehavior: opts?.activeTurnBehavior ?? null });
        const timeline = state.timelineByAgent.get(record.id);
        timeline.items.push({ type: 'user_message', text, messageId: opts?.messageId ?? `auto-${state.sends.length}` });
      },
      respondToPermission: async (args) => {
        AgentPermissionResponseSchema.parse(args.response);
        // REAL SDK union: allow | deny only; unknown request rejected.
        if (!args.response || !['allow', 'deny'].includes(args.response.behavior)) {
          throw new Error(`Unsupported permission response behavior: ${args.response?.behavior}`);
        }
        if (!state.pendingPermissions.has(args.requestId)) throw new Error('This request is no longer active.');
        state.permissionResponses.push(args);
        state.pendingPermissions.delete(args.requestId);
      },
      timeline: {
        refetch: async (opts) => {
          FetchAgentTimelineRequestMessageSchema.parse({ type: 'fetch_agent_timeline_request', requestId: 'fixture', agentId: record.id, ...opts });
          if (state.fail.unreachable) throw new Error('daemon unreachable');
          if (state.customRefetch) return state.customRefetch(record.id, opts, timelinePayload(record));
          return timelinePayload(record);
        },
        subscribe: (handler) => {
          state.liveHandlers.set(record.id, handler);
          const gate = state.subscribeGates?.get(record.id) ?? state.subscribeGates?.get('*') ?? Promise.resolve();
          return {
            ready: gate,
            subscriptionId: `sub-${record.id}`,
            unsubscribe() {},
            release: async () => {},
          };
        },
      },
      setTitle: async (title) => ({ title }),
    };
  }

  const paseo = {
    state,
    workspaces: {
      create: async (opts) => {
        WorkspaceCreateRequestSchema.parse({ type: 'workspace.create.request', requestId: 'fixture', ...opts });
        state.createCalls.push(opts);
        if (state.fail.onWorkspaceCreate) {
          const err = state.fail.onWorkspaceCreate;
          state.fail.onWorkspaceCreate = null;
          throw err;
        }
        if (state.fail.unreachable) throw Object.assign(new Error('create failed: transport closed'), { cause: { code: 'ECONNRESET' } });
        const existing = state.workspaces.get(opts.idempotencyKey);
        if (existing) return existing;
        const id = opts.workspaceId ?? `ws-${state.workspaces.size + 1}`;
        const handle = {
          id,
          idempotencyKey: opts.idempotencyKey,
          projectId: null,
          directory: `/repo/${id}`,
          name: opts.title ?? null,
          status: { kind: 'ready' },
          agents: {
            create: async (agentOpts) => {
              AgentCreateRequestSchema.shape.agentId.parse(agentOpts.agentId);
              state.agentCreateCalls.push({ workspaceId: id, ...agentOpts });
              const existingAgent = state.agents.get(agentOpts.idempotencyKey);
              if (existingAgent) return agentHandle(existingAgent);
              const agentId = agentOpts.agentId ?? `ag-${state.agents.size + 1}`;
              const record = {
                id: agentId,
                workspaceId: id,
                idempotencyKey: agentOpts.idempotencyKey,
                config: agentOpts.config,
                title: agentOpts.title ?? null,
                status: 'idle',
                archivedAt: null,
              };
              state.agents.set(agentOpts.idempotencyKey, record);
              state.agentsById.set(agentId, record);
              state.timelineByAgent.set(agentId, { items: [] });
              return agentHandle(record);
            },
          },
          refresh: async () => handle,
          archive: async () => ({ requestId: 'r', workspaceId: id, archivedAt: '2026-10-19T00:00:00Z', error: null }),
        };
        state.workspaces.set(opts.idempotencyKey, handle);
        state.workspacesById.set(id, handle);
        return handle;
      },
      ref: (id) => {
        if (state.fail.unreachable) throw Object.assign(new Error('ref failed'), { cause: { code: 'ECONNRESET' } });
        const handle = state.workspacesById.get(id);
        if (!handle) throw new Error(`workspace ${id} not found`);
        return handle;
      },
    },
    agents: {
      ref: (id) => {
        if (state.fail.unreachable) throw Object.assign(new Error('ref failed'), { cause: { code: 'ECONNRESET' } });
        const record = state.agentsById.get(id);
        if (!record) throw new Error(`agent ${id} not found`);
        return agentHandle(record);
      },
    },
  };
  return paseo;
}
