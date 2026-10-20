import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { WorkspaceCreateRequestSchema, AgentCreateRequestSchema, SendAgentMessageRequestSchema, FetchAgentTimelineRequestMessageSchema, AgentPermissionResponseSchema } from '@getpaseo/protocol/messages';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { createJournal } from '../../../src/connector/journal.js';
import { nativeWorkspaceId, sessionUuid } from '../../../src/connector/uuid-v5.js';

it('validates actual public SDK workspace/agent/send/refetch/permission mapping with the pinned native schemas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-native-contract-'));
  const journal = createJournal({ dir });
  const workspaces = new Map();
  const agents = new Map();
  const calls = { workspace: [], agent: [], send: [], cursor: [], permissions: [] };
  // The actual public SDK performs all high-level -> wire option mapping.
  // Only its daemon I/O driver is replaced, and every request hits the real
  // pinned protocol schema, rather than a copied regular expression.
  const driver = {
    supportsBackgroundWorkspaces: () => true,
    createWorkspace: async (options) => {
      const parsed = WorkspaceCreateRequestSchema.parse({ type: 'workspace.create.request', requestId: 'fixture', ...options });
      calls.workspace.push(parsed);
      const workspace = { id: parsed.workspaceId, workspaceKind: 'worktree', workspaceDirectory: '/repos/native-owned-worktree', archivingAt: null };
      workspaces.set(workspace.id, workspace);
      return { workspace, error: null };
    },
    fetchWorkspaces: async () => ({ entries: [...workspaces.values()], pageInfo: {} }),
    createAgent: async (options) => {
      const parsed = AgentCreateRequestSchema.parse({ type: 'agent.create.request', requestId: 'fixture', ...options });
      calls.agent.push(parsed);
      const agent = { id: parsed.agentId, workspaceId: parsed.workspaceId, status: 'idle', pendingPermissions: [] };
      agents.set(agent.id, agent);
      return agent;
    },
    fetchAgent: async ({ agentId }) => ({ agent: agents.get(agentId), project: null }),
    sendAgentMessage: async (agentId, text, options) => calls.send.push(SendAgentMessageRequestSchema.parse({ type: 'send_agent_message_request', requestId: 'fixture', agentId, text, ...options })),
    fetchAgentTimeline: async (agentId, options) => {
      calls.cursor.push(FetchAgentTimelineRequestMessageSchema.parse({ type: 'fetch_agent_timeline_request', requestId: 'fixture', agentId, ...options }));
      return { entries: [], agent: agents.get(agentId), hasOlder: false, hasNewer: false };
    },
    respondToPermission: async (agentId, requestId, response) => calls.permissions.push({ agentId, requestId, response: AgentPermissionResponseSchema.parse(response) }),
  };
  const paseo = createPaseoApi(driver);
  try {
    const intent = { commandId: 'command', runId: 'run', sessionId: 'session', repoPath: '/repos/source', repositoryKey: 'repo', branchName: 'ff/run/session', baseRef: 'main', title: 'Bounded native task', profileSnapshot: { provider: 'omp', model: 'ai3/qwen/qwen3.8-27b', modeId: 'full', thinkingOptionId: 'medium', features: {} }, mcpServers: { 'fluent-flow': { type: 'http', url: 'http://127.0.0.1:4000/mcp/collab', headers: { Authorization: 'Bearer session-scoped-fixture' } } }, labels: { 'fluent-flow.task': 'task' }, prompt: 'Bounded task text' };
    const adapter = createPaseoAdapter({ paseo, journal });
    const result = await adapter.launch(intent);
    expect(result.status).toBe('applied');
    expect(calls.workspace[0].workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
    expect(calls.workspace[0].workspaceId).toBe(nativeWorkspaceId('run'));
    expect(calls.agent[0]).toMatchObject({ agentId: sessionUuid('session'), workspaceId: result.workspaceId, labels: { 'fluent-flow.task': 'task', 'fluent-flow.run': 'run', 'fluent-flow.session': 'session' }, config: { provider: 'omp', model: 'ai3/qwen/qwen3.8-27b', cwd: '/repos/native-owned-worktree', modeId: 'full', thinkingOptionId: 'medium', mcpServers: intent.mcpServers } });
    expect(calls.send[0]).toMatchObject({ agentId: result.paseoAgentId, text: intent.prompt, messageId: 'command' });
    await paseo.agents.ref(result.paseoAgentId).timeline.refetch({ direction: 'after', cursor: { epoch: 'e', seq: 9 }, projection: 'canonical' });
    await paseo.agents.ref(result.paseoAgentId).respondToPermission({ requestId: 'request', response: { behavior: 'allow', updatedInput: { answers: { Choice: 'Continue' } } } });
    expect(calls.cursor[0].cursor).toEqual({ epoch: 'e', seq: 9 });
    expect(calls.permissions[0].response.updatedInput.answers).toEqual({ Choice: 'Continue' });
    await createPaseoAdapter({ paseo, journal }).launch({ ...intent, prompt: undefined });
    expect(calls.workspace).toHaveLength(1);
    expect(calls.agent).toHaveLength(1);
  } finally { await paseo.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it('reuses an existing journal workspace binding without renaming or recreating it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-bound-id-'));
  const journal = createJournal({ dir });
  await journal.append({ type: 'binding', commandId: 'existing', runId: 'run', sessionId: 'session', workspaceId: 'recorded-before-current-id-algorithm', paseoAgentId: sessionUuid('session') });
  const refs = [];
  const paseo = { workspaces: { ref: (id) => { refs.push(id); return { refresh: async () => ({ id }) }; } }, agents: { ref: (id) => ({ refresh: async () => ({ agent: { id } }) }) } };
  try {
    const result = await createPaseoAdapter({ paseo, journal }).launch({ commandId: 'existing', runId: 'run', sessionId: 'session' });
    expect(result.workspaceId).toBe('recorded-before-current-id-algorithm');
    expect(refs).toEqual(['recorded-before-current-id-algorithm']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
