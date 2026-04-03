import { describe, it, expect } from 'vitest';
import { getAdapter, registerAdapter, WorkQueueAdapter } from '../../src/work-queue/index.js';

describe('Work Queue Registry', () => {
  it('loads github-projects adapter', () => {
    const adapter = getAdapter('github-projects', { projectNodeId: 'test' });
    expect(adapter).toBeInstanceOf(WorkQueueAdapter);
  });

  it('throws on unknown adapter type', () => {
    expect(() => getAdapter('unknown-adapter', {})).toThrow('Unknown work queue adapter: unknown-adapter');
  });

  it('registers custom adapter', () => {
    class CustomAdapter extends WorkQueueAdapter {}
    registerAdapter('custom', CustomAdapter);

    const adapter = getAdapter('custom', {});
    expect(adapter).toBeInstanceOf(CustomAdapter);
  });

  it('preserves adapter config', () => {
    const config = { projectNodeId: 'PVT_123', apiToken: 'secret' };
    const adapter = getAdapter('github-projects', config);
    expect(adapter.config).toEqual(config);
  });
});
