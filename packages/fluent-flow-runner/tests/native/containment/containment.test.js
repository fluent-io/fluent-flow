import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { probeContainment, spawnContained, readContainment, killContainment, createWorkerCgroup } from '../../../src/supervisor/containment.js';


let containment;
let tmp;
const hash = randomBytes(8).toString('hex');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ff-contain-'));
  containment = await probeContainment({ instanceHash: hash });
});
afterAll(async () => {
  if (containment?.state === 'verified') await containment.close();
  rmSync(tmp, { recursive: true, force: true });
});

function requireVerified() {
  if (containment.state !== 'verified') throw new Error(`containment_unavailable: ${containment.reason}`);
  return containment;
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('real-kernel containment', () => {
  it('a double-forked setsid grandchild stays in the worker cgroup', async () => {
    const { scopePath } = requireVerified();
    const cgroupPath = createWorkerCgroup({ scopePath, generation: 1, sessionId: 'fork' });
    const pidFile = join(tmp, 'grandchild.pid');
    const script = `setsid sh -c 'sleep 60 & echo $! > "${pidFile}"; wait' </dev/null >/dev/null 2>&1 & exit 0`;
    const { child, identity } = await spawnContained({ cgroupPath, executable: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin' }, cwd: tmp });
    expect(identity.cgroup.endsWith('/w-1-fork')).toBe(true);
    await new Promise((r) => child.once('exit', r));
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    const state = await readContainment({ cgroupPath });
    expect(state.populated).toBe(true);
    expect(state.pids.map((p) => p.pid)).toContain(grandchild);
    expect(readFileSync(`/proc/${grandchild}/cgroup`, 'utf8')).toContain('/w-1-fork');
    await killContainment({ scopePath, cgroupPath, generation: 1, sessionId: 'fork' });
    expect(await until(async () => !(await readContainment({ cgroupPath })).populated)).toBe(true);
  });

  it('killContainment empties it and populated becomes 0', async () => {
    const { scopePath } = requireVerified();
    const cgroupPath = createWorkerCgroup({ scopePath, generation: 1, sessionId: 'kill' });
    const { child } = await spawnContained({ cgroupPath, executable: '/bin/sh', args: ['-c', 'sleep 60 & sleep 60 & wait'], env: { PATH: '/usr/bin:/bin' }, cwd: tmp });
    expect(await until(async () => (await readContainment({ cgroupPath })).pids.length >= 3)).toBe(true);
    await killContainment({ scopePath, cgroupPath, generation: 1, sessionId: 'kill' });
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
    expect(await until(async () => !(await readContainment({ cgroupPath })).populated)).toBe(true);
    expect(readFileSync(join(cgroupPath, 'cgroup.events'), 'utf8')).toMatch(/^populated 0$/m);
  });

  it('the shim exits 97 and never execs when enrollment fails', async () => {
    const { scopePath } = requireVerified();
    const marker = join(tmp, 'executed');
    const missing = join(scopePath, 'w-9-missing');
    await expect(spawnContained({ cgroupPath: missing, executable: '/usr/bin/touch', args: [marker], env: { PATH: '/usr/bin:/bin' }, cwd: tmp }))
      .rejects.toMatchObject({ code: 'containment_enrollment_failed', exitCode: 97 });
    expect(existsSync(marker)).toBe(false);
  });

  it('probeContainment creates only its ff-* subtree and removes it on close', async () => {
    const { scopePath } = requireVerified();
    const own = join(scopePath, '..');
    const before = readdirSync(own, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const other = await probeContainment({ instanceHash: randomBytes(8).toString('hex') });
    expect(other.state).toBe('verified');
    const during = readdirSync(own, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(during.filter((n) => !before.includes(n))).toEqual([other.scopePath.split('/').pop()]);
    expect(other.scopePath.split('/').pop()).toMatch(/^ff-[0-9a-f]{16}$/);
    await other.close();
    expect(existsSync(other.scopePath)).toBe(false);
    expect(readdirSync(own, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()).toEqual(before.sort());
  });
});
