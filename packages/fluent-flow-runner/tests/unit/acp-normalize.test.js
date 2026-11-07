import { describe, expect, it } from 'vitest';
import { createAcpStreamRedactor, normalizeAcpUpdate } from '../../src/acp/normalize.js';

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

  it('redacts decoded terminal output before preserving its base64 wire shape', () => {
    const secret = 'terminal-secret-value';
    const chunk = normalize({
      sessionUpdate: 'terminal_output_chunk',
      terminalId: 'terminal-secret',
      data: Buffer.from(`before ${secret} after`).toString('base64'),
    }, { secretValues: [secret] });
    const snapshot = normalize({
      sessionUpdate: 'terminal_update',
      terminalId: 'terminal-secret',
      output: { data: Buffer.from(`snapshot ${secret}`).toString('base64') },
    }, { secretValues: [secret] });

    expect(Buffer.from(chunk.payload.raw.data, 'base64').toString('utf8')).toBe('before [REDACTED] after');
    expect(Buffer.from(snapshot.payload.raw.output.data, 'base64').toString('utf8')).toBe('snapshot [REDACTED]');
    expect(JSON.stringify([chunk, snapshot])).not.toContain(secret);
  });

  it('redacts secrets split across message and terminal chunks before emitting events', () => {
    const secret = 'split-secret-value';
    const messages = createAcpStreamRedactor([secret]);
    const messageOutput = [
      ...messages.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-secret',
        content: { type: 'text', text: 'prefix split-' },
      }),
      ...messages.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-secret',
        content: { type: 'text', text: 'secret-value suffix' },
      }),
      ...messages.push({ sessionUpdate: 'state_update', state: 'idle' }),
    ];
    expect(messageOutput.filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content.text).join('')).toBe('prefix [REDACTED] suffix');

    const terminal = createAcpStreamRedactor([secret]);
    const terminalOutput = [
      ...terminal.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-secret',
        data: Buffer.from('prefix split-').toString('base64'),
      }),
      ...terminal.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-secret',
        data: Buffer.from('secret-value suffix').toString('base64'),
      }),
      ...terminal.flush(),
    ];
    expect(terminalOutput.map((update) => Buffer.from(update.data, 'base64').toString('utf8')).join(''))
      .toBe('prefix [REDACTED] suffix');
  });

  it.each([
    ['Authorization: Bearer abc', 'defghijkl', 'Authorization: Bearer [REDACTED]'],
    ['key=sk-abcdefgh', 'ijklmnop', 'key=[REDACTED]'],
  ])('redacts a pattern secret split across terminal chunks', (first, second, expected) => {
    const redactor = createAcpStreamRedactor();
    const output = [
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-pattern',
        data: Buffer.from(first).toString('base64'),
      }),
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-pattern',
        data: Buffer.from(second).toString('base64'),
      }),
      ...redactor.flush(),
    ];

    expect(output.map((update) => Buffer.from(update.data, 'base64').toString('utf8')).join(''))
      .toBe(expected);
  });

  it('preserves a UTF-8 character split across terminal chunks', () => {
    const redactor = createAcpStreamRedactor();
    const bytes = Buffer.from('€');
    const output = [
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-utf8',
        data: bytes.subarray(0, 1).toString('base64'),
      }),
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-utf8',
        data: bytes.subarray(1).toString('base64'),
      }),
      ...redactor.flush(),
    ];

    expect(output.map((update) => Buffer.from(update.data, 'base64').toString('utf8')).join('')).toBe('€');
  });

  it('accepts a large stream chunk without spreading it into function arguments', () => {
    const text = `${'x'.repeat(200_000)} `;
    const redactor = createAcpStreamRedactor();
    const output = [
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-large',
        content: { type: 'text', text },
      }),
      ...redactor.flush(),
    ];

    expect(output.map((update) => update.content.text).join('')).toBe(text);
  });

  it('bounds a delimiter-free pattern secret without leaking later chunks', () => {
    const redactor = createAcpStreamRedactor();
    const secret = `sk-${'a'.repeat(300)}`;
    const output = [
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-long-secret',
        content: { type: 'text', text: secret },
      }),
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-long-secret',
        content: { type: 'text', text: 'tail done' },
      }),
      ...redactor.flush(),
    ];

    const text = output.map((update) => update.content.text).join('');
    expect(text).toBe('[REDACTED] done');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('tail');
  });

  it('retains a known-secret prefix while suppressing an oversized pattern token', () => {
    const secret = 'xyz zzz';
    const redactor = createAcpStreamRedactor([secret]);
    const output = [
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-pattern-overlap',
        content: { type: 'text', text: `sk-${'a'.repeat(300)}xyz` },
      }),
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-pattern-overlap',
        content: { type: 'text', text: ' zzz tail' },
      }),
      ...redactor.flush(),
    ];

    expect(output.map((update) => update.content.text).join('')).toBe('[REDACTED] tail');
  });

  it('coalesces adjacent redacted chunks into one marker', () => {
    const redactor = createAcpStreamRedactor(['Q']);
    const output = ['1Q', 'Q'].flatMap((text) => redactor.push({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-adjacent-secrets',
      content: { type: 'text', text },
    }));
    output.push(...redactor.flush());

    expect(output.map((update) => update.content.text).join('')).toBe('1[REDACTED]');
  });

  it('redacts a complete known secret whose suffix repeats its prefix', () => {
    const secret = 'Abcd1234A';
    const redactor = createAcpStreamRedactor([secret]);
    const output = [
      ...redactor.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-overlap',
        content: { type: 'text', text: secret },
      }),
      ...redactor.flush(),
    ];

    expect(output.map((update) => update.content.text).join('')).toBe('[REDACTED]');
  });

  it.each([
    [['ABC', 'CD'], ['AB', 'C', 'D']],
    [['abcd', 'bc'], ['ab', 'c', 'd']],
    [['aba'], ['ab', 'ab', 'a']],
  ])('redacts the union of overlapping known secrets across terminal chunks', (secrets, chunks) => {
    const redactor = createAcpStreamRedactor(secrets);
    const output = chunks.flatMap((text) => redactor.push({
      sessionUpdate: 'terminal_output_chunk',
      terminalId: 'terminal-overlapping-secrets',
      data: Buffer.from(text).toString('base64'),
    }));
    output.push(...redactor.flush());

    expect(output.map((update) => Buffer.from(update.data, 'base64').toString('utf8')).join(''))
      .toBe('[REDACTED]');
  });

  it('does not rescan the redaction marker as a known secret', () => {
    const normalized = normalize({
      sessionUpdate: 'notice',
      level: 'warning',
      message: 'pre ABC post',
    }, { secretValues: ['ABC', 'RED'] });

    expect(normalized.payload.raw.message).toBe('pre [REDACTED] post');
  });

  it('keeps known-secret prefixes isolated across interleaved streams', () => {
    const secret = 'provider-token-123456789';
    const redactor = createAcpStreamRedactor([secret]);
    const output = [
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-a',
        data: Buffer.from('provider-token-').toString('base64'),
      }),
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-b',
        data: Buffer.from('unrelated').toString('base64'),
      }),
      ...redactor.push({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'terminal-a',
        data: Buffer.from('123456789').toString('base64'),
      }),
      ...redactor.flush(),
    ];
    const terminalA = output.filter((update) => update.terminalId === 'terminal-a')
      .map((update) => Buffer.from(update.data, 'base64').toString('utf8')).join('');

    expect(terminalA).toBe('[REDACTED]');
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('emits a chunk immediately when its suffix cannot begin a known secret', () => {
    const redactor = createAcpStreamRedactor(['provider-token-value-123456789']);
    const output = redactor.push({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-visible',
      content: { type: 'text', text: 'Follow-up ACP turn is running.' },
    });

    expect(output).toEqual([{
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-visible',
      content: { type: 'text', text: 'Follow-up ACP turn is running.' },
    }]);
    expect(redactor.flush()).toEqual([]);
  });

  it('rejects payloads larger than the configured event limit', () => {
    expect(() => normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'agent-large',
      content: { type: 'text', text: 'x'.repeat(256) },
    }, { maxPayloadBytes: 64 })).toThrow(/payload|event|64|large/i);
  });
});
