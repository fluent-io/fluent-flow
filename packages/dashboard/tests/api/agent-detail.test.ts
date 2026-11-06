import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetAgentDetail = vi.fn();
const mockGetAgentSessions = vi.fn();
const mockGetAgentClaims = vi.fn();
const mockGetKeyInfo = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getAgentDetail: (...args: unknown[]) => mockGetAgentDetail(...args),
  getAgentSessions: (...args: unknown[]) => mockGetAgentSessions(...args),
  getAgentClaims: (...args: unknown[]) => mockGetAgentClaims(...args),
  getKeyInfo: (...args: unknown[]) => mockGetKeyInfo(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/agents/[id]/route.js');

describe('GET /api/agents/[id]', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockGetAgentSessions.mockReset();
    mockGetAgentClaims.mockReset();
    mockGetKeyInfo.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(401);
  });

  it('returns 404 when agent not found', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce(null);

    const request = new Request('http://localhost/api/agents/nonexistent');
    const response = await GET(request, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(response.status).toBe(404);
  });

  it('returns agent with sessions, claims, and key info', async () => {
    const agent = { id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code' };
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce(agent);
    mockGetAgentSessions.mockResolvedValueOnce([]);
    mockGetAgentClaims.mockResolvedValueOnce([]);
    mockGetKeyInfo.mockResolvedValueOnce({ id: 3, created_at: new Date() });

    const request = new Request('http://localhost/api/agents/ff-runner');
    const response = await GET(request, { params: Promise.resolve({ id: 'ff-runner' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agent.id).toBe('ff-runner');
    expect(data.sessions).toEqual([]);
    expect(data.claims).toEqual([]);
    expect(data.key).toBeDefined();
  });

  it('forbids empty-org collaborator from reading legacy org agents via ?org=', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 7, isSuperadmin: false, orgs: [] },
    });

    const request = new Request('http://localhost/api/agents/ff-runner?org=legacy-org');
    const response = await GET(request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(403);
    expect(mockGetAgentDetail).not.toHaveBeenCalled();
  });

  it('passes explicit isSuperadmin to getAgentDetail for superadmin scoped requests', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: true, orgs: [] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'legacy-org' });
    mockGetAgentSessions.mockResolvedValueOnce([]);
    mockGetAgentClaims.mockResolvedValueOnce([]);
    mockGetKeyInfo.mockResolvedValueOnce({ id: 3, created_at: new Date() });

    const request = new Request('http://localhost/api/agents/ff-runner?org=legacy-org');
    const response = await GET(request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(200);
    expect(mockGetAgentDetail).toHaveBeenCalledWith(['legacy-org'], 'ff-runner', true);
  });
});
