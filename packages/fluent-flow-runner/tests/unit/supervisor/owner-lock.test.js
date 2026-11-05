import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, statSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSupervisor, verifyOwnerLock, OwnerLockHeld, SupervisorUnavailable } from '../../../src/supervisor/owner-lock.js';
import { startSupervisor, OwnerLockNotHeld } from '../../../src/supervisor/supervisor.js';
import { readProcessIdentity, isLive } from '../../../src/supervisor/process-identity.js';

const OWNER_LOCK = fileURLToPath(new URL('../../../src/supervisor/owner-lock.js', import.meta.url));
const VERIFY = `import(${JSON.stringify(OWNER_LOCK)}).then(async (m) => {
  process.stdout.write(String(await m.verifyOwnerLock({ lockFile: process.argv[1] })) + '\\n');
  setTimeout(() => {}, 30000);
});`;
const INHERIT = `import { spawn } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
const lock = process.argv[1];
const holds = (pid) => readdirSync('/proc/' + pid + '/fd').some((fd) => { try { return readlinkSync('/proc/' + pid + '/fd/' + fd) === lock; } catch { return false; } });
const plain = spawn('sleep', ['30']);
const detached = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
setTimeout(() => {
  process.stdout.write(JSON.stringify({ self: process.pid, selfHolds: holds(process.pid), plain: plain.pid, plainHolds: holds(plain.pid), detached: detached.pid, detachedHolds: holds(detached.pid) }) + '\\n');
}, 300);
setTimeout(() => {}, 30000);`;

let root;
const owned = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ff-owner-')); });
afterEach(async () => {
  for (const { pid, identity, group } of owned.splice(0).reverse()) {
    if (!(await isLive(identity))) continue;
    process.kill(group ? -pid : pid, 'SIGTERM');
    if (!(await waitGone(identity)) && (await isLive(identity))) process.kill(group ? -pid : pid, 'SIGKILL');
    await waitGone(identity);
  }
  rmSync(root, { recursive: true, force: true });
});

async function own(pid, group = false) {
  const identity = await readProcessIdentity(pid);
  if (identity) owned.push({ pid, identity, group });
  return identity;
}
async function waitGone(identity, ms = 5000) {
  const until = Date.now() + ms;
  while ((await isLive(identity)) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return !(await isLive(identity));
}
const childrenOf = (pid) => readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);

function holdLock(lockFile, extra = [], script = VERIFY) {
  if (!existsSync(lockFile)) writeFileSync(lockFile, '', { mode: 0o600 });
  const child = spawn('flock', [...extra, lockFile, process.execPath, '--input-type=module', '-e', script, lockFile], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const owning = own(child.pid, true);
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const firstLine = new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); });
    child.once('exit', () => resolve(buf.trim() || null));
  });
  return { child, exit, firstLine, owning };
}

function writeConfig() {
  const configFile = join(root, 'profiles.json');
  writeFileSync(configFile, JSON.stringify({ profiles: [] }), { mode: 0o600 });
  return configFile;
}

