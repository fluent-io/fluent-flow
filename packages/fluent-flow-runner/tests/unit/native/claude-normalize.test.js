import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeClaudeEvent } from '../../../src/native/claude-normalize.js';

const transcripts = JSON.parse(readFileSync(new URL('./fixtures/claude-2.1.317-transcripts.json', import.meta.url), 'utf8'));

function normalizeAll(events, ctx = {}) {
  return events.flatMap((event) => normalizeClaudeEvent(event, ctx));
}

const resultOf = (events) => events.find((e) => e.type === 'result');

describe('normalizeClaudeEvent', () => {
  it('the 2.1.317 transcript yields ordered timeline items with stable ids', () => {
    const first = normalizeAll(transcripts.toolTurn);
    const second = normalizeAll(structuredClone(transcripts.toolTurn));
    const timeline = first.filter((e) => e.kind === 'timeline');
    const replay = transcripts.toolTurn.find((e) => e.type === 'user' && e.isReplay);

    expect(timeline.map((e) => e.payload.type)).toEqual(['user_message', 'tool_use', 'tool_result', 'assistant_delta', 'assistant_text']);
    expect(timeline[0].payload.text).toBe('go');
    expect(timeline[0].receiptFor).toBe(replay.uuid);
    expect(timeline[1].payload).toMatchObject({ name: 'Bash', input: { command: 'echo hi', description: 'say hi' }, toolUseId: 'toolu_t1_1' });
    expect(timeline[2].payload).toMatchObject({ toolUseId: 'toolu_t1_1', isError: false });
    expect(timeline[3].payload.text).toBe('done');
    expect(timeline[4].payload.text).toBe('done');

    const ids = first.map((e) => e.nativeEventId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.map((e) => e.nativeEventId)).toEqual(ids);
  });

  it('usage keeps per-model samples, null for unknown, cost flagged estimate', () => {
    const result = resultOf(transcripts.toolTurn);
    const usage = normalizeAll([result]).filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].payload.samples).toEqual([
      {
        model: 'ff-probe-model',
        inputTokens: 2,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cost: { amount: result.modelUsage['ff-probe-model'].costUSD, currency: 'USD', estimate: true },
      },
    ]);

    const partial = structuredClone(result);
    partial.uuid = 'partial-result';
    partial.modelUsage = { 'model-a': { inputTokens: 5 }, 'model-b': { outputTokens: 7, costUSD: 0.5 } };
    const [partialUsage] = normalizeAll([partial]).filter((e) => e.kind === 'usage');
    expect(partialUsage.payload.samples).toEqual([
      { model: 'model-a', inputTokens: 5, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, cost: null },
      { model: 'model-b', inputTokens: null, outputTokens: 7, cacheReadInputTokens: null, cacheCreationInputTokens: null, cost: { amount: 0.5, currency: 'USD', estimate: true } },
    ]);

    const [unknown] = normalizeAll([resultOf(transcripts.missingModel)]).filter((e) => e.kind === 'usage');
    expect(unknown.payload.samples).toBeNull();
  });

  it('an is_error result is terminal failed', () => {
    const missing = normalizeAll(transcripts.missingModel).filter((e) => e.terminal);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ kind: 'state', terminal: 'failed', payload: { errorCode: 'profile_unavailable' } });

    const success = resultOf(transcripts.toolTurn);
    const isError = { ...success, uuid: 'is-error', is_error: true };
    const subtypeError = { ...success, uuid: 'subtype-error', subtype: 'error_max_turns' };
    for (const result of [isError, subtypeError]) {
      const [terminal] = normalizeAll([result]).filter((e) => e.terminal);
      expect(terminal.terminal).toBe('failed');
      expect(terminal.payload.errorCode).not.toBe('profile_unavailable');
    }
    const [completed] = normalizeAll([success]).filter((e) => e.terminal);
    expect(completed.terminal).toBe('completed');
  });

  it('explicit native failure evidence wins over an outstanding interrupt, and only native abort evidence is interrupted', () => {
    const missing = normalizeAll(transcripts.missingModel, { interruptRequested: true }).filter((e) => e.terminal);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ terminal: 'failed', payload: { errorCode: 'profile_unavailable' } });

    const success = resultOf(transcripts.toolTurn);
    const apiError = { ...success, uuid: 'api-error', is_error: true, terminal_reason: 'api_error' };
    const [failed] = normalizeAll([apiError], { interruptRequested: true }).filter((e) => e.terminal);
    expect(failed.terminal).toBe('failed');

    for (const terminal_reason of ['aborted_streaming', 'aborted_tools']) {
      const aborted = { ...success, uuid: `aborted-${terminal_reason}`, is_error: true, subtype: 'error_during_execution', terminal_reason };
      const [interrupted] = normalizeAll([aborted], {}).filter((e) => e.terminal);
      expect(interrupted.terminal, terminal_reason).toBe('interrupted');
    }
  });

  it('a usage_limit_reached refusal is account_limited; a generic rate limit or other API error is not', () => {
    const base = transcripts.missingModel.find((e) => e.type === 'assistant');
    const result = resultOf(transcripts.missingModel);
    const turn = (fields) => normalizeAll([{ ...structuredClone(base), uuid: `a-${JSON.stringify(fields).length}`, error: 'rate_limit', is_api_error_message: true, ...fields }, { ...result, uuid: 'r-limit' }], {});
    const limited = turn({ api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793900000, isUsingOverage: false } } });
    const [terminal] = limited.filter((e) => e.terminal);
    expect(terminal).toMatchObject({ kind: 'state', terminal: 'account_limited', payload: { errorCode: 'account_limited' } });
    expect(JSON.stringify(limited)).not.toContain('five_hour');
    for (const fields of [
      {},
      { apiErrorIsTransient: true },
      { api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'allowed_warning' } } },
      { api_error: 'long_context_credits_required' },
      { error: 'overloaded' },
      { error: 'billing_error' },
    ]) {
      const [other] = turn(fields).filter((e) => e.terminal);
      expect(other.terminal, JSON.stringify(fields)).toBe('failed');
      expect(other.payload.errorCode, JSON.stringify(fields)).not.toBe('account_limited');
    }
  });

  it('a rate_limit_event is nonterminal evidence with only its status and limit type', () => {
    const [event] = normalizeAll([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793900000, utilization: 1, overageStatus: 'rejected' }, uuid: 'rl-1', session_id: 's' }]);
    expect(event).toEqual({ kind: 'state', nativeEventId: 'rl-1', payload: { phase: 'rate_limit', status: 'rejected', rateLimitType: 'five_hour' } });
    expect(event.terminal).toBeUndefined();
    expect(normalizeAll([{ type: 'rate_limit_event', rate_limit_info: { status: 7 }, uuid: 'rl-2' }])).toEqual([]);
  });
});
