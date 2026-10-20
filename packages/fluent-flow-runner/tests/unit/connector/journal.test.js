import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../../src/connector/journal.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-journal-'), { mode: 0o700 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const intent = (commandId, runId, sessionId, digest = 'digest-1') => ({
  type: 'intent',
  commandId,
  runId,
  sessionId,
  kind: 'launch',
  payloadDigest: digest,
  recordedAt: '2026-10-19T00:00:00.000Z',
});

describe('durable launch journal', () => {
  it('persists an entry and reloads it in a new journal instance', async () => {
    const j1 = createJournal({ dir });
    await j1.append(intent('cmd-1', 'run-1', 'sess-1'));
    const j2 = createJournal({ dir });
    const loaded = j2.byCommand('cmd-1');
    expect(loaded.intent).toMatchObject({ runId: 'run-1', sessionId: 'sess-1', kind: 'launch' });
  });

  it('creates the journal file with mode 0600 even under a permissive umask', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    const stat = statSync(join(dir, 'journal.jsonl'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('creates the journal directory private (0700) at first use', async () => {
    const nested = join(dir, 'connector-private', 'deeper');
    const j = createJournal({ dir: nested });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it('keeps the file 0600 after subsequent appends', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    await j.append({ type: 'binding', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', workspaceId: 'ws-1', paseoAgentId: 'ag-1', providerSessionId: null });
    expect(statSync(join(dir, 'journal.jsonl')).mode & 0o777).toBe(0o600);
    expect(j.byCommand('cmd-1').binding).toMatchObject({ workspaceId: 'ws-1', paseoAgentId: 'ag-1' });
  });

  it('drops a torn unterminated final line (valid JSON or not) and appends cleanly after it', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    await j.append(intent('cmd-2', 'run-2', 'sess-2'));
    const path = join(dir, 'journal.jsonl');
    const original = readFileSync(path, 'utf8');
    // Crash mid-write: complete JSON of cmd-3 but no newline ever hit disk.
    appendFileSync(path, JSON.stringify(intent('cmd-3', 'run-3', 'sess-3'))); // no \n
    const j2 = createJournal({ dir });
    expect(j2.byCommand('cmd-1').intent).toBeTruthy();
    expect(j2.byCommand('cmd-2').intent).toBeTruthy();
    expect(j2.byCommand('cmd-3')).toBeUndefined();
    await j2.append(intent('cmd-4', 'run-4', 'sess-4'));
    const j3 = createJournal({ dir });
    expect(j3.byCommand('cmd-4').intent).toBeTruthy();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
    expect(original.trim().split('\n')).toHaveLength(2);
  });

  it('drops a torn garbage final line and appends cleanly after it', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    const path = join(dir, 'journal.jsonl');
    appendFileSync(path, '{"type":"intent","commandId":"cmd-3","runI');
    const j2 = createJournal({ dir });
    expect(j2.byCommand('cmd-1').intent).toBeTruthy();
    expect(j2.byCommand('cmd-3')).toBeUndefined();
    await j2.append(intent('cmd-4', 'run-4', 'sess-4'));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });

  it('fails closed on mid-file corruption: no data loss, original file untouched, journal refuses to operate', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    await j.append({ type: 'binding', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', workspaceId: 'ws-1', paseoAgentId: 'ag-1' });
    await j.append(intent('cmd-2', 'run-2', 'sess-2'));
    const path = join(dir, 'journal.jsonl');
    const before = readFileSync(path, 'utf8');
    // Corrupt a MIDDLE line (byte-level flip), leaving a valid-looking tail.
    const lines = before.split('\n');
    lines[1] = lines[1].replace('"ag-1"', 'broken');
    writeFileSync(path, lines.join('\n'));
    expect(() => createJournal({ dir })).toThrow(/corrupt/i);
    // Original file preserved byte-for-byte so nothing is destroyed.
    expect(readFileSync(path, 'utf8')).toBe(lines.join('\n'));
  });

  it('fails closed on an unknown record type in the middle of the file', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    const path = join(dir, 'journal.jsonl');
    appendFileSync(path, JSON.stringify({ type: 'time-travel', commandId: 'x' }) + '\n');
    appendFileSync(path, JSON.stringify(intent('cmd-2', 'run-2', 'sess-2')) + '\n');
    expect(() => createJournal({ dir })).toThrow(/corrupt/i);
  });

  it('latest write wins per record type but full history stays queryable', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    await j.append({ type: 'sent', commandId: 'cmd-1', messageId: 'cmd-1', at: '2026-10-19T00:00:01.000Z' });
    await j.append({ type: 'sent', commandId: 'cmd-1', messageId: 'cmd-1', at: '2026-10-19T00:00:02.000Z' });
    expect(j.byCommand('cmd-1').sent).toHaveLength(2);
  });

  it('writes every byte of a record before fsync (no short-write torn records)', async () => {
    // Big record: force a long line; after append the parsed content must
    // round-trip exactly through a fresh journal instance.
    const j = createJournal({ dir });
    const big = intent('cmd-big', 'run-big', 'sess-big', 'd'.repeat(200_000));
    await j.append(big);
    const j2 = createJournal({ dir });
    expect(j2.byCommand('cmd-big').intent.payloadDigest).toBe('d'.repeat(200_000));
  });

  it('fsyncs file and directory before append returns', async () => {
    const original = fs.fsyncSync;
    let fsyncCalls = 0;
    fs.fsyncSync = (...args) => {
      fsyncCalls += 1;
      return original(...args);
    };
    try {
      const j = createJournal({ dir });
      await j.append(intent('cmd-1', 'run-1', 'sess-1'));
      expect(fsyncCalls).toBeGreaterThanOrEqual(2);
    } finally {
      fs.fsyncSync = original;
    }
  });

  it('unackedCommandIds keeps accepted-but-not-applied and ambiguous commands pending for recovery', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-applied', 'r1', 's1'));
    await j.append({ type: 'acked', commandId: 'cmd-applied', state: 'applied', at: 't' });
    await j.append(intent('cmd-accepted', 'r2', 's2'));
    await j.append({ type: 'acked', commandId: 'cmd-accepted', state: 'accepted', at: 't' });
    await j.append(intent('cmd-ambiguous', 'r3', 's3'));
    await j.append({ type: 'acked', commandId: 'cmd-ambiguous', state: 'ambiguous', errorCode: 'send_timeout', at: 't' });
    await j.append(intent('cmd-failed', 'r4', 's4'));
    await j.append({ type: 'acked', commandId: 'cmd-failed', state: 'failed', errorCode: 'profile_missing', at: 't' });
    await j.append(intent('cmd-noack', 'r5', 's5'));
    expect(j.unackedCommandIds().sort()).toEqual(['cmd-accepted', 'cmd-ambiguous', 'cmd-noack']);
    // Survives reopen identically.
    const j2 = createJournal({ dir });
    expect(j2.unackedCommandIds().sort()).toEqual(['cmd-accepted', 'cmd-ambiguous', 'cmd-noack']);
  });

  it('refuses to append a second intent for the same command id with a different digest', async () => {
    const j = createJournal({ dir });
    await j.append(intent('cmd-1', 'run-1', 'sess-1'));
    await expect(j.append(intent('cmd-1', 'run-1', 'sess-1', 'digest-CHANGED'))).rejects.toThrow(/digest/i);
  });

  it('checkpoints server-confirmed observation acks: restart does not resubmit history', async () => {
    const j = createJournal({ dir });
    await j.append({ type: 'observation', eventId: 'ev-1', commandId: 'c1', runId: 'r1', sessionId: 's1', kind: 'state', payload: { a: 1 }, at: 't' });
    await j.append({ type: 'observation', eventId: 'ev-2', commandId: 'c1', runId: 'r1', sessionId: 's1', kind: 'state', payload: { a: 2 }, at: 't' });
    expect(j.pendingObservationIds()).toEqual(['ev-1', 'ev-2']);
    // Server confirmed ev-1 only (ev-2's HTTP ack was lost).
    await j.markObservationsAccepted(['ev-1']);
    expect(j.pendingObservationIds()).toEqual(['ev-2']);
    // Survives restart identically: no historical resubmission storm.
    const j2 = createJournal({ dir });
    expect(j2.pendingObservationIds()).toEqual(['ev-2']);
    expect(j2.observationById('ev-1')).toBeTruthy(); // record still readable
  });

  it('stores timeline cursors per session for reconnect backfill', async () => {
    const j = createJournal({ dir });
    await j.append({ type: 'cursor', sessionId: 'sess-1', epoch: 'e1', seq: '42' });
    await j.append({ type: 'cursor', sessionId: 'sess-1', epoch: 'e1', seq: '43' });
    const j2 = createJournal({ dir });
    expect(j2.cursor('sess-1')).toEqual({ epoch: 'e1', seq: '43' });
  });

  it('recovers older successful wrapup observations as owned historical Git receipts but rejects failed, foreign and session-only cleanup', async () => {
    const journal = createJournal({ dir });
    await journal.append(intent('launch', 'run', 'session'));
    await journal.append({ type: 'binding', commandId: 'launch', runId: 'run', sessionId: 'session', workspaceId: 'workspace', paseoAgentId: 'agent' });
    const git = { ok: true, headCommit: 'a'.repeat(40), upstream: 'origin/main', uncommitted: 0, untracked: 0, unpushed: 0 };
    const result = { ok: true, phase: 'archive', archivedWorkspace: true, preflight: { owned: true, runId: 'run', workspaceId: 'workspace', blockers: [], git } };
    const at = '2026-10-19T22:20:21.120Z';
    let index = 0;
    for (const invalid of [
      { ...result, ok: false },
      { ...result, archivedWorkspace: false },
      { ...result, preflight: { ...result.preflight, owned: false } },
      { ...result, preflight: { ...result.preflight, workspaceId: 'foreign' } },
      { ...result, preflight: { ...result.preflight, blockers: [{ code: 'sessions_running' }] } },
      { ...result, preflight: { ...result.preflight, git: { ...git, untracked: 1 } } },
    ]) {
      await journal.append({ type: 'observation', eventId: `invalid-${index++}`, kind: 'wrapup', runId: 'run', payload: invalid, at });
      expect(journal.workspaceArchive('run', 'workspace')).toBe(null);
    }
    await journal.append({ type: 'observation', eventId: 'prior-success', kind: 'wrapup', runId: 'run', payload: result, observedAt: at, at });
    expect(createJournal({ dir }).workspaceArchive('run', 'workspace')).toEqual({ workspaceId: 'workspace', archivedAt: at, git });
    expect(journal.workspaceArchive('run', 'foreign')).toBe(null);
    expect(journal.workspaceArchive('other-run', 'workspace')).toBe(null);
  });
});
