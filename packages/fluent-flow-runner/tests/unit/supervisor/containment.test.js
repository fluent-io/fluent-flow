import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodeFs, { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeContainment, createWorkerCgroup, killContainment } from '../../../src/supervisor/containment.js';
import { publishReadiness } from '../../../src/supervisor/supervisor.js';


let root;
let cgroupRoot;
let procRoot;
const OWN = '/user.slice/user-1000.slice/app.scope';
const HASH = '0123456789abcdef';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-cgfake-'));
  cgroupRoot = join(root, 'sys/fs/cgroup');
  procRoot = join(root, 'proc');
  mkdirSync(join(cgroupRoot, OWN), { recursive: true });
  for (const f of ['cgroup.procs', 'cgroup.events', 'cgroup.kill', 'cgroup.subtree_control', 'memory.max']) writeFileSync(join(cgroupRoot, OWN, f), '');
  mkdirSync(join(procRoot, 'self'), { recursive: true });
  setMounts([`38 28 0:32 / ${cgroupRoot} rw,nosuid,nodev,noexec,relatime shared:10 - cgroup2 cgroup2 rw,nsdelegate`]);
  writeFileSync(join(procRoot, 'self/cgroup'), `0::${OWN}\n`);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setMounts(lines) {
  writeFileSync(join(procRoot, 'self/mountinfo'), [
    `22 1 259:7 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p7 rw`,
    ...lines,
  ].join('\n') + '\n');
}

function kernelFs({ files = ['cgroup.procs', 'cgroup.events', 'cgroup.kill'] } = {}) {
  const writes = [];
  const fs = {
    ...nodeFs,
    mkdirSync(path, opts) {
      writes.push(['mkdir', resolve(path)]);
      const out = nodeFs.mkdirSync(path, opts);
      for (const f of files) nodeFs.writeFileSync(join(path, f), f === 'cgroup.events' ? 'populated 0\nfrozen 0\n' : '');
      return out;
    },
    rmdirSync(path) {
      writes.push(['rmdir', resolve(path)]);
      for (const f of files) nodeFs.rmSync(join(path, f), { force: true });
      return nodeFs.rmdirSync(path);
    },
    writeFileSync(path, data, opts) {
      writes.push(['write', resolve(String(path))]);
      return nodeFs.writeFileSync(path, data, opts);
    },
    openSync(path, flags, mode) {
      const writing = typeof flags === 'number' ? (flags & (nodeFs.constants.O_WRONLY | nodeFs.constants.O_RDWR)) !== 0 : /[wa+]/.test(flags ?? 'r');
      if (writing) writes.push(['write', resolve(String(path))]);
      return nodeFs.openSync(path, flags, mode);
    },
  };
  return { fs, writes };
}

const probe = (opts = {}) => probeContainment({ cgroupRoot, procRoot, instanceHash: HASH, ...opts });

