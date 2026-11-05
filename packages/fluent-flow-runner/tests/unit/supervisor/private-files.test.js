import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodeFs, { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';


let root;
let dir;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-private-'));
  dir = join(root, 'sup');
  mkdirSync(dir, { mode: 0o700 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const launch = (commandId) => ({ commandId, digest: `d-${commandId}`, runId: 'run-1', sessionId: 'sess-1', backend: 'codex', kind: 'launch' });
const snapshot = (path) => ({ bytes: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 });
const unsafe = { code: 'supervisor_file_unsafe' };
const tryLedger = (opts = {}) => {
  try {
    createLedger({ dir, ...opts }).submit(launch('cmd-1'));
    return 'opened';
  } catch (err) {
    return err;
  }
};

describe('supervisor ledger file safety', () => {
  it('a symlinked ledger is refused and its target is untouched', () => {
    const target = join(root, 'unrelated.txt');
    writeFileSync(target, '', { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, join(dir, 'ledger.jsonl'));
    const before = snapshot(target);
    expect(tryLedger()).toMatchObject(unsafe);
    expect(snapshot(target)).toEqual(before);
    expect(lstatSync(join(dir, 'ledger.jsonl')).isSymbolicLink()).toBe(true);
  });

  it('a symlink to a private 0600 file is refused too, without following it', () => {
    const target = join(root, 'private-target.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, join(dir, 'ledger.jsonl'));
    const before = snapshot(target);
    expect(tryLedger()).toMatchObject(unsafe);
    expect(snapshot(target)).toEqual(before);
  });

  it('a ledger wider than 0600 is refused with its bytes and mode unchanged', () => {
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, `${JSON.stringify({ v: 1, type: 'accept', commandId: 'old', digest: 'd', runId: 'r', sessionId: 's', backend: 'codex', kind: 'launch' })}\n{"torn`);
    chmodSync(path, 0o644);
    const before = snapshot(path);
    expect(tryLedger()).toMatchObject(unsafe);
    expect(snapshot(path)).toEqual(before);
  });

  it('a non-regular ledger path is refused', () => {
    mkdirSync(join(dir, 'ledger.jsonl'), { mode: 0o700 });
    expect(tryLedger()).toMatchObject(unsafe);
  });

  it('a ledger owned by another uid is refused before it is read', () => {
    const path = join(dir, 'ledger.jsonl');
    createLedger({ dir }).submit(launch('cmd-0'));
    const before = snapshot(path);
    const foreign = { ...nodeFs, fstatSync: (fd, ...rest) => Object.assign(nodeFs.fstatSync(fd, ...rest), { uid: process.getuid() + 4242 }) };
    expect(tryLedger({ fs: foreign })).toMatchObject(unsafe);
    expect(snapshot(path)).toEqual(before);
  });

  it('a new ledger is created 0600 and reopens normally', () => {
    createLedger({ dir }).submit(launch('cmd-1'));
    expect(statSync(join(dir, 'ledger.jsonl')).mode & 0o777).toBe(0o600);
    expect(createLedger({ dir }).classify('cmd-1')).toBe('undispatched');
  });
});

describe('unknown versions are rejected before torn-tail repair', () => {
  it('a v2 record followed by a torn tail keeps the exact original bytes', () => {
    const path = join(dir, 'ledger.jsonl');
    createLedger({ dir }).submit(launch('cmd-1'));
    nodeFs.appendFileSync(path, `${JSON.stringify({ v: 2, type: 'accept', commandId: 'x' })}\n{"v":1,"type":"acc`);
    const before = readFileSync(path);
    expect(() => createLedger({ dir })).toThrow(/version/i);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('a valid ledger with a torn tail is still repaired', () => {
    const path = join(dir, 'ledger.jsonl');
    createLedger({ dir }).submit(launch('cmd-1'));
    const good = readFileSync(path, 'utf8');
    nodeFs.appendFileSync(path, '{"v":1,"type":"acc');
    const reopened = createLedger({ dir });
    expect(readFileSync(path, 'utf8')).toBe(good);
    expect(reopened.classify('cmd-1')).toBe('undispatched');
  });
});
