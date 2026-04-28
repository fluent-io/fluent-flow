import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockCreateClaim = vi.fn();
const mockQuery = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  createClaim: (...args: unknown[]) => mockCreateClaim(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { POST } = await import('../../src/app/api/repos/[repoId]/claims/route');

function request(body: unknown) {
  return new Request('http://localhost/api/repos/repo-1/claims', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ repoId: 'repo-1' }) };

describe('POST /api/repos/[repoId]/claims', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockCreateClaim.mockReset();
    mockQuery.mockReset();
    mockGetServerSession.mockResolvedValue({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockQuery.mockResolvedValue({ rows: [{ id: 'repo-1', repo_full_name: 'fluent-io/fluent-flow' }] });
    mockCreateClaim.mockResolvedValue({ id: 123, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', claim_type: 'spec', status: 'pending' });
  });

  it('starts only a spec workflow and auto-chains pipeline steps', async () => {
    const response = await POST(request({ claim_type: 'spec', description: 'Build the dashboard' }), params);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.claim_type).toBe('spec');
    expect(mockCreateClaim).toHaveBeenCalledWith({
      repoId: 'repo-1',
      claimType: 'spec',
      description: 'Build the dashboard',
      prNumber: null,
      payload: { auto_chain: true },
    });
  });

  it.each(['feature', 'fix', 'review', 'review_fix', 'test_verify', 'build'])('rejects %s as a top-level workflow type', async (claimType) => {
    const response = await POST(request({ claim_type: claimType, description: 'Do work' }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('Start workflow only supports claim_type "spec"');
    expect(mockCreateClaim).not.toHaveBeenCalled();
  });

  it('rejects PR numbers because PR-scoped work is a pipeline step', async () => {
    const response = await POST(request({ claim_type: 'spec', description: 'Review this', pr_number: 42 }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('pr_number is not accepted');
    expect(mockCreateClaim).not.toHaveBeenCalled();
  });
});
