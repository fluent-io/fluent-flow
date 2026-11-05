import { describe, it, expect } from 'vitest';
import { createSpoolPrivacy } from '../../../src/supervisor/spool-privacy.js';
import { createCodexNormalizeContext, normalizeCodexMessage } from '../../../src/native/codex-normalize.js';

const questionItem = (result) => ({
  kind: 'timeline',
  nativeEventId: 'item:call_a1:completed',
  payload: {
    phase: 'completed', threadId: 'thr_a1', turnId: 'turn_a1',
    item: { type: 'mcpToolCall', id: 'call_a1', server: 'ff_questions', tool: 'ask', status: 'completed', arguments: { questions: [{ id: 'q0', question: 'Pick a color?' }] }, result, error: null },
  },
});
const RESULT = { content: [{ type: 'text', text: '{"answers":{"q0":"WEB_SECRET_VALUE"}}' }] };

describe('spool privacy (Task 7 fix round 1)', () => {
  for (const value of ['a', 'mcpTool', 'ff_q', 'questions', 'call_a1', 'turn_a1']) {
    it(`a registered local value "${value}" overlapping structure never disables explicit answer stripping`, () => {
      const privacy = createSpoolPrivacy();
      privacy.registerLocalValue('s', value);
      const out = privacy.scrub('s', questionItem(RESULT));
      const item = out.payload.item;
      expect(item.result).toBeNull();
      expect(item.resultWithheld).toBe('ff_question_answer');
      expect(JSON.stringify(out)).not.toContain('WEB_SECRET_VALUE');
      expect({ type: item.type, server: item.server, tool: item.tool, id: item.id, status: item.status }).toEqual({ type: 'mcpToolCall', server: 'ff_questions', tool: 'ask', id: 'call_a1', status: 'completed' });
      expect({ phase: out.payload.phase, threadId: out.payload.threadId, turnId: out.payload.turnId, nativeEventId: out.nativeEventId, kind: out.kind }).toEqual({ phase: 'completed', threadId: 'thr_a1', turnId: 'turn_a1', nativeEventId: 'item:call_a1:completed', kind: 'timeline' });
    });
  }

  it('a known local value is still replaced in content text, with no minimum length and no derived hash', () => {
    const privacy = createSpoolPrivacy();
    privacy.registerLocalValue('s', 'x');
    privacy.registerLocalValue('s', 'my local answer');
    const out = privacy.scrub('s', { kind: 'timeline', nativeEventId: 'm1', payload: { type: 'assistant_text', text: 'You said my local answer; x marks it.' } });
    expect(out.payload.text).toBe('You said [local answer]; [local answer] marks it.');
    expect(out.payload.type).toBe('assistant_text');
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{32,}/);
    const asked = privacy.scrub('s', questionItem(null));
    expect(asked.payload.item.arguments.questions[0]).toEqual({ id: 'q0', question: 'Pick a color?' });
  });
});

describe('spool privacy: schema-path metadata only (Task 7 fix round 2)', () => {
  const VALUE = 'SYNTHETIC_LOCAL_VALUE';
  const privacy = () => {
    const p = createSpoolPrivacy();
    p.registerLocalValue('s', VALUE);
    return p;
  };

  it('the reviewed counterexample: argument/result fields named name/id are redacted; the real call id is kept', () => {
    const out = privacy().scrub('s', { kind: 'timeline', nativeEventId: 'item:fixture-call:completed', payload: { phase: 'completed', threadId: 'thr_1', turnId: 'turn_1', item: {
      type: 'mcpToolCall', id: 'fixture-call', server: 'fixture_tool', tool: 'record', status: 'completed',
      arguments: { name: VALUE, nested: { id: VALUE } },
      result: { name: VALUE, text: VALUE },
    } } });
    const item = out.payload.item;
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(item.arguments).toEqual({ name: '[local answer]', nested: { id: '[local answer]' } });
    expect(item.result).toEqual({ name: '[local answer]', text: '[local answer]' });
    expect({ type: item.type, id: item.id, server: item.server, tool: item.tool, status: item.status }).toEqual({ type: 'mcpToolCall', id: 'fixture-call', server: 'fixture_tool', tool: 'record', status: 'completed' });
    expect({ phase: out.payload.phase, threadId: out.payload.threadId, turnId: out.payload.turnId }).toEqual({ phase: 'completed', threadId: 'thr_1', turnId: 'turn_1' });
  });

  it('nested and array content under exempt-looking names is redacted wherever it is not a schema path', () => {
    const out = privacy().scrub('s', { kind: 'timeline', nativeEventId: 'tu-1', payload: { type: 'tool_use', toolUseId: 'toolu_1', name: 'Write', input: { type: VALUE, state: VALUE, list: [{ id: VALUE, kind: VALUE }, VALUE], status: { phase: VALUE } } } });
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect({ type: out.payload.type, toolUseId: out.payload.toolUseId, name: out.payload.name }).toEqual({ type: 'tool_use', toolUseId: 'toolu_1', name: 'Write' });
    const plain = privacy().scrub('s', { kind: 'timeline', nativeEventId: 'x', payload: { type: 'assistant_text', name: VALUE, text: 'ok' } });
    expect(plain.payload.name).toBe('[local answer]');
    const asked = privacy().scrub('s', { kind: 'attention', nativeEventId: 'request:r1', payload: { nativeRequestId: 'r1', kind: 'question', state: 'pending', fingerprint: 'f'.repeat(64), choices: [{ id: 'allow', label: VALUE, behavior: 'allow', scope: null }], questions: [{ id: 'q0', question: VALUE, options: [{ label: VALUE }] }] } });
    expect(JSON.stringify(asked)).not.toContain(VALUE);
    expect({ id: asked.payload.nativeRequestId, kind: asked.payload.kind, state: asked.payload.state, choice: asked.payload.choices[0].id, behavior: asked.payload.choices[0].behavior, q: asked.payload.questions[0].id }).toEqual({ id: 'r1', kind: 'question', state: 'pending', choice: 'allow', behavior: 'allow', q: 'q0' });
  });
});

