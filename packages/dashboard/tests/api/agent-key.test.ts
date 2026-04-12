import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetAgentDetail = vi.fn();
const mockRegenerateKey = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getAgentDetail: (...args: unknown[]) => mockGetAgentDetail(...args),
  regenerateKey: (...args: unknown[]) => mockRegenerateKey(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
  hasRole: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { role: string }[] } }, _orgId: string, minRole: string) => {
    if (session.user.isSuperadmin) return true;
    if (minRole === 'admin') return session.user.orgs.some((o) => o.role === 'admin');
    return true;
  }),
}));

const { POST } = await import('../../src/app/api/agents/[id]/key/route.js');

describe('POST /api/agents/[id]/key', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockRegenerateKey.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(401);
  });

  it('returns 403 for members', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'member' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io' });

    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(403);
  });

  it('regenerates key for admin', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io' });
    mockRegenerateKey.mockResolvedValueOnce({ plaintext: 'ff_abc123', id: 5 });

    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.plaintext).toBe('ff_abc123');
  });
});
