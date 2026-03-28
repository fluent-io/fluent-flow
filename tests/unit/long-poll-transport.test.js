import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { send, enqueue, dequeue, hasPending, clearQueue } = await import('../../src/notifications/transports/long-poll.js');

describe('long-poll transport', () => {
  afterEach(() => { clearQueue(); });

  describe('send', () => {
    it('enqueues payload keyed by session_id', async () => {
      await send({}, { agentId: 'a1', session_id: 5, message: 'fix it' });
      expect(hasPending(5)).toBe(true);
    });

    it('warns if no session_id in payload', async () => {
      await send({}, { agentId: 'a1' });
      expect(hasPending(undefined)).toBe(false);
    });
  });

  describe('dequeue', () => {
    it('returns and removes the queued payload', () => {
      enqueue(5, { message: 'fix it' });
      const payload = dequeue(5);
      expect(payload.message).toBe('fix it');
      expect(hasPending(5)).toBe(false);
    });

    it('returns null if nothing queued', () => {
      expect(dequeue(999)).toBeNull();
    });
  });

  describe('enqueue', () => {
    it('queues multiple payloads in FIFO order', () => {
      enqueue(5, { attempt: 1 });
      enqueue(5, { attempt: 2 });
      expect(dequeue(5).attempt).toBe(1);
      expect(dequeue(5).attempt).toBe(2);
      expect(dequeue(5)).toBeNull();
    });
  });
});
