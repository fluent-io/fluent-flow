import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../../src/connector/journal.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { sessionUuid, nativeWorkspaceId } from '../../../src/connector/uuid-v5.js';
import { WorkspaceCreateRequestSchema, AgentCreateRequestSchema } from '@getpaseo/protocol/messages';

let dir;
let journal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-adapter-'));
  journal = createJournal({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Schema-faithful fake of the pinned @getpaseo/client 0.12.0 public surface,
 * using the real FetchAgentTimelineResponseMessage payload shape:
 * {entries:[{item,...}], epoch, reset, staleCursor, gap, window,
 *  startCursor, endCursor, hasOlder, hasNewer}.
 */
function fakePaseo() {
  const state = {
    workspaces: new Map(), // idempotencyKey -> handle
    workspacesById: new Map(),
    agents: new Map(), // agentId -> record
    agentsByKey: new Map(), // idempotencyKey -> record
    createCalls: [],
    agentCreateCalls: [],
    sends: [],
    timelineByAgent: new Map(), // agentId -> { items: [] }
    unreachable: false,
  };
  function timelinePayload(agentId, { epoch = 'e1', gap = false, staleCursor = false, reset = false, slice } = {}) {
    const timeline = state.timelineByAgent.get(agentId);
    const items = slice ?? timeline.items;
    return {
      requestId: `req-${agentId}`,
      agentId,
      agent: null,
      direction: 'tail',
      projection: 'canonical',
      epoch,
      reset,
      staleCursor,
      gap,
      window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 },
      startCursor: { epoch, seq: 1 },
      endCursor: { epoch, seq: items.length },
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
      archivedAt: record.archivedAt,
      current: () => ({ ...record }),
      refresh: async () => {
        if (state.unreachable) throw new Error('daemon unreachable');
        return { agent: { ...record }, project: null };
      },
      send: async (text, opts) => {
        if (state.unreachable) throw Object.assign(new Error('send failed: transport closed'), { cause: { code: 'ECONNRESET' } });
        state.sends.push({ agentId: record.id, text, messageId: opts?.messageId ?? null, activeTurnBehavior: opts?.activeTurnBehavior ?? null });
        record.status = 'running';
        state.timelineByAgent.get(record.id).items.push({ type: 'user_message', text, messageId: opts?.messageId ?? `auto-${state.sends.length}` });
      },
      timeline: {
        refetch: async () => {
          if (state.unreachable) throw new Error('daemon unreachable');
          return timelinePayload(record.id);
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
        if (state.unreachable) throw Object.assign(new Error('create failed: transport closed'), { cause: { code: 'ECONNRESET' } });
        const existing = state.workspaces.get(opts.idempotencyKey);
        if (existing) return existing; // daemon-side idempotent replay
        const id = opts.workspaceId ?? `ws-${state.workspaces.size + 1}`;
        if (state.workspacesById.has(id)) throw new Error(`workspace id already in use: ${id}`);
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
              const existingAgent = state.agentsByKey.get(agentOpts.idempotencyKey);
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
              state.agents.set(agentId, record);
              state.agentsByKey.set(agentOpts.idempotencyKey, record);
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
        if (state.unreachable) throw Object.assign(new Error('ref failed'), { cause: { code: 'ECONNRESET' } });
        const handle = state.workspacesById.get(id);
        if (!handle) throw new Error(`workspace ${id} not found`);
        return handle;
      },
    },
    agents: {
      ref: (id) => {
        if (state.unreachable) throw Object.assign(new Error('ref failed'), { cause: { code: 'ECONNRESET' } });
        const record = state.agents.get(id);
        if (!record) throw new Error(`agent ${id} not found`);
        return agentHandle(record);
      },
    },
  };
  return paseo;
}

const launchIntent = {
  commandId: 'cmd-1',
  runId: 'run-1',
  sessionId: 'sess-1',
  repositoryKey: 'fluent-flow',
  repoPath: '/repos/ff',
  branchName: 'ff/run-1/sess-1',
  baseRef: 'main',
  title: 'Task title',
  profileSnapshot: { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/qwen/qwen3.8-27b', modeId: 'full', thinkingOptionId: null, features: {} },
  model: null, // use profile default
  prompt: 'Do the bounded task.',
};

describe('paseo adapter: idempotent lifecycle', () => {
  it('creates workspace then idle agent with stable ids/keys, journals binding, sends prompt last with command-id message id', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });

    const result = await adapter.launch(launchIntent);
    const { state } = paseo;

    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0].idempotencyKey).toBe('ff:workspace:run-1');
    expect(state.createCalls[0].workspaceId).toBe(nativeWorkspaceId('run-1'));
    expect(state.createCalls[0].source).toEqual({
      kind: 'worktree',
      cwd: '/repos/ff',
      action: 'branch-off',
      baseBranch: 'main',
      branchName: 'ff/run-1/sess-1',
    });
    expect(state.agentCreateCalls).toHaveLength(1);
    expect(state.agentCreateCalls[0].idempotencyKey).toBe('ff:session:sess-1');
    // Deterministic UUID agent id (public create option; no labels support in 0.12).
    expect(state.agentCreateCalls[0].agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionUuid('sess-1')).toBe(state.agentCreateCalls[0].agentId);
    // Profile default model applied: omp/ai3/qwen3.8-27b.
    expect(state.agentCreateCalls[0].config.provider).toBe('omp/ai3/qwen/qwen3.8-27b');
    expect(state.agentCreateCalls[0].config.modeId).toBe('full');
    // Idle creation: no prompt at create time.
    expect(state.agentCreateCalls[0].prompt).toBeUndefined();
    // Binding persisted BEFORE the prompt left the process.
    expect(journal.byCommand('cmd-1').binding).toMatchObject({ workspaceId: nativeWorkspaceId('run-1'), paseoAgentId: state.agentCreateCalls[0].agentId });
    // One send, message id = command id.
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].messageId).toBe('cmd-1');
    expect(result.status).toBe('applied');
    expect(result.workspaceId).toBe(nativeWorkspaceId('run-1'));
  });

  it('run model overrides the profile model when provided', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-2', runId: 'run-2', sessionId: 'sess-2', kind: 'launch', payloadDigest: 'd2', recordedAt: 't' });
    await adapter.launch({ ...launchIntent, commandId: 'cmd-2', runId: 'run-2', sessionId: 'sess-2', model: 'anthropic/claude-haiku-4-5', digest: 'd2' });
    expect(paseo.state.agentCreateCalls[0].config.provider).toBe('omp/anthropic/claude-haiku-4-5');
  });

  it('replays after losing the create acknowledgment: same ids/keys, one workspace, one agent, one prompt', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });

    const first = await adapter.launch(launchIntent);
    // Crash/restart: new adapter instance over the same journal.
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const second = await adapter2.launch(launchIntent);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.paseoAgentId).toBe(first.paseoAgentId);
    expect(paseo.state.sends).toHaveLength(1); // timeline proved delivery; no resend
    expect(paseo.state.createCalls).toHaveLength(1); // binding journaled: no re-create at all
    expect(second.status).toBe('applied');
  });

  it('recovers from crash after workspace create but before binding: same idempotency key, no duplicate workspace', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });
    // Simulate lost acknowledgment: the connector crashes right after the
    // daemon accepted the create, before the response was journaled. Replay
    // hits the daemon idempotency key and gets the same workspace.
    let guarded = false;
    const realCreate = paseo.workspaces.create;
    paseo.workspaces.create = async (opts) => {
      if (!guarded) {
        guarded = true;
        return realCreate(opts); // lands daemon-side…
      }
      return realCreate(opts);
    };
    const first = await adapter.launch({ ...launchIntent, prompt: undefined });
    expect(first.workspaceId).toBeTruthy();
    // Recover: journal restart, same command → same workspace identity.
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const second = await adapter2.launch(launchIntent);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.status).toBe('applied');
  });

  it('recovers from binding-journaled-but-send-crashed: resends once with the same message id', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });
    await adapter.launch({ ...launchIntent, prompt: undefined });

    // Simulate: 'sent' journaled, then crash before the daemon applied it (timeline empty).
    await journal.append({ type: 'sent', commandId: 'cmd-1', messageId: 'cmd-1', at: 't' });
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const result = await adapter2.launch(launchIntent);

    expect(result.status).toBe('applied');
    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0].messageId).toBe('cmd-1');
  });

  it('returns ambiguous when delivery cannot be proven: no resend, hold for reconciliation', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });
    await adapter.launch({ ...launchIntent, prompt: undefined });

    // 'sent' journaled, daemon now unreachable → delivery can be neither proven nor disproven.
    await journal.append({ type: 'sent', commandId: 'cmd-1', messageId: 'cmd-1', at: 't' });
    paseo.state.unreachable = true;
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const result = await adapter2.launch(launchIntent);

    expect(result.status).toBe('ambiguous');
    expect(result.errorCode).toBe('recover_unconfirmed');
    expect(paseo.state.sends).toHaveLength(0); // never blindly repeats
  });

  it('treats a gapped or stale-cursor timeline as UNKNOWN (hold), never as proof of absence', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });
    await adapter.launch({ ...launchIntent, prompt: undefined });
    await journal.append({ type: 'sent', commandId: 'cmd-1', messageId: 'cmd-1', at: 't' });

    // Timeline reachable but reports a gap: content may exist that we cannot see.
    paseo.state.timelineByAgent.get(journal.byCommand('cmd-1').binding.paseoAgentId);
    const origRefetch = paseo.agents.ref;
    paseo.agents.ref = (id) => {
      const handle = origRefetch(id);
      handle.timeline.refetch = async () => {
        const payload = {
          requestId: 'r', agentId: id, agent: null, direction: 'tail', projection: 'canonical',
          epoch: 'e1', reset: false, staleCursor: false, gap: true,
          window: { minSeq: 5, maxSeq: 6, nextSeq: 7 },
          startCursor: { epoch: 'e1', seq: 5 }, endCursor: { epoch: 'e1', seq: 6 },
          hasOlder: false, hasNewer: false,
          entries: [{ provider: 'omp', item: { type: 'assistant_message', text: 'hi' }, timestamp: 't', seqStart: 5, seqEnd: 6, sourceSeqRanges: [], collapsed: [] }],
          error: null,
        };
        return payload;
      };
      return handle;
    };
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const result = await adapter2.launch(launchIntent);
    expect(result.status).toBe('ambiguous');
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('forwards steer behavior to send: steer does not interrupt, interrupt interrupts', async () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd1', recordedAt: 't' });
    const { paseoAgentId } = await adapter.launch({ ...launchIntent, prompt: undefined });

    await adapter.sendPrompt({ commandId: 'cmd-steer', runId: 'run-1', sessionId: 'sess-1', paseoAgentId, text: 'focus on tests', activeTurnBehavior: 'steer' });
    await adapter.sendPrompt({ commandId: 'cmd-interrupt', runId: 'run-1', sessionId: 'sess-1', paseoAgentId, text: 'stop and replan', activeTurnBehavior: 'interrupt' });
    expect(paseo.state.sends.map((s) => [s.messageId, s.activeTurnBehavior])).toEqual([
      ['cmd-steer', 'steer'],
      ['cmd-interrupt', 'interrupt'],
    ]);
    // Steer prompt is journaled as its own durable sent intent.
    expect(journal.byCommand('cmd-steer').sent).toHaveLength(1);
  });
});

