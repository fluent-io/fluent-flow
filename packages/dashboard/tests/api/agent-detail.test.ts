import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetAgentDetail = vi.fn();
const mockGetAgentSessions = vi.fn();
const mockGetAgentClaims = vi.fn();
const mockGetKeyInfo = vi.fn();
const mockDeleteAgentIfNoCollaborationClaims = vi.fn();
const mockUpdateAgentChatSlots = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getAgentDetail: (...args: unknown[]) => mockGetAgentDetail(...args),
  getAgentSessions: (...args: unknown[]) => mockGetAgentSessions(...args),
  getAgentClaims: (...args: unknown[]) => mockGetAgentClaims(...args),
  getKeyInfo: (...args: unknown[]) => mockGetKeyInfo(...args),
  deleteAgentIfNoCollaborationClaims: (...args: unknown[]) => mockDeleteAgentIfNoCollaborationClaims(...args),
  updateAgentChatSlots: (...args: unknown[]) => mockUpdateAgentChatSlots(...args),
  isValidChatSlotValue: (value: unknown) => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  hasRole: vi.fn(() => true),
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { DELETE, GET, PATCH } = await import('../../src/app/api/agents/[id]/route.js');
const { hasRole } = await import('@/lib/auth');

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

describe('DELETE /api/agents/[id]', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockDeleteAgentIfNoCollaborationClaims.mockReset();
  });

  it('preserves agents that own collaboration execution history', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io' });
    mockDeleteAgentIfNoCollaborationClaims.mockResolvedValueOnce('protected');

    const request = new Request('http://localhost/api/agents/ff-runner');
    const response = await DELETE(request, { params: Promise.resolve({ id: 'ff-runner' }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Agent cannot be deleted because execution history must be preserved',
    });
  });
});

describe('PATCH /api/agents/[id] maxChatSlots', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockUpdateAgentChatSlots.mockReset();
    vi.mocked(hasRole).mockReset();
    vi.mocked(hasRole).mockImplementation(() => true);
  });

  function authedSession() {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockGetAgentDetail.mockResolvedValue({ id: 'ff-runner', org_id: 'fluent-io' });
  }

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: 3 }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(401);
    expect(mockUpdateAgentChatSlots).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent is not in scope', async () => {
    authedSession();
    mockGetAgentDetail.mockResolvedValue(null);
    const response = await PATCH(
      new Request('http://localhost/api/agents/missing', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: 3 }) }),
      { params: Promise.resolve({ id: 'missing' }) },
    );
    expect(response.status).toBe(404);
  });

  it('returns 403 when the session lacks the org admin role', async () => {
    authedSession();
    vi.mocked(hasRole).mockImplementation(() => false);
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: 3 }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(403);
    expect(mockUpdateAgentChatSlots).not.toHaveBeenCalled();
  });

  it.each([16, -1, 1.5, '3', 'high'])('rejects invalid maxChatSlots %j with 400', async (value) => {
    authedSession();
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: value }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(400);
    expect(mockUpdateAgentChatSlots).not.toHaveBeenCalled();
  });

  it('persists an in-range value through the org-scoped mutation', async () => {
    authedSession();
    mockUpdateAgentChatSlots.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io', max_chat_slots: 3 });
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: 3 }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(200);
    expect(mockUpdateAgentChatSlots).toHaveBeenCalledWith('fluent-io', 'ff-runner', 3);
    await expect(response.json()).resolves.toMatchObject({ agent: { max_chat_slots: 3 } });
  });

  it('persists null to restore the default chat slot policy', async () => {
    authedSession();
    mockUpdateAgentChatSlots.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io', max_chat_slots: null });
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: null }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(200);
    expect(mockUpdateAgentChatSlots).toHaveBeenCalledWith('fluent-io', 'ff-runner', null);
  });

  it('returns 404 when the mutation finds no row', async () => {
    authedSession();
    mockUpdateAgentChatSlots.mockResolvedValueOnce(null);
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: JSON.stringify({ maxChatSlots: 2 }) }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(404);
  });

  it('returns 400 on a malformed body', async () => {
    authedSession();
    const response = await PATCH(
      new Request('http://localhost/api/agents/ff-runner', { method: 'PATCH', body: 'not-json' }),
      { params: Promise.resolve({ id: 'ff-runner' }) },
    );
    expect(response.status).toBe(400);
  });
});
