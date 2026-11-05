import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createCommandBarrier, answerBarrierRef } from '../../../src/supervisor/backend-contract.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-barrier-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const barriers = () => (existsSync(join(dir, 'ledger.jsonl'))
  ? readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'barrier')
  : []);
const accept = (ledger, commandId, kind = 'prompt') => ledger.submit({ commandId, digest: `d-${commandId}`, runId: 'run-1', sessionId: 'sess-1', backend: 'codex', kind });

describe('per-call command barriers', () => {
  it('two commands on one retained worker never share a barrier', async () => {
    const ledger = createLedger({ dir });
    accept(ledger, 'cmd-launch', 'launch');
    accept(ledger, 'cmd-steer');
    accept(ledger, 'cmd-stop', 'interrupt');
    const first = createCommandBarrier({ ledger, commandId: 'cmd-launch', effect: 'prompt', generation: 2 });
    const second = createCommandBarrier({ ledger, commandId: 'cmd-steer', effect: 'prompt', generation: 2 });
    const stop = createCommandBarrier({ ledger, commandId: 'cmd-stop', effect: 'interrupt', generation: 2 });
    await first({ turn: 1 });
    await second({ turn: 2 });
    await stop({});
    expect(barriers().map((b) => [b.commandId, b.effect, b.generation])).toEqual([
      ['cmd-launch', 'prompt', 2], ['cmd-steer', 'prompt', 2], ['cmd-stop', 'interrupt', 2],
    ]);
    expect(ledger.classify('cmd-steer')).toEqual({ prompt: 'uncertain' });
  });

  it('a barrier is single-use, also after a failure, and a failure writes nothing', async () => {
    const ledger = createLedger({ dir });
    accept(ledger, 'cmd-1');
    const once = createCommandBarrier({ ledger, commandId: 'cmd-1', effect: 'prompt', generation: 1 });
    await once({});
    await expect(once({})).rejects.toThrow(/single-use/);
    const unaccepted = createCommandBarrier({ ledger, commandId: 'cmd-never-accepted', effect: 'prompt', generation: 1 });
    await expect(unaccepted({})).rejects.toThrow(/never accepted/);
    await expect(unaccepted({})).rejects.toThrow(/single-use/);
    expect(barriers()).toHaveLength(1);
  });

  it('only prompt, respond and interrupt get per-call barriers, and a ref cannot substitute identity', async () => {
    const ledger = createLedger({ dir });
    accept(ledger, 'cmd-1');
    for (const effect of ['create_native_session', 'create_worktree', 'bogus']) {
      expect(() => createCommandBarrier({ ledger, commandId: 'cmd-1', effect, generation: 1 })).toThrow(/prompt, respond or interrupt/);
    }
    expect(() => createCommandBarrier({ ledger, commandId: 'cmd-1', effect: 'prompt', generation: 0 })).toThrow(/generation/);
    for (const key of ['commandId', 'effect', 'generation']) {
      const barrier = createCommandBarrier({ ledger, commandId: 'cmd-1', effect: 'prompt', generation: 1 });
      await expect(barrier({ [key]: 'other' })).rejects.toThrow(/identity/);
    }
    expect(barriers()).toHaveLength(0);
  });

  it('respond refs carry typed request metadata only, never an answer value or hash', async () => {
    const ledger = createLedger({ dir });
    const bad = [
      { nativeRequestId: 'q1', source: 'web', answer: 'yes' },
      { nativeRequestId: 'q1', source: 'web', answerHash: 'ab' },
      { nativeRequestId: 'q1', source: 'web', selections: { a: 1 } },
      { nativeRequestId: 'q1', source: 'browser' },
      { nativeRequestId: 'q1', source: 'web', requestKind: 'other' },
      { nativeRequestId: 'q1', source: 'web', fingerprint: 'not-a-request-hash' },
      { nativeRequestId: 'q1', source: 'web', operation: 'answer-with:yes' },
      { nativeRequestId: 7, source: 'web' },
      { source: 'web' },
    ];
    for (const [i, ref] of bad.entries()) {
      accept(ledger, `cmd-bad-${i}`, 'permission');
      const barrier = createCommandBarrier({ ledger, commandId: `cmd-bad-${i}`, effect: 'respond', generation: 1 });
      await expect(barrier(ref)).rejects.toThrow(/metadata/);
    }
    accept(ledger, 'cmd-ok', 'permission');
    await createCommandBarrier({ ledger, commandId: 'cmd-ok', effect: 'respond', generation: 1 })({ nativeRequestId: 'perm-1', source: 'local', requestKind: 'permission', responseId: 'r-1' });
    expect(barriers()).toHaveLength(1);
  });

  it('a Codex question answer_barrier record becomes the same respond barrier with typed metadata only', async () => {
    const ledger = createLedger({ dir });
    accept(ledger, 'cmd-answer', 'question_answer');
    const fingerprint = 'a'.repeat(64);
    const record = { type: 'answer_barrier', responseId: 'resp-1', requestId: 'req-1', fingerprint, generation: 3, source: 'web', operation: 'answer' };
    const ref = answerBarrierRef(record);
    expect(ref).toEqual({ nativeRequestId: 'req-1', responseId: 'resp-1', source: 'web', requestKind: 'question', fingerprint, operation: 'answer' });
    await createCommandBarrier({ ledger, commandId: 'cmd-answer', effect: 'respond', generation: 3 })(ref);
    const [stored] = barriers();
    expect(stored).toMatchObject({ commandId: 'cmd-answer', effect: 'respond', generation: 3, ref });
    expect(JSON.stringify(stored)).not.toMatch(/selected|answers|other/);
    expect(() => answerBarrierRef({ ...record, answers: { q: 'x' } })).toThrow(/metadata/);
    expect(() => answerBarrierRef({ ...record, type: 'answer_written' })).toThrow(/answer_barrier/);
  });
});
