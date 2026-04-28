import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListPipelines = vi.fn();
const mockDismissStaleClaims = vi.fn();
const mockDismissPipelineClaims = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listPipelines: (...args: unknown[]) => mockListPipelines(...args),
  dismissStaleClaims: (...args: unknown[]) => mockDismissStaleClaims(...args),
  dismissPipelineClaims: (...args: unknown[]) => mockDismissPipelineClaims(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET, POST } = await import('../../src/app/api/pipelines/route');

describe('GET /api/pipelines', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListPipelines.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET({ url: 'http://localhost/api/pipelines' } as Request);
    expect(response.status).toBe(401);
  });

  it('returns pipelines scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListPipelines.mockResolvedValueOnce([
      { org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28, latest_attempt: 1, stages: [] },
    ]);

    const response = await GET({ url: 'http://localhost/api/pipelines' } as Request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockListPipelines).toHaveBeenCalledWith(['fluent-io'], 'active');
  });

  it('passes filter param to listPipelines', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: true, orgs: [] },
    });
    mockListPipelines.mockResolvedValueOnce([]);

    const response = await GET({ url: 'http://localhost/api/pipelines?filter=all' } as Request);
    expect(response.status).toBe(200);
    expect(mockListPipelines).toHaveBeenCalledWith([], 'all');
  });
});

describe('POST /api/pipelines', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockDismissStaleClaims.mockReset();
    mockDismissPipelineClaims.mockReset();
  });

  function makeRequest(body: unknown) {
    return new Request('http://localhost/api/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const response = await POST(makeRequest({ action: 'dismiss-stale' }));
    expect(response.status).toBe(401);
  });

  it('dismisses stale claims (superadmin)', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: true, orgs: [] },
    });
    mockDismissStaleClaims.mockResolvedValueOnce(3);

    const response = await POST(makeRequest({ action: 'dismiss-stale' }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.dismissed).toBe(3);
    expect(mockDismissStaleClaims).toHaveBeenCalledWith([], undefined);
  });

  it('allows dismiss-stale for non-superadmin org members', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockDismissStaleClaims.mockResolvedValueOnce(2);

    const response = await POST(makeRequest({ action: 'dismiss-stale' }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.dismissed).toBe(2);
    expect(mockDismissStaleClaims).toHaveBeenCalledWith(['fluent-io'], undefined);
  });

  it('dismisses stale claims with custom threshold', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: true, orgs: [] },
    });
    mockDismissStaleClaims.mockResolvedValueOnce(1);

    const response = await POST(makeRequest({ action: 'dismiss-stale', older_than_ms: 3600000 }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.dismissed).toBe(1);
    expect(mockDismissStaleClaims).toHaveBeenCalledWith([], 3600000);
  });

  it('dismisses pipeline claims by repo', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockDismissPipelineClaims.mockResolvedValueOnce(2);

    const response = await POST(makeRequest({ action: 'dismiss-pipeline', repo: 'fluent-io/app', pr_number: 42 }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.dismissed).toBe(2);
    expect(mockDismissPipelineClaims).toHaveBeenCalledWith(['fluent-io'], 'fluent-io/app', 42);
  });

  it('returns 400 for missing repo on dismiss-pipeline', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });

    const response = await POST(makeRequest({ action: 'dismiss-pipeline' }));
    expect(response.status).toBe(400);
  });

  it('returns 400 for unknown action', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });

    const response = await POST(makeRequest({ action: 'explode' }));
    expect(response.status).toBe(400);
  });
});
