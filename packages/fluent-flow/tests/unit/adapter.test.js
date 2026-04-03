import { describe, it, expect } from 'vitest';
import { WorkQueueAdapter } from '../../src/work-queue/adapter.js';

describe('WorkQueueAdapter', () => {
  it('throws on unimplemented createTestFailureItem', async () => {
    const adapter = new WorkQueueAdapter({});
    await expect(adapter.createTestFailureItem({})).rejects.toThrow('createTestFailureItem not implemented');
  });

  it('throws on unimplemented updateWorkItemState', async () => {
    const adapter = new WorkQueueAdapter({});
    await expect(adapter.updateWorkItemState({})).rejects.toThrow('updateWorkItemState not implemented');
  });

  it('throws on unimplemented getPendingWorkItems', async () => {
    const adapter = new WorkQueueAdapter({});
    await expect(adapter.getPendingWorkItems('agent-id')).rejects.toThrow('getPendingWorkItems not implemented');
  });

  it('throws on unimplemented acknowledgeWorkItem', async () => {
    const adapter = new WorkQueueAdapter({});
    await expect(adapter.acknowledgeWorkItem(42)).rejects.toThrow('acknowledgeWorkItem not implemented');
  });

  it('stores config in constructor', () => {
    const config = { projectId: 'test-123' };
    const adapter = new WorkQueueAdapter(config);
    
    expect(adapter.config).toEqual(config);
  });
});
