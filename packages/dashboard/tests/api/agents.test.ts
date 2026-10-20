import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListAgents = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/agents/route.js');

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
