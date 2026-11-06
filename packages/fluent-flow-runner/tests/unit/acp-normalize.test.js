import { describe, expect, it } from 'vitest';
import { normalizeAcpUpdate } from '../../src/acp/normalize.js';

function normalize(update, overrides = {}) {
  return normalizeAcpUpdate({
    claimId: 'claim-1',
    sessionId: 'session-1',
    seq: 7,
    update,
    ...overrides,
  });
}

const standardUpdates = [
  ['user_message_chunk', 'user_message', { messageId: 'user-1', content: { type: 'text', text: 'hello' } }],
  ['user_message', 'user_message', { messageId: 'user-1', content: [{ type: 'text', text: 'hello' }] }],
  ['agent_message_chunk', 'agent_message', { messageId: 'agent-1', content: { type: 'text', text: 'answer' } }],
  ['agent_message', 'agent_message', { messageId: 'agent-1', content: [{ type: 'text', text: 'answer' }] }],
  ['agent_thought_chunk', 'agent_thought', { messageId: 'thought-1', content: { type: 'text', text: 'thinking' } }],
  ['agent_thought', 'agent_thought', { messageId: 'thought-1', content: [{ type: 'text', text: 'thinking' }] }],
  ['state_update', 'state', { state: 'running' }],
  ['tool_call_content_chunk', 'tool_output', { toolCallId: 'tool-1', content: { type: 'content', content: { type: 'text', text: 'done' } } }],
  ['tool_call_update', 'tool_call', { toolCallId: 'tool-1', title: 'Read file', status: 'completed' }],
  ['terminal_update', 'terminal', { terminalId: 'terminal-1', title: 'Tests' }],
  ['terminal_output_chunk', 'terminal_output', { terminalId: 'terminal-1', data: 'aGVsbG8=' }],
  ['plan_update', 'plan', { planId: 'plan-1', content: { entries: [{ content: 'Inspect', priority: 'high', status: 'pending' }] } }],
  ['available_commands_update', 'commands', { availableCommands: [{ name: 'review', description: 'Review' }] }],
  ['config_option_update', 'config', { configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'code', options: [] }] }],
  ['session_info_update', 'session_info', { title: 'Review session' }],
  ['usage_update', 'usage', { used: 12, size: 100, cost: { amount: 1, currency: 'USD' } }],
  ['notice', 'notice', { level: 'info', message: 'Working' }],
  ['compaction_update', 'compaction', { compactionId: 'compact-1', status: 'in_progress' }],
  ['compaction_summary_chunk', 'compaction', { compactionId: 'compact-1', content: { type: 'text', text: 'Summary' } }],
];

describe('normalizeAcpUpdate', () => {
  it.each(standardUpdates)('maps standard ACP v2 %s updates to %s', (sessionUpdate, kind, fields) => {
    expect(normalize({ sessionUpdate, ...fields })).toMatchObject({
      seq: 7,
      kind,
      payload: {
        claimId: 'claim-1',
        sessionId: 'session-1',
        raw: { sessionUpdate, ...fields },
      },
    });
  });

  it('gives a chunk received before the full update the same typed entity identity', () => {
    const chunk = normalize({
      sessionUpdate: 'terminal_output_chunk',
      terminalId: 'terminal-9',
      data: 'YQ==',
    });
    const full = normalize({
      sessionUpdate: 'terminal_update',
      terminalId: 'terminal-9',
      title: 'Shell',
    }, { seq: 8 });
    expect(chunk.payload.entity).toEqual({ type: 'terminal', id: 'terminal-9' });
    expect(full.payload.entity).toEqual(chunk.payload.entity);
  });

  it('retains repeated state snapshots without inventing a transition', () => {
    const update = { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' };
    const first = normalize(update);
    const repeated = normalize(update, { seq: 8 });
    expect(first.kind).toBe('state');
    expect(repeated.kind).toBe('state');
    expect(repeated.payload.raw).toEqual(first.payload.raw);
    expect(repeated.seq).toBe(8);
  });

  it('preserves an unknown extension as bounded raw data', () => {
    const update = { sessionUpdate: '_vendor_progress', phase: 'indexing', percent: 40 };
    expect(normalize(update)).toMatchObject({
      seq: 7,
      kind: 'unknown',
      payload: { raw: update },
    });
  });

  it('redacts known authorization, token, key, and live secret values recursively', () => {
    const normalized = normalize({
      sessionUpdate: 'notice',
      level: 'warning',
      message: 'Authorization: Bearer bearer-secret API_KEY=api-secret password=password-secret live-value',
      _meta: {
        access_token: 'token-secret',
        nested: ['live-value', { apiKey: 'key-secret' }],
      },
    }, { secretValues: ['live-value'] });
    const serialized = JSON.stringify(normalized.payload);
    for (const secret of ['bearer-secret', 'api-secret', 'password-secret', 'token-secret', 'key-secret', 'live-value']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
  });

  it('rejects payloads larger than the configured event limit', () => {
    expect(() => normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'agent-large',
      content: { type: 'text', text: 'x'.repeat(256) },
    }, { maxPayloadBytes: 64 })).toThrow(/payload|event|64|large/i);
  });
});
