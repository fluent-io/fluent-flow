import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const mockUpsertUser = vi.fn();
const mockLinkUserToOrg = vi.fn();
// Captures every db.insert(...).values(...).onConflictDoUpdate(...) call.
// Within this test, installation-lifecycle is the only exercised codepath
// that calls onConflictDoUpdate, so the contents reflect repo shell-row
// upserts. Reset in the individual describe blocks that assert on it.
const mockRepoInserts = [];

vi.mock('@fluent-flow/db', () => ({
  db: {
    insert: () => ({
      values: (values) => ({
        onConflictDoNothing: async () => [],
        onConflictDoUpdate: async ({ set }) => {
          mockRepoInserts.push({ values, set });
          return [];
        },
      }),
    }),
    // Suspend/delete code paths:
    //   - `db.select(...).from(...).where(...)` builds a sub-select passed
    //     into drizzle's inArray(...) — NOT awaited in production code.
    //     Returning a plain sentinel (not a Promise) matches that usage so
    //     the mock doesn't mask bugs where something starts awaiting it.
    //   - `db.update(...).set(...).where(...)` IS awaited — mock as async.
    select: () => ({ from: () => ({ where: () => ({ __subquery: 'mock' }) }) }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  },
  schema: { orgs: {}, agentClaims: {}, repos: { id: 'repos.id' } },
  upsertUser: (...args) => mockUpsertUser(...args),
  linkUserToOrg: (...args) => mockLinkUserToOrg(...args),
}));

const mockUpsertInstallation = vi.fn().mockResolvedValue({ id: 999 });
const mockFindInstallation = vi.fn();
const mockAddRepoToInstallation = vi.fn();
const mockSoftDeleteInstallation = vi.fn();
const mockSoftDeleteAllReposForInstallation = vi.fn();
vi.mock('../../src/db/provider-installations.js', () => ({
  upsertInstallation: (...args) => mockUpsertInstallation(...args),
  softDeleteInstallation: (...args) => mockSoftDeleteInstallation(...args),
  unsuspendInstallation: vi.fn(),
  findInstallationByExternalId: (...args) => mockFindInstallation(...args),
  addRepoToInstallation: (...args) => mockAddRepoToInstallation(...args),
  removeRepoFromInstallation: vi.fn(),
  softDeleteAllReposForInstallation: (...args) => mockSoftDeleteAllReposForInstallation(...args),
}));

vi.mock('../../src/db/outbound-queue.js', () => ({
  parkForInstallation: vi.fn(),
  unparkForInstallation: vi.fn(),
}));

const mockGetInstallationToken = vi.fn();
vi.mock('../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: (...args) => mockGetInstallationToken(...args),
}));

const {
  handleInstallationCreated,
  handleInstallationRepositoriesAdded,
  handleInstallationDeleted,
} = await import('../../src/engine/installation-lifecycle.js');

function buildPayload(overrides = {}) {
  return {
    installation: {
      id: 12345,
      account: { login: 'acme', type: 'Organization' },
      permissions: { contents: 'read' },
      events: ['push'],
    },
    sender: { id: 777, login: 'victor', type: 'User', avatar_url: 'https://a.b/c.png' },
    ...overrides,
  };
}