describe('spool privacy: content member names (Task 7 fix round 3)', () => {
  const VALUE = 'SYNTHETIC_LOCAL_VALUE';
  const OTHER = 'SECOND_LOCAL_VALUE';
  const completed = (item) => {
    const [event] = normalizeCodexMessage({ method: 'item/completed', params: { threadId: 'thr_real', turnId: 'turn_real', item } }, createCodexNormalizeContext({ model: 'm' }));
    return event;
  };
  const base = (args, result) => ({ type: 'mcpToolCall', id: 'fixture-call', server: 'fixture_tool', tool: 'record', status: 'completed', arguments: args, result, error: null });

  it('a registered value as an argument key and a structured-result key is redacted; neighbours and real metadata are kept', () => {
    const p = createSpoolPrivacy();
    p.registerLocalValue('s', VALUE);
    const event = completed(base({ [VALUE]: 'x', name: VALUE, keep: 'plain', nested: { id: VALUE } }, { content: [{ type: 'text', text: VALUE }], structuredContent: { [VALUE]: 'x', other: 1 }, _meta: null }));
    expect(event.nativeEventId).toBe('item:fixture-call:completed');
    const out = p.scrub('s', event);
    expect(JSON.stringify(out)).not.toContain(VALUE);
    const item = out.payload.item;
    expect(item.arguments).toEqual({ '[local answer]': 'x', name: '[local answer]', keep: 'plain', nested: { id: '[local answer]' } });
    expect(item.result).toEqual({ content: [{ type: 'text', text: '[local answer]' }], structuredContent: { '[local answer]': 'x', other: 1 }, _meta: null });
    expect({ type: item.type, id: item.id, server: item.server, tool: item.tool, status: item.status }).toEqual({ type: 'mcpToolCall', id: 'fixture-call', server: 'fixture_tool', tool: 'record', status: 'completed' });
    expect({ phase: out.payload.phase, threadId: out.payload.threadId, turnId: out.payload.turnId, nativeEventId: out.nativeEventId }).toEqual({ phase: 'completed', threadId: 'thr_real', turnId: 'turn_real', nativeEventId: 'item:fixture-call:completed' });
  });

  it('colliding redacted names never overwrite or drop a field silently: the affected content object is explicitly withheld', () => {
    const p = createSpoolPrivacy();
    p.registerLocalValue('s', VALUE);
    p.registerLocalValue('s', OTHER);
    const two = p.scrub('s', completed(base({ [VALUE]: 1, [OTHER]: 2, sibling: 'kept' }, null)));
    expect(two.payload.item.arguments).toEqual({ withheld: 'local_answer_key_collision' });
    const existing = p.scrub('s', completed(base({ '[local answer]': 'original', [VALUE]: 'x' }, null)));
    expect(existing.payload.item.arguments).toEqual({ withheld: 'local_answer_key_collision' });
    for (const out of [two, existing]) {
      expect(JSON.stringify(out)).not.toMatch(/SYNTHETIC_LOCAL_VALUE|SECOND_LOCAL_VALUE/);
      expect({ id: out.payload.item.id, type: out.payload.item.type, turnId: out.payload.turnId }).toEqual({ id: 'fixture-call', type: 'mcpToolCall', turnId: 'turn_real' });
    }
  });

  it('schema member names that happen to contain a short registered value are not rewritten', () => {
    const p = createSpoolPrivacy();
    p.registerLocalValue('s', 't');
    const out = p.scrub('s', completed(base({ t: 'x' }, null)));
    expect(Object.keys(out.payload).sort()).toEqual(['item', 'phase', 'threadId', 'turnId']);
    expect(Object.keys(out.payload.item)).toEqual(['type', 'id', 'server', 'tool', 'status', 'arguments', 'result', 'error']);
    expect(out.payload.item.arguments).toEqual({ '[local answer]': 'x' });
  });
});