describe('containment decision logic', () => {
  it('verified only with a cgroup2 mount, an owned own-cgroup and an ff-* scope with cgroup.kill', async () => {
    const { fs } = kernelFs();
    const result = await probe({ fs });
    expect(result).toMatchObject({ state: 'verified', scopePath: join(cgroupRoot, OWN, `ff-${HASH}`) });
    expect(existsSync(result.scopePath)).toBe(true);
    await result.close();
    expect(existsSync(result.scopePath)).toBe(false);
  });

  it('v1 or hybrid mounts, foreign ownership or a missing cgroup.kill are unavailable with a reason', async () => {
    const { fs } = kernelFs();
    setMounts([`30 22 0:26 / ${cgroupRoot} ro,nosuid shared:9 - tmpfs tmpfs ro,mode=755`,
      `31 30 0:27 / ${cgroupRoot}/memory rw shared:10 - cgroup cgroup rw,memory`]);
    expect(await probe({ fs })).toEqual({ state: 'unavailable', reason: expect.any(String) });

    setMounts([`38 28 0:32 / ${cgroupRoot} rw shared:10 - cgroup2 cgroup2 rw`, `90 22 0:60 / ${join(root, 'sys')} rw - sysfs sysfs rw`]);
    expect(await probe({ fs })).toEqual({ state: 'unavailable', reason: expect.any(String) });

    setMounts([`38 28 0:32 / ${cgroupRoot} rw shared:10 - cgroup2 cgroup2 rw`]);
    writeFileSync(join(procRoot, 'self/cgroup'), `1:name=systemd:${OWN}\n0::${OWN}\n`);
    expect(await probe({ fs })).toEqual({ state: 'unavailable', reason: expect.any(String) });

    writeFileSync(join(procRoot, 'self/cgroup'), `0::${OWN}\n`);
    expect(await probe({ fs, uid: process.getuid() + 4242 })).toEqual({ state: 'unavailable', reason: expect.any(String) });

    const noKill = kernelFs({ files: ['cgroup.procs', 'cgroup.events'] });
    expect(await probe({ fs: noKill.fs })).toEqual({ state: 'unavailable', reason: expect.any(String) });
    expect(existsSync(join(cgroupRoot, OWN, `ff-${HASH}`))).toBe(false);
  });

  it('every write stays inside the ff-* subtree', async () => {
    const { fs, writes } = kernelFs();
    const result = await probe({ fs });
    const worker = createWorkerCgroup({ scopePath: result.scopePath, generation: 3, sessionId: 'sess-1', fs });
    expect(worker).toBe(join(result.scopePath, 'w-3-sess-1'));
    await killContainment({ scopePath: result.scopePath, cgroupPath: worker, generation: 3, sessionId: 'sess-1', fs });
    expect(readFileSync(join(worker, 'cgroup.kill'), 'utf8')).toBe('1');
    await expect(killContainment({ scopePath: result.scopePath, cgroupPath: join(cgroupRoot, OWN), generation: 3, sessionId: 'sess-1', fs })).rejects.toThrow(/not the recorded worker leaf/);
    expect(() => createWorkerCgroup({ scopePath: join(cgroupRoot, OWN), generation: 1, sessionId: 's', fs })).toThrow(/ff-/);
    expect(() => createWorkerCgroup({ scopePath: result.scopePath, generation: 1, sessionId: '../escape', fs })).toThrow();
    await result.close();
    expect(writes.length).toBeGreaterThan(0);
    for (const [, path] of writes) {
      expect(path.startsWith(`${join(cgroupRoot, OWN)}/ff-${HASH}`)).toBe(true);
      expect(path).not.toMatch(/subtree_control|memory\.|cpu\.|pids\./);
    }
    expect(readFileSync(join(cgroupRoot, OWN, 'cgroup.subtree_control'), 'utf8')).toBe('');
  });

  it('unavailable containment publishes every standalone profile as platform_unsupported', async () => {
    const readyBackend = (id) => ({ id, readiness: async () => ({ state: 'ready', version: 'x' }), open: async () => { throw new Error('not used'); } });
    const profiles = [
      { id: 'claude-a', backend: 'claude-code', complete: true },
      { id: 'codex-a', backend: 'codex', complete: true },
      { id: 'codex-b', backend: 'codex', complete: false },
    ];
    const backends = { 'claude-code': readyBackend('claude-code'), codex: readyBackend('codex') };
    const unavailable = await publishReadiness({ profiles, backends, containment: { state: 'unavailable', reason: 'no_cgroup2_mount' } });
    expect(unavailable).toEqual(profiles.map((p) => ({ id: p.id, backend: p.backend, readiness: { state: 'platform_unsupported' } })));
    const verified = await publishReadiness({ profiles, backends, containment: { state: 'verified', scopePath: '/x/ff-1' } });
    expect(verified.map((p) => p.readiness.state)).toEqual(['ready', 'ready', 'incomplete']);
    const missingBackend = await publishReadiness({ profiles, backends: {}, containment: { state: 'verified', scopePath: '/x/ff-1' } });
    expect(missingBackend.map((p) => p.readiness.state)).toEqual(['platform_unsupported', 'platform_unsupported', 'incomplete']);
  });
});