describe('handleInstallationCreated', () => {
  beforeEach(() => {
    mockUpsertUser.mockReset();
    mockLinkUserToOrg.mockReset();
    mockUpsertInstallation.mockClear();
    mockUpsertInstallation.mockResolvedValue({ id: 999 });
    mockAddRepoToInstallation.mockReset();
    mockRepoInserts.length = 0;
  });

  it('links a human sender to the org as admin', async () => {
    mockUpsertUser.mockResolvedValue({ id: 42 });
    mockLinkUserToOrg.mockResolvedValue(undefined);

    await handleInstallationCreated(buildPayload());

    expect(mockUpsertUser).toHaveBeenCalledWith({
      github_id: 777,
      login: 'victor',
      email: null,
      avatar_url: 'https://a.b/c.png',
    });
    expect(mockLinkUserToOrg).toHaveBeenCalledWith(42, 'acme', 'admin');
  });

  it('skips linking when sender is a Bot', async () => {
    await handleInstallationCreated(buildPayload({
      sender: { id: 1, login: 'some-bot', type: 'Bot' },
    }));

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockLinkUserToOrg).not.toHaveBeenCalled();
  });

  it('skips linking when sender is missing', async () => {
    await handleInstallationCreated(buildPayload({ sender: undefined }));

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockLinkUserToOrg).not.toHaveBeenCalled();
  });

  it('does not throw when linking fails — webhook completes installation anyway', async () => {
    mockUpsertUser.mockResolvedValue({ id: 42 });
    mockLinkUserToOrg.mockRejectedValue(new Error('db blew up'));

    await expect(handleInstallationCreated(buildPayload())).resolves.toBeDefined();
    expect(mockUpsertInstallation).toHaveBeenCalled();
  });

  it('materializes a repos shell row per payload.repositories entry', async () => {
    mockUpsertInstallation.mockResolvedValueOnce({ id: 42 });

    await handleInstallationCreated(buildPayload({
      repositories: [
        { id: 1001, full_name: 'acme/a' },
        { id: 1002, full_name: 'acme/b' },
      ],
    }));

    expect(mockRepoInserts).toHaveLength(2);
    expect(mockRepoInserts[0].values).toMatchObject({
      id: 'acme/a',
      orgId: 'acme',
      repoExternalId: 1001,
      repoFullName: 'acme/a',
      provider: 'github',
      installationId: 42,
    });
    expect(mockRepoInserts[1].values).toMatchObject({
      id: 'acme/b',
      orgId: 'acme',
      repoExternalId: 1002,
      repoFullName: 'acme/b',
      installationId: 42,
    });
    // onConflictDoUpdate must re-link installationId so cross-org transfers
    // and re-installs land on the latest installation.
    expect(mockRepoInserts[0].set).toMatchObject({
      installationId: 42,
      repoFullName: 'acme/a',
      orgId: 'acme',
    });
  });

  it('populates provider_installation_repos via addRepoToInstallation for each payload repo', async () => {
    // `repository_selection: 'all'` installs deliver all repos in the
    // installation.created payload and do NOT fire a separate
    // installation_repositories.added event. handleInstallationCreated must
    // therefore call addRepoToInstallation itself — otherwise the PIR join
    // table stays empty for the active install and downstream lookups fail.
    mockUpsertInstallation.mockResolvedValueOnce({ id: 42 });

    await handleInstallationCreated(buildPayload({
      repositories: [
        { id: 1001, full_name: 'acme/a' },
        { id: 1002, full_name: 'acme/b' },
      ],
    }));

    expect(mockAddRepoToInstallation).toHaveBeenCalledTimes(2);
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 1001,
      repo_full_name: 'acme/a',
    });
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 1002,
      repo_full_name: 'acme/b',
    });
  });

  it('creates no repos rows when payload.repositories is absent', async () => {
    await handleInstallationCreated(buildPayload());
    expect(mockRepoInserts).toHaveLength(0);
  });

  it('skips malformed repo entries (missing full_name) without failing the webhook', async () => {
    await handleInstallationCreated(buildPayload({
      repositories: [
        { id: 1, full_name: 'acme/good' },
        { id: 2 }, // no full_name
        null,
      ],
    }));

    expect(mockRepoInserts).toHaveLength(1);
    expect(mockRepoInserts[0].values.id).toBe('acme/good');
  });
});

describe('handleInstallationRepositoriesAdded', () => {
  beforeEach(() => {
    mockFindInstallation.mockReset();
    mockAddRepoToInstallation.mockReset();
    mockRepoInserts.length = 0;
  });

  it('links each repo to the installation AND materializes shell rows in repos', async () => {
    mockFindInstallation.mockResolvedValueOnce({ id: 42, org_id: 'acme' });
    mockAddRepoToInstallation.mockResolvedValue(undefined);

    await handleInstallationRepositoriesAdded({
      installation: { id: 12345, account: { login: 'acme' } },
      repositories_added: [
        { id: 5001, full_name: 'acme/widgets' },
        { id: 5002, full_name: 'acme/gadgets' },
      ],
    });

    expect(mockAddRepoToInstallation).toHaveBeenCalledTimes(2);
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 5001,
      repo_full_name: 'acme/widgets',
    });

    expect(mockRepoInserts).toHaveLength(2);
    expect(mockRepoInserts[0].values).toMatchObject({
      id: 'acme/widgets',
      orgId: 'acme',
      repoExternalId: 5001,
      installationId: 42,
    });
    expect(mockRepoInserts[1].values.id).toBe('acme/gadgets');
  });

  it('does nothing when the installation cannot be found', async () => {
    mockFindInstallation.mockResolvedValueOnce(null);

    await handleInstallationRepositoriesAdded({
      installation: { id: 99999, account: { login: 'x' } },
      repositories_added: [{ id: 1, full_name: 'x/y' }],
    });

    expect(mockAddRepoToInstallation).not.toHaveBeenCalled();
    expect(mockRepoInserts).toHaveLength(0);
  });
});

