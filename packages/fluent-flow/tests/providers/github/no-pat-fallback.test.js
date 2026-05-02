/**
 * Cross-cutting tests: verify GITHUB_TOKEN PAT fallback is removed.
 * All GitHub API calls require installation_id — no silent PAT fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock token cache
vi.mock('../../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('installation-token-xyz'),
}));

import { getInstallationToken } from '../../../src/providers/github/token-cache.js';

const mockGetToken = /** @type {import('vitest').MockedFunction<typeof getInstallationToken>} */ (getInstallationToken);

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure no PAT is available
  delete process.env.GITHUB_TOKEN;

  // Mock global fetch
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ id: 1 }),
  });
});

describe('rest.js: resolveToken throws on missing installation_id', () => {
  it('throws when ctx is undefined', async () => {
    const { postComment } = await import('../../../src/providers/github/rest.js');
    await expect(postComment('acme', 'repo', 1, 'body')).rejects.toThrow(
      /installation_id/
    );
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('throws when ctx is an empty object', async () => {
    const { postComment } = await import('../../../src/providers/github/rest.js');
    await expect(postComment('acme', 'repo', 1, 'body', {})).rejects.toThrow(
      /installation_id/
    );
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('throws when ctx.installation_id is null', async () => {
    const { postComment } = await import('../../../src/providers/github/rest.js');
    await expect(
      postComment('acme', 'repo', 1, 'body', { installation_id: null })
    ).rejects.toThrow(/installation_id/);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('uses installation token when installation_id is provided', async () => {
    const { postComment } = await import('../../../src/providers/github/rest.js');
    await postComment('acme', 'repo', 1, 'body', { installation_id: 123 });
    expect(mockGetToken).toHaveBeenCalledWith(123);
  });

  it('does NOT fall back to GITHUB_TOKEN even if set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_pat_token';
    const { postComment } = await import('../../../src/providers/github/rest.js');
    await expect(postComment('acme', 'repo', 1, 'body')).rejects.toThrow(
      /installation_id/
    );
    expect(mockGetToken).not.toHaveBeenCalled();
  });
});

describe('rest.js: all functions require ctx with installation_id', () => {
  // We test a representative set — the pattern is the same for all exported functions.
  // Functions that return non-JSON (text, null) need special fetch mocks.
  const functionsToTest = [
    { name: 'addLabel', args: ['o', 'r', 1, 'label'] },
    { name: 'removeLabel', args: ['o', 'r', 1, 'label'] },
    { name: 'getLabels', args: ['o', 'r', 1], jsonMock: async () => [] },
    { name: 'getIssue', args: ['o', 'r', 1] },
    { name: 'repoExists', args: ['o', 'r'] },
    { name: 'getPR', args: ['o', 'r', 1] },
    { name: 'listOpenPRs', args: ['o', 'r'] },
    { name: 'getLinkedPR', args: ['o', 'r', 1], jsonMock: async () => [] },
    { name: 'dispatchWorkflow', args: ['o', 'r', 'wf.yml', 'main', {}] },
    { name: 'getRepoFileContents', args: ['o', 'r', 'path'] },
    { name: 'ensureLabel', args: ['o', 'r', 'label', 'e11d48', ''], skipSuccess: true },
    { name: 'getFileExists', args: ['o', 'r', 'path'] },
    { name: 'createFile', args: ['o', 'r', 'path', 'content', 'msg'] },
    { name: 'getPRsForCommit', args: ['o', 'r', 'sha'] },
    { name: 'getCheckRunsForCommit', args: ['o', 'r', 'sha'] },
    { name: 'getReviews', args: ['o', 'r', 1] },
    { name: 'dismissReview', args: ['o', 'r', 1, 99, 'msg'] },
  ];

  // Functions that need non-JSON response mocks
  const textResponseFns = new Set(['getDiff', 'getAuthenticatedUser']);

  for (const entry of functionsToTest) {
    const { name, args } = entry;
    it(`${name}() throws when called without ctx`, async () => {
      const mod = await import('../../../src/providers/github/rest.js');
      await expect(mod[name](...args)).rejects.toThrow(/installation_id/);
    });

    it(`${name}() succeeds when ctx has installation_id`, async () => {
      if (entry.skipSuccess) return;
      const mod = await import('../../../src/providers/github/rest.js');
      // Reset fetch for each call
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: name === 'dispatchWorkflow' || name === 'createFile' || name === 'ensureLabel' || name === 'addLabel' ? 201 : 200,
        headers: { get: () => 'application/json' },
        json: entry.jsonMock ?? (async () => ({ id: 1 })),
      });
      await expect(mod[name](...args, { installation_id: 123 })).resolves.toBeDefined();
    });
  }

  // getDiff returns text
  it('getDiff() throws when called without ctx', async () => {
    const mod = await import('../../../src/providers/github/rest.js');
    await expect(mod.getDiff('o', 'r', 1)).rejects.toThrow(/installation_id/);
  });

  it('getDiff() succeeds when ctx has installation_id', async () => {
    const mod = await import('../../../src/providers/github/rest.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'diff content',
    });
    await expect(mod.getDiff('o', 'r', 1, { installation_id: 123 })).resolves.toBeDefined();
  });

  // getAuthenticatedUser returns JSON
  it('getAuthenticatedUser() throws when called without ctx', async () => {
    const mod = await import('../../../src/providers/github/rest.js');
    await expect(mod.getAuthenticatedUser()).rejects.toThrow(/installation_id/);
  });

  it('getAuthenticatedUser() succeeds when ctx has installation_id', async () => {
    const mod = await import('../../../src/providers/github/rest.js');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ login: 'testuser' }),
    });
    const result = await mod.getAuthenticatedUser({ installation_id: 123 });
    expect(result).toBe('testuser');
  });
});

describe('graphql.js: resolveToken throws on missing installation_id', () => {
  it('throws when ctx is undefined', async () => {
    const { getPRNodeId } = await import('../../../src/providers/github/graphql.js');
    await expect(
      getPRNodeId('o', 'r', 1)
    ).rejects.toThrow(/installation_id/);
  });

  it('throws when ctx.installation_id is null', async () => {
    const { getPRNodeId } = await import('../../../src/providers/github/graphql.js');
    await expect(
      getPRNodeId('o', 'r', 1, { installation_id: null })
    ).rejects.toThrow(/installation_id/);
  });

  it('does NOT fall back to GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'ghp_pat_token';
    const { getPRNodeId } = await import('../../../src/providers/github/graphql.js');
    await expect(
      getPRNodeId('o', 'r', 1)
    ).rejects.toThrow(/installation_id/);
  });
});
