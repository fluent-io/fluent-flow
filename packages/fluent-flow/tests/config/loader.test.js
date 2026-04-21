import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

// Mock the pg-side db so resolveConfig doesn't try to open a real connection.
// configCache: return empty so the resolver falls through to the GitHub path.
// repos+providerInstallations join: parameterised per test via repoRow().
const repoRow = vi.fn();
const fakeDb = {
  select: () => ({
    from: (t) => ({
      innerJoin: () => ({
        where: () => ({
          limit: () => (t?.name === 'repos' ? repoRow() : []),
        }),
      }),
      where: () => ({
        limit: () => (t?.name === 'repos' ? repoRow() : []),
      }),
    }),
  }),
  insert: () => ({
    values: () => ({
      onConflictDoUpdate: () => Promise.resolve(undefined),
    }),
  }),
  delete: () => ({ where: () => Promise.resolve(undefined) }),
};

vi.mock('@fluent-flow/db', () => ({
  db: fakeDb,
  schema: {
    configCache: {
      name: 'configCache',
      repo: { name: 'repo' },
      config: { name: 'config' },
      expiresAt: { name: 'expiresAt' },
      fetchedAt: { name: 'fetchedAt' },
    },
    repos: {
      name: 'repos',
      id: { name: 'id' },
      installationId: { name: 'installation_id' },
    },
    providerInstallations: {
      name: 'provider_installations',
      id: { name: 'id' },
      externalInstallationId: { name: 'external_installation_id' },
    },
  },
}));

const mockGetRepoFileContents = vi.fn();
vi.mock('../../src/providers/github/rest.js', () => ({
  getRepoFileContents: (...args) => mockGetRepoFileContents(...args),
}));

beforeEach(() => {
  vi.resetModules();
  mockGetRepoFileContents.mockReset();
  repoRow.mockReset();
});

describe('resolveConfig — installation-scoped GitHub token', () => {
  it('passes the GitHub external installation_id as ctx to getRepoFileContents', async () => {
    // Config YAML content (base64-encoded, matching GitHub contents API shape).
    const yamlContent = Buffer.from('reviewer:\n  trigger_check: test\n').toString('base64');
    mockGetRepoFileContents.mockResolvedValueOnce(yamlContent);
    // The join returns provider_installations.external_installation_id, which
    // is what /app/installations/:id/access_tokens expects — NOT our internal
    // FK value.
    repoRow.mockReturnValueOnce([{ externalId: '125521931' }]);

    const { resolveConfig } = await import('../../src/config/loader.js');
    await resolveConfig('fluent-io', 'fluent-flow-p1');

    expect(mockGetRepoFileContents).toHaveBeenCalledTimes(1);
    const [owner, repo, path, ctx] = mockGetRepoFileContents.mock.calls[0];
    expect(owner).toBe('fluent-io');
    expect(repo).toBe('fluent-flow-p1');
    expect(path).toBe('.github/fluent-flow.yml');
    // App-model: caller must supply the external installation id so
    // resolveToken mints an install token instead of falling through to the
    // GITHUB_TOKEN PAT.
    expect(ctx).toEqual({ installation_id: 125521931 });
  });

  it('falls back to no ctx when the repos row is missing (unknown repo)', async () => {
    mockGetRepoFileContents.mockResolvedValueOnce(null);
    repoRow.mockReturnValueOnce([]); // no repos row

    const { resolveConfig } = await import('../../src/config/loader.js');
    await resolveConfig('unknown-org', 'unknown-repo');

    expect(mockGetRepoFileContents).toHaveBeenCalledTimes(1);
    const ctx = mockGetRepoFileContents.mock.calls[0][3];
    expect(ctx).toBeUndefined();
  });
});
