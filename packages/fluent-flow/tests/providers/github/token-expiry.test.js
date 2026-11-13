import { it, expect, vi } from 'vitest';
vi.mock('../../../src/providers/github/app-auth.js', () => ({ fetchInstallationToken: vi.fn() }));
import { fetchInstallationToken } from '../../../src/providers/github/app-auth.js';
import * as cache from '../../../src/providers/github/token-cache.js';
it('delivers the expiry paired with the exact cached token, including single flight', async () => {
  cache.clearTokenCache();
  const expiresAt = new Date(Date.now() + 3600000);
  fetchInstallationToken.mockResolvedValue({ token: 'test-only-token', expiresAt });
  expect(typeof cache.getInstallationCredential).toBe('function');
  const [a, b] = await Promise.all([cache.getInstallationCredential(42), cache.getInstallationCredential(42)]);
  expect(a).toEqual({ token: 'test-only-token', expiresAt });
  expect(b).toEqual(a);
  expect(await cache.getInstallationToken(42)).toBe(a.token);
  expect(fetchInstallationToken).toHaveBeenCalledTimes(1);
});