describe('handleInstallationDeleted', () => {
  beforeEach(() => {
    mockFindInstallation.mockReset();
    mockSoftDeleteInstallation.mockReset();
    mockSoftDeleteAllReposForInstallation.mockReset();
  });

  it('cascades the tombstone: marks installation suspended AND soft-deletes all repo links', async () => {
    mockFindInstallation.mockResolvedValue({ id: 42, org_id: 'acme' });
    mockSoftDeleteInstallation.mockResolvedValue(undefined);
    mockSoftDeleteAllReposForInstallation.mockResolvedValue(1);

    await handleInstallationDeleted(12345);

    // Suspend-level behaviour ran (via handleInstallationSuspended reuse).
    expect(mockSoftDeleteInstallation).toHaveBeenCalledWith(42);
    // Delete-specific cascade ran — the gap PR #82's review surfaced.
    expect(mockSoftDeleteAllReposForInstallation).toHaveBeenCalledWith(42);
  });

  it('does nothing and does not cascade when the installation is not found', async () => {
    mockFindInstallation.mockResolvedValue(null);

    await handleInstallationDeleted(99999);

    expect(mockSoftDeleteInstallation).not.toHaveBeenCalled();
    expect(mockSoftDeleteAllReposForInstallation).not.toHaveBeenCalled();
  });
});

describe('handleInstallationCreated — API backfill for repository_selection: all', () => {
  let fetchSpy;

  beforeEach(() => {
    mockUpsertUser.mockReset();
    mockLinkUserToOrg.mockReset();
    mockUpsertInstallation.mockClear();
    mockUpsertInstallation.mockResolvedValue({ id: 42 });
    mockAddRepoToInstallation.mockReset();
    mockRepoInserts.length = 0;
    mockGetInstallationToken.mockReset();
    mockGetInstallationToken.mockResolvedValue('fake-installation-token');
  });

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    fetchSpy = null;
  });

  it('calls GitHub API to backfill repos not in payload when repository_selection is all', async () => {
    // Payload has 1 repo, but the API returns 3 (2 additional)
    const payload = buildPayload({
      installation: {
        id: 12345,
        account: { login: 'acme', type: 'Organization' },
        permissions: { contents: 'read' },
        events: ['push'],
        repository_selection: 'all',
      },
      repositories: [
        { id: 1001, full_name: 'acme/payload-repo' },
      ],
    });

    // First page returns 3 repos, second page returns empty (pagination end)
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repositories: [
            { id: 1001, full_name: 'acme/payload-repo' },
            { id: 2001, full_name: 'acme/api-extra-1' },
            { id: 2002, full_name: 'acme/api-extra-2' },
          ],
        }),
      });

    await handleInstallationCreated(payload);

    // Token was fetched for the API call
    expect(mockGetInstallationToken).toHaveBeenCalledWith(12345);

    // fetch was called for pagination
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/installation/repositories?per_page=100&page=1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-installation-token',
        }),
      }),
    );

    // addRepoToInstallation called for ALL 3 repos (1 payload + 2 API)
    expect(mockAddRepoToInstallation).toHaveBeenCalledTimes(3);
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 1001,
      repo_full_name: 'acme/payload-repo',
    });
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 2001,
      repo_full_name: 'acme/api-extra-1',
    });
    expect(mockAddRepoToInstallation).toHaveBeenCalledWith(42, {
      repo_external_id: 2002,
      repo_full_name: 'acme/api-extra-2',
    });

    // ensureRepo (via mockRepoInserts) called for all 3 repos
    expect(mockRepoInserts).toHaveLength(3);
  });

  it('handles paginated API responses (multiple pages)', async () => {
    const payload = buildPayload({
      installation: {
        id: 12345,
        account: { login: 'acme', type: 'Organization' },
        permissions: { contents: 'read' },
        events: ['push'],
        repository_selection: 'all',
      },
      repositories: [],
    });

    // Page 1: 100 repos (full page → triggers page 2)
    const page1Repos = Array.from({ length: 100 }, (_, i) => ({
      id: 3000 + i,
      full_name: `acme/repo-${i}`,
    }));
    // Page 2: 3 repos (less than perPage → stops pagination)
    const page2Repos = [
      { id: 4001, full_name: 'acme/repo-100' },
      { id: 4002, full_name: 'acme/repo-101' },
      { id: 4003, full_name: 'acme/repo-102' },
    ];

    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repositories: page1Repos }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repositories: page2Repos }),
      });

    await handleInstallationCreated(payload);

    // fetch called twice (page 1 and page 2)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(1,
      expect.stringContaining('page=1'),
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(2,
      expect.stringContaining('page=2'),
      expect.any(Object),
    );

    // addRepoToInstallation called for all 103 repos
    expect(mockAddRepoToInstallation).toHaveBeenCalledTimes(103);
  });

  it('does not call API when repository_selection is not all', async () => {
    const payload = buildPayload({
      installation: {
        id: 12345,
        account: { login: 'acme', type: 'Organization' },
        permissions: { contents: 'read' },
        events: ['push'],
        repository_selection: 'selected',
      },
      repositories: [{ id: 1001, full_name: 'acme/a' }],
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch');

    await handleInstallationCreated(payload);

    expect(mockGetInstallationToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Only the payload repo
    expect(mockAddRepoToInstallation).toHaveBeenCalledTimes(1);
  });
});