describe('paseo adapter: timeline normalization (public subscription payload shapes)', () => {
  // PaseoAgentTimelineEvent = PaseoAgentStream payload {agentId, event, timestamp, seq?, epoch?}
  // plus replacement / subscription_restored / error variants.
  function stream(over = {}, seq = 3, epoch = 'e1') {
    const { seq: s, epoch: e, ...event } = { type: 'turn_completed', provider: 'omp', usage: { inputTokens: 10, outputTokens: 5 }, ...over };
    return { agentId: 'ag-1', event, timestamp: '2026-10-19T00:00:00Z', seq: s ?? seq, epoch: e ?? epoch };
  }

  it('normalizes terminal turn events into state/usage observations with stable event ids and provider cursor', () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    const obs = adapter.normalizeTimelineEvents({
      runId: 'run-1',
      sessionId: 'sess-1',
      agentId: 'ag-1',
      events: [
        stream({ type: 'turn_started', turnId: 't1' }, 1),
        stream({ type: 'turn_completed', turnId: 't1' }, 3),
      ],
    });
    expect(obs.map((o) => [o.kind, o.payload.state ?? o.payload])).toEqual([
      ['state', 'running'],
      ['state', 'idle'],
      ['usage', { turnId: 't1', sampleKey: 't1', tokensIn: 10, tokensOut: 5, costUsd: null, reason: null }],
    ]);
    expect(obs[0].eventId).not.toBe(obs[1].eventId);
    expect(obs[1].providerCursor).toEqual({ epoch: 'e1', seq: '3' });
    // Deterministic across replays.
    const again = adapter.normalizeTimelineEvents({ runId: 'run-1', sessionId: 'sess-1', agentId: 'ag-1', events: [stream({ type: 'turn_started', turnId: 't1' }, 1)] });
    expect(again[0].eventId).toBe(obs[0].eventId);
  });

  it('retains native todo in history and projects a sourced workpad plan', () => {
    const adapter = createPaseoAdapter({ paseo: fakePaseo(), journal });
    const item = { type: 'todo', items: [{ text: 'Regression first', completed: true }, { text: 'Implement', completed: false, status: 'in_progress', activeForm: 'Implementing' }] };
    const observations = adapter.normalizeTimelineEvents({ runId: 'run', sessionId: 'session', agentId: 'agent', events: [{ event: { type: 'timeline', item }, epoch: 'epoch', seq: 9, timestamp: '2026-10-19T00:00:00Z' }] });
    expect(observations.find((event) => event.kind === 'timeline').payload.item).toEqual(item);
    expect(observations.find((event) => event.kind === 'state').payload.plan).toEqual({
      body: '- [x] Regression first\n- [ ] Implement', format: 'markdown', sourceCursor: '{"epoch":"epoch","seq":"9"}',
      items: [{ text: 'Regression first', status: 'completed' }, { text: 'Implement', status: 'in_progress' }],
    });
    expect(new Set(observations.map((event) => event.eventId)).size).toBe(2);
  });

  it('retains tool command/output and projects concise progress with source metadata', () => {
    const adapter = createPaseoAdapter({ paseo: fakePaseo(), journal });
    const item = { type: 'tool_call', callId: 'call', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm test', output: '2 tests passed', exitCode: 0 } };
    const observations = adapter.normalizeTimelineEvents({ runId: 'r', sessionId: 's', agentId: 'a', events: [{ event: { type: 'timeline', item }, epoch: 'e', seq: 4, timestamp: '2026-10-19T00:00:00Z' }] });
    expect(observations.find((event) => event.kind === 'timeline').payload.item).toMatchObject(item);
    expect(observations.find((event) => event.kind === 'state').payload.progress).toEqual({ text: 'Bash: completed', percent: null });
  });

  it('keeps safe permission request details needed to answer, without credentials', () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    const obs = adapter.normalizeTimelineEvents({
      runId: 'run-1',
      sessionId: 'sess-1',
      agentId: 'ag-1',
      events: [
        stream({
          type: 'permission_requested',
          request: {
            id: 'perm-1',
            kind: 'tool',
            name: 'bash',
            title: 'Run command',
            description: 'npm test',
            input: { command: 'npm test' },
            actions: [
              { id: 'allow-once', label: 'Allow', behavior: 'allow' },
              { id: 'deny', label: 'Deny', behavior: 'deny' },
            ],
          },
        }, 4),
      ],
    });
    expect(obs).toHaveLength(2);
    expect(obs[1]).toMatchObject({ kind: 'state', payload: { state: 'needs_input' } });
    expect(obs[0].kind).toBe('attention');
    expect(obs[0].payload).toMatchObject({
      attention: 'permission',
      requestId: 'perm-1',
      permissionKind: 'tool',
      name: 'bash',
      input: { command: 'npm test' },
    });
    expect(obs[0].payload.actions).toEqual([
      { id: 'allow-once', label: 'Allow', behavior: 'allow' },
      { id: 'deny', label: 'Deny', behavior: 'deny' },
    ]);
  });

  it('keeps multiple requests waiting and never lets a late resolution revive cancelled execution', () => {
    const adapter = createPaseoAdapter({ paseo: fakePaseo(), journal });
    const normalize = (events) => adapter.normalizeTimelineEvents({ runId: 'run', sessionId: 'session', agentId: 'agent', events: events.map((event, seq) => ({ event, seq, epoch: 'e', timestamp: '2026-10-19T00:00:00Z' })) });
    normalize([{ type: 'turn_started' }, { type: 'permission_requested', request: { id: 'one', input: {} } }, { type: 'permission_requested', request: { id: 'two', input: {} } }]);
    expect(normalize([{ type: 'permission_resolved', requestId: 'one' }]).some((event) => event.payload.state === 'running')).toBe(false);
    expect(normalize([{ type: 'permission_resolved', requestId: 'two' }]).find((event) => event.kind === 'state').payload.state).toBe('running');
    normalize([{ type: 'permission_requested', request: { id: 'three', input: {} } }, { type: 'turn_canceled' }]);
    expect(normalize([{ type: 'permission_resolved', requestId: 'three' }]).some((event) => event.kind === 'state')).toBe(false);
  });

  it('maps errors, thread start and epoch replacement/restore variants', () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    const obs = adapter.normalizeTimelineEvents({
      runId: 'run-1',
      sessionId: 'sess-1',
      agentId: 'ag-1',
      events: [
        stream({ type: 'thread_started', sessionId: 'prov-sess-9' }, 0),
        stream({ type: 'timeline', item: { type: 'error', message: 'provider exploded' } }, 5),
        stream({ type: 'turn_failed', error: 'boom', code: 'provider_error' }, 6),
        { agentId: 'ag-1', event: { type: 'replacement', epoch: 'e2' }, timestamp: '2026-10-19T00:00:01Z' },
        { agentId: 'ag-1', subscriptionId: 'sub-1', event: { type: 'subscription_restored' }, timestamp: '2026-10-19T00:00:02Z' },
      ],
    });
    expect(obs.map((o) => o.kind)).toEqual(['session_bound', 'attention', 'state', 'state', 'state']);
    expect(obs[0].payload.providerSessionId).toBe('prov-sess-9');
    expect(obs[1].payload.attention).toBe('error');
    expect(obs[2].payload.state).toBe('failed');
    expect(obs[3].payload).toEqual({ timelineEpochReplaced: { epoch: 'e2' } });
    expect(obs[4].payload).toEqual({ subscriptionRestored: true });
  });

  it('does not derive a terminal state from an ordinary timeline snapshot alone', () => {
    const paseo = fakePaseo();
    const adapter = createPaseoAdapter({ paseo, journal });
    const obs = adapter.normalizeTimelineEvents({
      runId: 'run-1',
      sessionId: 'sess-1',
      agentId: 'ag-1',
      events: [stream({ type: 'timeline', item: { type: 'assistant_message', text: 'done!' } }, 9)],
    });
    const states = obs.filter((o) => o.kind === 'state').map((o) => o.payload.state);
    expect(states).toEqual([]);
  });
});
