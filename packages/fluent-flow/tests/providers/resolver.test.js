import { describe, it, expect } from 'vitest';
import { getProvider } from '../../src/providers/index.js';

describe('getProvider', () => {
  it('returns a ProviderClient for provider=github with expected methods', () => {
    const client = getProvider({ provider: 'github', installation_id: 1 });
    expect(typeof client.postComment).toBe('function');
    expect(typeof client.createCheckRun).toBe('function');
    expect(typeof client.updateCheckRun).toBe('function');
    expect(typeof client.postReview).toBe('function');
    expect(typeof client.listOpenPRs).toBe('function');
    expect(typeof client.getPR).toBe('function');
    expect(typeof client.getDiff).toBe('function');
    expect(typeof client.verifyWebhook).toBe('function');
    expect(typeof client.parseWebhookEvent).toBe('function');
  });

  it('defaults to github when no provider is specified', () => {
    const client = getProvider({ installation_id: 1 });
    expect(typeof client.postComment).toBe('function');
  });

  it('throws on unknown provider', () => {
    expect(() => getProvider({ provider: 'gitlab' })).toThrow(/unsupported provider/i);
  });
});
