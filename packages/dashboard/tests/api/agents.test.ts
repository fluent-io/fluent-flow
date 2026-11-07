import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListAgents = vi.fn();
const mockCreateAgent = vi.fn();
const mockCreateToken = vi.fn();
const mockQuery = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  createToken: (...args: unknown[]) => mockCreateToken(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
  hasRole: vi.fn(() => true),
}));

const { GET, POST } = await import('../../src/app/api/agents/route.js');

describe('GET /api/agents', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListAgents.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns agents scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListAgents.mockResolvedValueOnce([
      { id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code', status: 'online' },
    ]);

    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ff-runner');
    expect(mockListAgents).toHaveBeenCalledWith(['fluent-io'], false);
  });

  it('returns all agents for superadmin', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: true, orgs: [] },
    });
    mockListAgents.mockResolvedValueOnce([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListAgents).toHaveBeenCalledWith([], true);
  });

  it('passes isSuperadmin=false for empty-org collaborator so legacy agents are not unscoped', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 7, login: 'client-user', isSuperadmin: false, orgs: [] },
    });
    mockListAgents.mockResolvedValueOnce([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListAgents).toHaveBeenCalledWith([], false);
  });
});

describe('POST /api/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_FLUENT_FLOW_URL = 'https://flow.example.com';
    mockGetServerSession.mockResolvedValue({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockCreateAgent.mockImplementation(async (input: {
      id: string;
      orgId: string;
      agentType: string;
      transport: string;
    }) => ({
      id: input.id,
      org_id: input.orgId,
      agent_type: input.agentType,
      transport: input.transport,
    }));
    mockCreateToken.mockResolvedValue({ plaintext: 'ff_local_runner_token' });
  });

  it.each(['claude-code', 'codex', 'opencode'])('creates a long-poll %s agent and returns a local runner command', async (agentType) => {
    const response = await POST(new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: 'fluent-io',
        agent_id: `${agentType}-runner`,
        agent_type: agentType,
      }),
    }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledWith({
      id: `${agentType}-runner`,
      orgId: 'fluent-io',
      agentType,
      transport: 'long_poll',
    });
    expect(data.agent).toEqual(expect.objectContaining({
      agent_type: agentType,
      transport: 'long_poll',
    }));
    expect(data.command).toBe(
      'npx @fluent-flow/runner@latest \\\n  --server https://flow.example.com \\\n  --token ff_local_runner_token',
    );
  });

  it.each(['aider', 'toString'])('rejects %s in the dashboard long-poll flow', async (agentType) => {
    const response = await POST(new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: 'fluent-io',
        agent_id: `${agentType}-runner`,
        agent_type: agentType,
      }),
    }));

    expect(response.status).toBe(400);
    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
  });
});
