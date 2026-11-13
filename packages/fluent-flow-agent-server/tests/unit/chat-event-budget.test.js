import { it, expect } from 'vitest';
it('bounds future verbose events, emits one immutable marker and reserves terminal/security capacity', async () => {
  const { createChatEventBudget } = await import('../../src/chat-event-budget.js');
  const budget = createChatEventBudget({ totalBytes: 16000, reserveBytes: 6000 });
  const first = { kind: 'agent_message', payload: { text: 'x'.repeat(2500) } };
  expect(budget.admit(first)).toBe('keep');
  const snapshot = structuredClone(first);
  expect(budget.admit(first)).toBe('truncate');
  expect(budget.admit(first)).toBe('drop');
  expect(first).toEqual(snapshot);
  expect(budget.admit({ kind: 'state', payload: { raw: { state: 'idle' } } })).toBe('keep');
  expect(budget.admit({ kind: 'user_message', payload: { text: 'critical prompt' } })).toBe('keep');
  for (let i = 0; i < 100; i++) budget.admit(first);
  expect(budget.bytes).toBeLessThanOrEqual(16000);
});
