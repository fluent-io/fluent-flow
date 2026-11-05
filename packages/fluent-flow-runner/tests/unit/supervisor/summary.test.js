import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { summarySourceText, nativeCursorEpoch, SummarySourceIncomplete } from '../../../src/supervisor/summary.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '44444444-4444-4444-8444-444444444444';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledgerWith(build) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-summary-source-'));
  dirs.push(dir);
  const ledger = createLedger({ dir });
  build(ledger);
  return ledger;
}

const event = (ledger, sessionId, nativeEventId, kind, payload, { backend = 'claude-code', runId = RUN, generation = 1 } = {}) =>
  ledger.appendEvent({ sessionId, runId, generation, kind, nativeEventId, payload: { backend, event: payload } }).seq;

function history() {
  const seqs = {};
  const ledger = ledgerWith((l) => {
    l.bind({ sessionId: S1, runId: RUN, backend: 'claude-code', nativeSessionId: S1, generation: 1, workspaceDir: '/w' });
    l.bind({ sessionId: S2, runId: OTHER_RUN, backend: 'codex', nativeSessionId: 'thread-2', generation: 1, workspaceDir: '/w2' });
    seqs.first = event(l, S1, 'a1', 'timeline', { type: 'assistant_text', text: 'EARLIER first finding' });
    seqs.other = event(l, S2, 'i1', 'timeline', { phase: 'completed', item: { type: 'agentMessage', text: 'OTHER session text' } }, { backend: 'codex', runId: OTHER_RUN });
    seqs.tool = event(l, S1, 't1', 'timeline', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } });
    seqs.second = event(l, S1, 'a2', 'timeline', { type: 'assistant_text', text: 'EARLIER second finding' });
    seqs.terminal = event(l, S1, 'r1', 'state', { phase: 'result' });
    seqs.later = event(l, S1, 'a3', 'timeline', { type: 'assistant_text', text: 'LATER after the freeze' });
  });
  return { ledger, seqs };
}

describe('summarySourceText (Task 8)', () => {
  it('returns the source session assistant text up to and including the frozen cursor, in ledger order, and nothing after it', async () => {
    const { ledger, seqs } = history();
    const text = await summarySourceText({ ledger, runId: RUN, sessionId: S1, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: seqs.terminal } });
    expect(text).toBe('EARLIER first finding\n\nEARLIER second finding');
    expect(text).not.toContain('LATER');
    expect(text).not.toContain('OTHER');
    const later = await summarySourceText({ ledger, runId: RUN, sessionId: S1, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: seqs.later } });
    expect(later).toBe('EARLIER first finding\n\nEARLIER second finding\n\nLATER after the freeze');
  });

  it('reads codex completed agent messages', async () => {
    const { ledger, seqs } = history();
    await expect(summarySourceText({ ledger, runId: OTHER_RUN, sessionId: S2, sourceCursor: { epoch: nativeCursorEpoch('codex'), seq: seqs.other } })).resolves.toBe('OTHER session text');
  });

  it('keeps one oversized event whole', async () => {
    const big = 'x'.repeat(600 * 1024);
    let seq;
    const ledger = ledgerWith((l) => {
      l.bind({ sessionId: S1, runId: RUN, backend: 'claude-code', nativeSessionId: S1, generation: 1, workspaceDir: '/w' });
      seq = event(l, S1, 'big', 'timeline', { type: 'assistant_text', text: big });
    });
    await expect(summarySourceText({ ledger, runId: RUN, sessionId: S1, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq } })).resolves.toBe(big);
  });

  it.each([
    ['a null cursor', null, 'cursor_invalid'],
    ['a non-integer sequence', { epoch: nativeCursorEpoch('claude-code'), seq: '4' }, 'cursor_invalid'],
    ['a Paseo or foreign cursor domain', { epoch: 'paseo-epoch-1', seq: 4 }, 'cursor_domain_mismatch'],
    ['another backend\'s cursor domain', { epoch: nativeCursorEpoch('codex'), seq: 4 }, 'cursor_domain_mismatch'],
    ['a cursor beyond the recorded history', { epoch: nativeCursorEpoch('claude-code'), seq: 99 }, 'cursor_beyond_history'],
    ['a cursor naming another session\'s event', { epoch: nativeCursorEpoch('claude-code'), seq: 2 }, 'cursor_session_mismatch'],
  ])('refuses %s instead of using all or latest history', async (_name, sourceCursor, reason) => {
    const { ledger } = history();
    const attempt = summarySourceText({ ledger, runId: RUN, sessionId: S1, sourceCursor });
    await expect(attempt).rejects.toBeInstanceOf(SummarySourceIncomplete);
    await expect(attempt).rejects.toMatchObject({ code: 'summary_source_incomplete', reason });
  });

  it('refuses an unknown session, a session of another run and a prefix without assistant text', async () => {
    const { ledger, seqs } = history();
    const cursor = { epoch: nativeCursorEpoch('claude-code'), seq: seqs.terminal };
    await expect(summarySourceText({ ledger, runId: RUN, sessionId: '55555555-5555-4555-8555-555555555555', sourceCursor: cursor })).rejects.toMatchObject({ reason: 'session_unknown' });
    await expect(summarySourceText({ ledger, runId: OTHER_RUN, sessionId: S1, sourceCursor: cursor })).rejects.toMatchObject({ reason: 'session_unknown' });
    const empty = ledgerWith((l) => {
      l.bind({ sessionId: S1, runId: RUN, backend: 'claude-code', nativeSessionId: S1, generation: 1, workspaceDir: '/w' });
      event(l, S1, 't1', 'timeline', { type: 'tool_use', name: 'Bash', input: {} });
    });
    await expect(summarySourceText({ ledger: empty, runId: RUN, sessionId: S1, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: 1 } })).rejects.toMatchObject({ reason: 'no_assistant_text' });
  });
});
