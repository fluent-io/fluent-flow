import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock app-auth module
vi.mock('../../../src/providers/github/app-auth.js', () => ({
  fetchInstallationToken: vi.fn(),
}));

import { fetchInstallationToken } from '../../../src/providers/github/app-auth.js';
import { getInstallationToken, clearTokenCache } from '../../../src/providers/github/token-cache.js';

const mockFetch = /** @type {import('vitest').MockedFunction<typeof fetchInstallationToken>} */ (fetchInstallationToken);

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

describe('getInstallationToken', () => {
  it('fetches token on first call and returns it', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    mockFetch.mockResolvedValueOnce({ token: 'tok-1', expiresAt });

    const token = await getInstallationToken(1);
    expect(token).toBe('tok-1');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns cached token on second call without refetch', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    mockFetch.mockResolvedValue({ token: 'tok-2', expiresAt });

    await getInstallationToken(2);
    await getInstallationToken(2);

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('refetches after TTL expiry', async () => {
    const expiredAt = new Date(Date.now() - 1000); // already expired
    mockFetch
      .mockResolvedValueOnce({ token: 'tok-old', expiresAt: expiredAt })
      .mockResolvedValueOnce({ token: 'tok-new', expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

    const first = await getInstallationToken(3);
    expect(first).toBe('tok-old');

    const second = await getInstallationToken(3);
    expect(second).toBe('tok-new');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls for the same installation_id coalesce to one fetch (single-flight)', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    let resolveFirst;
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
    mockFetch.mockReturnValueOnce(firstPromise);

    // Start 3 concurrent calls before the first resolves
    const p1 = getInstallationToken(4);
    const p2 = getInstallationToken(4);
    const p3 = getInstallationToken(4);

    // Resolve the underlying fetch
    resolveFirst({ token: 'tok-sf', expiresAt });

    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a).toBe('tok-sf');
    expect(b).toBe('tok-sf');
    expect(c).toBe('tok-sf');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
