import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListPipelines = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listPipelines: (...args: unknown[]) => mockListPipelines(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/pipelines/route');

describe('GET /api/pipelines', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListPipelines.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns pipelines scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListPipelines.mockResolvedValueOnce([
      { org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28, latest_attempt: 1, stages: [] },
    ]);

    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockListPipelines).toHaveBeenCalledWith(['fluent-io']);
  });
});