describe('owner lock', () => {
  it('a second process cannot acquire while the first holds', async () => {
    const lockFile = join(root, 'owner.lock');
    const first = holdLock(lockFile);
    expect(await first.firstLine).toBe('true');
    const second = holdLock(lockFile, ['--nonblock', '--conflict-exit-code', '75']);
    expect(await second.exit).toBe(75);
    expect(await verifyOwnerLock({ lockFile })).toBe(false);
  });

  it('killing only the flock parent keeps the lock held by its command; killing that command frees it', async () => {
    const lockFile = join(root, 'owner.lock');
    const first = holdLock(lockFile);
    expect(await first.firstLine).toBe('true');
    const flockIdentity = await first.owning;
    const [commandPid] = childrenOf(first.child.pid);
    const commandIdentity = await own(commandPid);
    process.kill(flockIdentity.pid, 'SIGKILL');
    await first.exit;
    expect(await waitGone(flockIdentity)).toBe(true);
    expect(await isLive(commandIdentity)).toBe(true);
    const blocked = holdLock(lockFile, ['--nonblock', '--conflict-exit-code', '75']);
    expect(await blocked.exit).toBe(75);
    process.kill(commandIdentity.pid, 'SIGKILL');
    expect(await waitGone(commandIdentity)).toBe(true);
    const next = holdLock(lockFile, ['--nonblock', '--conflict-exit-code', '75']);
    expect(await next.firstLine).toBe('true');
  });

  it('the lock descriptor reaches the flock command but not its default or detached spawned children', async () => {
    const lockFile = join(root, 'owner.lock');
    const holder = holdLock(lockFile, [], INHERIT);
    const report = JSON.parse(await holder.firstLine);
    await holder.owning;
    await own(report.self);
    await own(report.plain);
    await own(report.detached, true);
    expect(report).toMatchObject({ selfHolds: true, plainHolds: false, detachedHolds: false });
  });

  it('a second supervisor on the same state exits with OwnerLockHeld', async () => {
    const stateDir = join(root, 'state');
    const configFile = writeConfig();
    const first = await launchSupervisor({ stateDir, instanceId: 'inst-1', configFile });
    const firstIdentity = await own(first.pid, true);
    await expect(launchSupervisor({ stateDir, instanceId: 'inst-1', configFile })).rejects.toBeInstanceOf(OwnerLockHeld);
    expect(await isLive(firstIdentity)).toBe(true);
  });

  it('the supervisor refuses to run when verifyOwnerLock is false', async () => {
    const stateDir = join(root, 'state');
    await expect(startSupervisor({ stateDir, instanceId: 'inst-1', configFile: writeConfig(), backends: {},
      containment: { state: 'unavailable', reason: 'test' }, log: () => {} })).rejects.toBeInstanceOf(OwnerLockNotHeld);
    expect(existsSync(join(stateDir, 'supervisor', 'ledger.jsonl'))).toBe(false);
    expect(existsSync(join(stateDir, 'supervisor', 'ipc.sock'))).toBe(false);
  });

  it('/proc/<pid>/cmdline of a launched supervisor contains neither the instance id nor the state path', async () => {
    const stateDir = join(root, 'state-secret-path');
    const instanceId = 'instance-visible-nowhere';
    const launched = await launchSupervisor({ stateDir, instanceId, configFile: writeConfig() });
    await own(launched.pid, true);
    const childPids = readFileSync(`/proc/${launched.pid}/task/${launched.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    expect(childPids.length).toBe(1);
    expect(readFileSync(`/proc/${launched.pid}/cmdline`, 'utf8')).toContain('/proc/self/fd/4');
    expect(readFileSync(`/proc/${childPids[0]}/cmdline`, 'utf8')).toContain('fluent-flow-supervisor.js');
    for (const pid of [launched.pid, ...childPids]) {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      expect(cmdline).not.toContain(instanceId);
      expect(cmdline).not.toContain(stateDir);
      expect(cmdline).not.toContain('state-secret-path');
    }
  });
});

describe('supervisor file safety at launch', () => {
  const prepared = () => {
    const stateDir = join(root, 'state');
    mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    return { stateDir, supDir: join(stateDir, 'supervisor') };
  };
  const target = () => {
    const path = join(root, 'unrelated.txt');
    writeFileSync(path, 'unrelated\n');
    chmodSync(path, 0o600);
    return path;
  };
  const snap = (path) => ({ bytes: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 });
  const launchOutcome = (opts) => launchSupervisor(opts).then(async (r) => { await own(r.pid, true); return r; }, (err) => err);

  for (const [file, kind] of [['supervisor.log', 'symlink'], ['supervisor.log', 'wide'], ['owner.lock', 'symlink'], ['owner.lock', 'wide']]) {
    it(`a ${kind} ${file} is refused before it is opened through, and the target keeps its bytes and mode`, async () => {
      const { stateDir, supDir } = prepared();
      const victim = target();
      if (kind === 'symlink') symlinkSync(victim, join(supDir, file));
      else { writeFileSync(join(supDir, file), 'unrelated\n'); chmodSync(join(supDir, file), 0o644); }
      const watched = kind === 'symlink' ? victim : join(supDir, file);
      const before = snap(watched);
      const outcome = await launchOutcome({ stateDir, instanceId: 'inst-1', configFile: writeConfig() });
      expect(outcome).toBeInstanceOf(SupervisorUnavailable);
      expect(outcome.reason).toBe('supervisor_file_unsafe');
      expect(snap(watched)).toEqual(before);
      if (kind === 'symlink') expect(lstatSync(join(supDir, file)).isSymbolicLink()).toBe(true);
    });
  }

  it('a launched supervisor creates owner.lock and supervisor.log as private regular files', async () => {
    const { stateDir, supDir } = prepared();
    const launched = await launchSupervisor({ stateDir, instanceId: 'inst-1', configFile: writeConfig() });
    await own(launched.pid, true);
    for (const file of ['owner.lock', 'supervisor.log']) {
      const st = lstatSync(join(supDir, file));
      expect([st.isFile(), st.mode & 0o777]).toEqual([true, 0o600]);
    }
  });

  it('verifyOwnerLock is false when owner.lock is a symlink to a locked file', async () => {
    const real = join(root, 'real.lock');
    writeFileSync(real, '', { mode: 0o600 });
    const link = join(root, 'owner.lock');
    symlinkSync(real, link);
    const child = spawn('flock', [real, process.execPath, '--input-type=module', '-e', VERIFY, link], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    await own(child.pid, true);
    const line = await new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); });
      child.once('exit', () => resolve(buf.trim() || null));
    });
    expect(line).toBe('false');
  });
});
