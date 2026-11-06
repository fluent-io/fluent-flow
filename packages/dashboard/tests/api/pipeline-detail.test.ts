import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetPipelineDetail = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getPipelineDetail: (...args: unknown[]) => mockGetPipelineDetail(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/pipelines/[...slug]/route');

describe('GET /api/pipelines/[...slug]', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetPipelineDetail.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['fluent-io', 'fluent-flow', '28'] }) });
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid slug', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['bad'] }) });
    expect(response.status).toBe(400);
  });

  it('returns pipeline detail for valid slug', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetPipelineDetail.mockResolvedValueOnce([
      { id: 1, claim_type: 'spec', status: 'completed', agent_id: 'ff-runner' },
    ]);

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['fluent-io', 'fluent-flow', '28'] }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockGetPipelineDetail).toHaveBeenCalledWith(['fluent-io'], 'fluent-io/fluent-flow', 28, 'active', false);
  });

  it('passes isSuperadmin=false for empty-org collaborator so legacy pipelines are not unscoped', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 7, isSuperadmin: false, orgs: [] },
    });
    mockGetPipelineDetail.mockResolvedValueOnce([]);

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['legacy-org', 'legacy', '28'] }) });
    expect(response.status).toBe(200);
    expect(mockGetPipelineDetail).toHaveBeenCalledWith([], 'legacy-org/legacy', 28, 'active', false);
  });
});
