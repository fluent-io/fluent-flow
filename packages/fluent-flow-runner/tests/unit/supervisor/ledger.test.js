import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodeFs, { mkdtempSync, rmSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, LedgerDigestMismatch, LedgerAdmissionStopped } from '../../../src/supervisor/ledger.js';
import { openEffects } from '../../../src/supervisor/backend-contract.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-ledger-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const launch = (commandId = 'cmd-1', digest = 'd-1') =>
  ({ commandId, digest, runId: 'run-1', sessionId: 'sess-1', backend: 'claude-code', kind: 'launch' });
const records = () => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('supervisor ledger', () => {
  it('the same commandId and digest returns the recorded state without a second barrier', () => {
    const ledger = createLedger({ dir });
    expect(ledger.submit(launch())).toEqual({ state: 'new' });
    ledger.barrier('cmd-1', { effect: 'prompt', generation: 1, ref: { turn: 1 } });
    ledger.outcome('cmd-1', { state: 'applied' });
    expect(ledger.submit(launch())).toEqual({ state: 'applied' });
    const reopened = createLedger({ dir });
    expect(reopened.submit(launch())).toEqual({ state: 'applied' });
    expect(records().filter((r) => r.type === 'barrier')).toHaveLength(1);
    expect(records().filter((r) => r.type === 'accept')).toHaveLength(1);
    expect(records().every((r) => r.v === 1)).toBe(true);
    expect(statSync(join(dir, 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('another digest is rejected', () => {
    const ledger = createLedger({ dir });
    ledger.submit(launch());
    expect(() => ledger.submit(launch('cmd-1', 'd-CHANGED'))).toThrow(LedgerDigestMismatch);
    expect(() => createLedger({ dir }).submit(launch('cmd-1', 'd-CHANGED'))).toThrow(LedgerDigestMismatch);
    expect(records().filter((r) => r.type === 'accept')).toHaveLength(1);
  });

  it('after reopen, accept-only is undispatched and each effect barrier without its receipt or bind is uncertain', () => {
    const ledger = createLedger({ dir });
    ledger.submit(launch('cmd-accepted'));
    ledger.submit(launch('cmd-launch'));
    ledger.barrier('cmd-launch', { effect: 'create_worktree', generation: 1, ref: { path: '/w' } });
    ledger.receipt('cmd-launch', { effect: 'create_worktree', evidence: { created: true } });
    ledger.barrier('cmd-launch', { effect: 'create_native_session', generation: 1, ref: {} });
    ledger.bind({ sessionId: 'sess-1', runId: 'run-1', backend: 'claude-code', nativeSessionId: 'n-1', generation: 1, workspaceDir: '/w' });
    ledger.barrier('cmd-launch', { effect: 'prompt', generation: 1, ref: {} });
    for (const [id, effect] of [['cmd-respond', 'respond'], ['cmd-interrupt', 'interrupt'], ['cmd-unbound', 'create_native_session']]) {
      ledger.submit({ ...launch(id), sessionId: id === 'cmd-unbound' ? 'sess-2' : 'sess-1' });
      ledger.barrier(id, { effect, generation: 1, ref: effect === 'respond' ? { nativeRequestId: 'q1', source: 'web' } : {} });
    }
    const reopened = createLedger({ dir });
    expect(reopened.classify('cmd-accepted')).toBe('undispatched');
    expect(reopened.classify('cmd-launch')).toEqual({ create_worktree: 'receipted', create_native_session: 'receipted', prompt: 'uncertain' });
    expect(reopened.classify('cmd-respond')).toEqual({ respond: 'uncertain' });
    expect(reopened.classify('cmd-interrupt')).toEqual({ interrupt: 'uncertain' });
    expect(reopened.classify('cmd-unbound')).toEqual({ create_native_session: 'uncertain' });
  });

  it('a create_native_session barrier is never repeated automatically', () => {
    const ledger = createLedger({ dir });
    ledger.submit(launch());
    ledger.barrier('cmd-1', { effect: 'create_native_session', generation: 1, ref: {} });
    expect(() => ledger.barrier('cmd-1', { effect: 'create_native_session', generation: 1, ref: {} })).toThrow(/barrier/i);
    const reopened = createLedger({ dir });
    expect(() => reopened.barrier('cmd-1', { effect: 'create_native_session', generation: 2, ref: {} })).toThrow(/barrier/i);
    expect(records().filter((r) => r.type === 'barrier')).toHaveLength(1);
  });

  it('a worker intent without identity is reported for recovery', () => {
    const ledger = createLedger({ dir });
    ledger.recordWorkerIntent({ sessionId: 'sess-1', runId: 'run-1', backend: 'codex', generation: 1, cgroupPath: '/cg/ff-x/w-1-sess-1' });
    ledger.recordWorkerIntent({ sessionId: 'sess-2', runId: 'run-1', backend: 'codex', generation: 1, cgroupPath: '/cg/ff-x/w-1-sess-2' });
    const identity = { pid: 10, startTicks: 99, bootId: 'b', pgid: 10, cgroup: '/x' };
    ledger.recordWorker({ sessionId: 'sess-2', generation: 1, identity });
    const workers = createLedger({ dir }).workers();
    expect(workers).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', generation: 1, identity: null, needsRecovery: true, cgroupPath: '/cg/ff-x/w-1-sess-1' }),
      expect.objectContaining({ sessionId: 'sess-2', generation: 1, identity, needsRecovery: false }),
    ]);
  });

  it('an injected ENOSPC on fsync sets admissionStopped, rejects later submits and leaves the file intact', () => {
    let armed = false;
    const fs = { ...nodeFs, fsyncSync: (fd) => {
      if (armed) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return nodeFs.fsyncSync(fd);
    } };
    const ledger = createLedger({ dir, fs });
    ledger.submit(launch('cmd-1'));
    const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    armed = true;
    expect(() => ledger.submit(launch('cmd-2'))).toThrow(/ENOSPC/);
    expect(ledger.admissionStopped).toBe(true);
    armed = false;
    expect(() => ledger.submit(launch('cmd-3'))).toThrow(LedgerAdmissionStopped);
    expect(() => ledger.barrier('cmd-1', { effect: 'prompt', generation: 1, ref: {} })).toThrow(LedgerAdmissionStopped);
    const after = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).not.toContain('cmd-3');
    const reopened = createLedger({ dir });
    expect(reopened.classify('cmd-1')).toBe('undispatched');
  });

  it('a record with an unknown version fails closed and preserves the file', () => {
    const ledger = createLedger({ dir });
    ledger.submit(launch());
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ v: 2, type: 'accept', commandId: 'x' })}\n`);
    const raw = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(() => createLedger({ dir })).toThrow(/version/i);
    expect(readFileSync(join(dir, 'ledger.jsonl'), 'utf8')).toBe(raw);
  });

  it('a respond barrier carries request metadata only, never an answer value or hash', () => {
    const ledger = createLedger({ dir });
    ledger.submit({ ...launch('cmd-r'), kind: 'permission' });
    expect(() => ledger.barrier('cmd-r', { effect: 'respond', generation: 1, ref: { nativeRequestId: 'q1', answer: 'yes' } })).toThrow(/metadata/i);
    expect(() => ledger.barrier('cmd-r', { effect: 'respond', generation: 1, ref: { nativeRequestId: 'q1', answerHash: 'abc' } })).toThrow(/metadata/i);
    ledger.barrier('cmd-r', { effect: 'respond', generation: 1, ref: { nativeRequestId: 'q1', source: 'web' } });
    expect(records().filter((r) => r.type === 'barrier')).toHaveLength(1);
  });

  it('open() effects are bound to the opening command and only barrier create_native_session once', async () => {
    const ledger = createLedger({ dir });
    ledger.submit(launch('cmd-open'));
    const effects = openEffects({ ledger, commandId: 'cmd-open', sessionId: 'sess-1', runId: 'run-1', backend: 'codex', generation: 1, workspaceDir: '/w' });
    for (const effect of ['prompt', 'respond', 'interrupt', 'create_worktree']) {
      await expect(effects.barrier(effect, {})).rejects.toThrow(/create_native_session/);
    }
    await effects.barrier('create_native_session', {});
    await expect(effects.barrier('create_native_session', {})).rejects.toThrow(/never repeated/);
    await effects.bind('thread-1');
    await expect(effects.bind('thread-2')).rejects.toThrow(/once/);
    expect(ledger.classify('cmd-open')).toEqual({ create_native_session: 'receipted' });
    expect(records().filter((r) => r.type === 'barrier').map((r) => [r.commandId, r.effect])).toEqual([['cmd-open', 'create_native_session']]);
  });
});
