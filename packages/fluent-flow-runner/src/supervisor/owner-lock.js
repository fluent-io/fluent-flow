import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPrivateFile, SupervisorFileUnsafe } from './private-file.js';


const BIN = fileURLToPath(new URL('../../bin/fluent-flow-supervisor.js', import.meta.url));
export const OWNER_LOCK_CONFLICT_EXIT = 75;
const START_TIMEOUT_MS = 15_000;

export class SupervisorUnavailable extends Error {
  /** @param {string} reason protected detail for host logs */
  constructor(reason, options) {
    super(`Supervisor unavailable: ${reason}`, options);
    this.name = 'SupervisorUnavailable';
    this.code = 'supervisor_unavailable';
    this.reason = reason;
  }
}

export class OwnerLockHeld extends Error {
  constructor() {
    super('Another supervisor already owns this state directory');
    this.name = 'OwnerLockHeld';
    this.code = 'owner_lock_held';
  }
}

export function ensurePrivateDir(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new SupervisorUnavailable('private_dir_create_failed', { cause: err });
  }
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw new SupervisorUnavailable('private_dir_unreadable', { cause: err });
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SupervisorUnavailable('private_dir_not_directory');
  if (st.uid !== process.getuid()) throw new SupervisorUnavailable('private_dir_foreign_owner');
  if ((st.mode & 0o777) !== 0o700) throw new SupervisorUnavailable('private_dir_mode');
  return path;
}

/**
 * @param {{ stateDir: string, instanceId: string, configFile: string }} opts
 * @returns {Promise<{ pid: number }>} pid of the flock process, which leads the supervisor's process group
 */
export async function launchSupervisor({ stateDir, instanceId, configFile }) {
  const absState = resolve(stateDir);
  ensurePrivateDir(absState);
  const supDir = ensurePrivateDir(join(absState, 'supervisor'));
  const opened = [];
  let child;
  try {
    const privateFile = (name, access) => {
      try {
        const fd = /** @type {number} */ (openPrivateFile(join(supDir, name), { access, create: true }));
        opened.push(fd);
        return fd;
      } catch (err) {
        if (err instanceof SupervisorFileUnsafe) throw new SupervisorUnavailable('supervisor_file_unsafe', { cause: err });
        throw err;
      }
    };
    const logFd = privateFile('supervisor.log', 'append');
    const lockFd = privateFile('owner.lock', 'read');
    child = spawn('flock', ['--nonblock', '--conflict-exit-code', String(OWNER_LOCK_CONFLICT_EXIT), '/proc/self/fd/4', process.execPath, BIN], {
      cwd: supDir,
      detached: true,
      stdio: ['ignore', logFd, logFd, 'pipe', lockFd],
      env: { ...process.env, FF_SUPERVISOR_STATE_DIR: absState, FF_SUPERVISOR_INSTANCE: instanceId, FF_SUPERVISOR_CONFIG: resolve(configFile) },
    });
  } finally {
    for (const fd of opened) closeSync(fd);
  }
  const readyPipe = child.stdio[3];
  try {
    await new Promise((resolveReady, reject) => {
      let buffered = '';
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') return reject(err); }
        reject(new SupervisorUnavailable('start_timeout'));
      }, START_TIMEOUT_MS);
      child.once('error', (/** @type {NodeJS.ErrnoException} */ err) => {
        clearTimeout(timer);
        reject(new SupervisorUnavailable(err.code === 'ENOENT' ? 'flock_missing' : 'flock_spawn_failed', { cause: err }));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === OWNER_LOCK_CONFLICT_EXIT) reject(new OwnerLockHeld());
        else reject(new SupervisorUnavailable(`supervisor_exited_${code ?? signal}`));
      });
      readyPipe.on('data', (chunk) => {
        buffered += chunk;
        if (buffered.includes('ready\n')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
    });
  } finally {
    child.removeAllListeners('exit');
    readyPipe.destroy();
  }
  child.unref();
  return { pid: child.pid };
}

function devParts(dev) {
  const d = BigInt(dev);
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  return { major, minor };
}

async function processName(pid) {
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function verifyOwnerLock({ lockFile }) {
  let st;
  try {
    st = lstatSync(lockFile, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isFile() || st.uid !== BigInt(process.getuid()) || (st.mode & 0o777n) !== 0o600n) return false;
  const { major, minor } = devParts(st.dev);
  const locks = await readFile('/proc/locks', 'utf8');
  const holders = [];
  for (const line of locks.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE') continue;
    const [maj, min, ino] = (fields[5] ?? '').split(':');
    if (maj === undefined || ino === undefined) continue;
    if (BigInt(`0x${maj}`) === major && BigInt(`0x${min}`) === minor && BigInt(ino) === st.ino) holders.push(Number(fields[4]));
  }
  if (holders.includes(process.pid)) return true;
  return holders.includes(process.ppid) && (await processName(process.ppid)) === 'flock';
}
