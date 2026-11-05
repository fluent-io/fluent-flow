import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodeFs, { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { killContainment, readContainment } from '../../../src/supervisor/containment.js';
import { readProcessIdentity } from '../../../src/supervisor/process-identity.js';


let root;
let scope;
let otherScope;
let ledger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-stop-'));
  scope = join(root, 'cg', 'ff-1111111111111111');
  otherScope = join(root, 'cg', 'ff-2222222222222222');
  mkdirSync(scope, { recursive: true });
  mkdirSync(otherScope, { recursive: true });
  mkdirSync(join(root, 'sup'), { mode: 0o700 });
  ledger = createLedger({ dir: join(root, 'sup') });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function leaf(dir, name, populated = true) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'cgroup.procs'), '');
  writeFileSync(join(path, 'cgroup.events'), `populated ${populated ? 1 : 0}\nfrozen 0\n`);
  writeFileSync(join(path, 'cgroup.kill'), '');
  return path;
}
const killed = (path) => readFileSync(join(path, 'cgroup.kill'), 'utf8');
const worker = (sessionId, generation, cgroupPath, identity) => {
  ledger.recordWorkerIntent({ sessionId, runId: 'run-1', backend: 'codex', generation, cgroupPath });
  if (identity) ledger.recordWorker({ sessionId, generation, identity });
};
const handlers = (containment) => createSupervisorHandlers({ ledger, profiles: [], backends: {}, containment, log: () => {} });
const verified = () => ({ state: 'verified', scopePath: scope });
const current = async () => ({ ...(await readProcessIdentity(process.pid)), pgid: 0, cgroup: '/x' });
const dead = async () => ({ ...(await current()), startTicks: 1 });

describe('stop authorizes destructive cgroup writes only for exact owned worker leaves', () => {
  it('another instance scope is never written, even with a current identity', async () => {
    const foreign = leaf(otherScope, 'w-1-s');
    const sameName = leaf(scope, 'w-1-s');
    worker('s', 1, foreign, await current());
    expect(await handlers(verified()).stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'uncertain' });
    expect([killed(foreign), killed(sameName)]).toEqual(['', '']);
    await expect(killContainment({ cgroupPath: foreign, scopePath: scope, generation: 1, sessionId: 's' })).rejects.toThrow();
    expect(killed(foreign)).toBe('');
  });

  it('a stale boot, a mismatched generation or a symlinked alias is uncertain without a write', async () => {
    const stale = leaf(scope, 'w-1-stale');
    worker('stale', 1, stale, { ...(await current()), bootId: 'previous-boot' });
    const mismatched = leaf(scope, 'w-1-gen');
    worker('gen', 2, mismatched, await current());
    const target = leaf(otherScope, 'w-1-alias');
    symlinkSync(target, join(scope, 'w-1-alias'));
    worker('alias', 1, join(scope, 'w-1-alias'), await current());
    expect(await handlers(verified()).stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'uncertain' });
    expect([killed(stale), killed(mismatched), killed(target)]).toEqual(['', '', '']);
  });

  it('an exact owned leaf is killed, with a current identity or with an intent only', async () => {
    const live = leaf(scope, 'w-1-live');
    worker('live', 1, live, await current());
    const intentOnly = leaf(scope, 'w-3-intent');
    worker('intent', 3, intentOnly, null);
    expect(await handlers(verified()).stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'uncertain' });
    expect([killed(live), killed(intentOnly)]).toEqual(['1', '1']);
  });
});

describe('stop and status never report unknown work as empty', () => {
  it('unavailable containment with recorded workers is uncertain and unknown', async () => {
    worker('s', 1, leaf(scope, 'w-1-s'), await current());
    const h = handlers({ state: 'unavailable', reason: 'test' });
    expect(await h.stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'uncertain' });
    const { workers } = await h.status();
    expect(workers).toEqual([expect.objectContaining({ sessionId: 's', populated: null, needsRecovery: true })]);
  });

  it('a missing leaf with a live identity is unknown; with a dead identity it is empty', async () => {
    worker('gone-live', 1, join(scope, 'w-1-gone-live'), await current());
    const h = handlers(verified());
    expect(await h.stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'uncertain' });
    expect((await h.status()).workers).toEqual([expect.objectContaining({ populated: null, needsRecovery: true })]);

    rmSync(join(root, 'sup'), { recursive: true });
    mkdirSync(join(root, 'sup'), { mode: 0o700 });
    ledger = createLedger({ dir: join(root, 'sup') });
    worker('gone-dead', 1, join(scope, 'w-1-gone-dead'), await dead());
    const h2 = handlers(verified());
    expect((await h2.status()).workers).toEqual([expect.objectContaining({ populated: false, needsRecovery: false })]);
    expect(await h2.stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'stopped' });
  });

  it('a descendant that vanishes during the walk does not hide a populated root', async () => {
    const path = leaf(scope, 'w-1-s');
    mkdirSync(join(path, 'child'));
    const fs = {
      ...nodeFs,
      readFileSync(p, ...rest) {
        if (String(p) === join(path, 'child', 'cgroup.procs')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return nodeFs.readFileSync(p, ...rest);
      },
    };
    expect(await readContainment({ cgroupPath: path, fs })).toMatchObject({ populated: true });
  });

  it('a verified empty set is still stopped', async () => {
    worker('empty', 1, leaf(scope, 'w-1-empty', false), await dead());
    expect(await handlers(verified()).stop({ scope: 'all', timeoutMs: 0 })).toEqual({ state: 'stopped' });
  });
});
