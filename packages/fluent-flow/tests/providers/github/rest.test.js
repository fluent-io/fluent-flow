import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the token cache so we can verify the token is used
vi.mock('../../../src/providers/github/token-cache.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('installation-token-xyz'),
}));

import { getInstallationToken } from '../../../src/providers/github/token-cache.js';
import { postComment } from '../../../src/providers/github/rest.js';

const mockGetToken = /** @type {import('vitest').MockedFunction<typeof getInstallationToken>} */ (getInstallationToken);

beforeEach(() => {
  vi.clearAllMocks();
  // Mock global fetch
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ id: 1, body: 'hi' }),
  });
});

describe('postComment with installation_id', () => {
  it('calls getInstallationToken and uses the token in Authorization header', async () => {
    await postComment('acme', 'repo', 5, 'hello', { installation_id: 123 });

    expect(mockGetToken).toHaveBeenCalledWith(123);

    const fetchCall = global.fetch.mock.calls[0];
    const [url, opts] = fetchCall;
    expect(url).toContain('/repos/acme/repo/issues/5/comments');
    expect(opts.headers.Authorization).toBe('Bearer installation-token-xyz');
  });
});
