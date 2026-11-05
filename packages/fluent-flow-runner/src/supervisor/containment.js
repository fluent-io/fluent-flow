import nodeFs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { readProcessDetails, sameProcess } from './process-identity.js';
import { terminateVerified } from './stop.js';


const CGROUP_ROOT = '/sys/fs/cgroup';
const SCOPE_NAME = /^ff-[0-9a-f]{16}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUIRED_FILES = ['cgroup.procs', 'cgroup.events', 'cgroup.kill'];
export const ENROLLMENT_FAILED_EXIT = 97;

export class ContainmentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ContainmentError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function instanceHashFor({ stateDir, instanceId }) {
  return createHash('sha256').update(`${nodeFs.realpathSync(stateDir)}\u0000${instanceId}`).digest('hex').slice(0, 16);
}

function unescapeMount(path) {
  return path.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

const isUnder = (path, mountPoint) => mountPoint === '/' || path === mountPoint || path.startsWith(`${mountPoint}/`);

export function effectiveMount(mountinfo, path) {
  let visible = [];
  for (const line of mountinfo.split('\n')) {
    if (!line.trim()) continue;
    const [left, right] = line.split(' - ');
    const fields = left.split(' ');
    const mountPoint = unescapeMount(fields[4]);
    const fsType = right?.split(' ')[0];
    visible = visible.filter((m) => !isUnder(m.mountPoint, mountPoint));
    visible.push({ mountPoint, fsType });
  }
  return visible.filter((m) => isUnder(path, m.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0] ?? null;
}

function assertScopePath(path) {
  const parts = resolve(path).split(sep);
  if (!parts.some((part) => SCOPE_NAME.test(part))) {
    throw new ContainmentError('outside_scope', `Refusing cgroup write outside an ff-* scope: ${path}`);
  }
}

/**
 * @param {{ cgroupRoot?: string, procRoot?: string, instanceHash: string, uid?: number, fs?: typeof nodeFs }} opts
 * @returns {Promise<{ state: 'verified', scopePath: string, close: () => Promise<void> } | { state: 'unavailable', reason: string }>}
 */
export async function probeContainment({ cgroupRoot = '/sys/fs/cgroup', procRoot = '/proc', instanceHash, uid = process.getuid(), fs = nodeFs }) {
  if (!/^[0-9a-f]{16}$/.test(instanceHash ?? '')) throw new TypeError('instanceHash must be 16 lowercase hex characters');
  /** @param {string} reason @returns {{ state: 'unavailable', reason: string }} */
  const unavailable = (reason) => ({ state: 'unavailable', reason });
  const root = resolve(cgroupRoot);

  let mountinfo;
  let selfCgroup;
  try {
    mountinfo = fs.readFileSync(join(procRoot, 'self/mountinfo'), 'utf8');
    selfCgroup = fs.readFileSync(join(procRoot, 'self/cgroup'), 'utf8');
  } catch {
    return unavailable('proc_unreadable');
  }
  const mount = effectiveMount(mountinfo, root);
  if (!mount || mount.mountPoint !== root) return unavailable('no_cgroup2_mount');
  if (mount.fsType !== 'cgroup2') return unavailable(mount.fsType === 'cgroup' || mount.fsType === 'tmpfs' ? 'cgroup_v1_or_hybrid' : 'no_cgroup2_mount');

  const lines = selfCgroup.split('\n').filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('0::/')) return unavailable(lines.some((l) => !l.startsWith('0::')) ? 'cgroup_hybrid' : 'no_unified_cgroup');
  const own = resolve(join(root, lines[0].slice(3)));
  if (!isUnder(own, root)) return unavailable('own_cgroup_outside_root');

  try {
    const dirStat = fs.lstatSync(own);
    const procsStat = fs.lstatSync(join(own, 'cgroup.procs'));
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== uid || procsStat.uid !== uid) return unavailable('own_cgroup_not_owned');
    fs.accessSync(own, fsConstants.W_OK);
    fs.accessSync(join(own, 'cgroup.procs'), fsConstants.W_OK);
  } catch {
    return unavailable('own_cgroup_not_writable');
  }

  const scopePath = join(own, `ff-${instanceHash}`);
  let created = false;
  try {
    fs.mkdirSync(scopePath);
    created = true;
  } catch (err) {
    if (err.code !== 'EEXIST') return unavailable('scope_create_failed');
    const st = fs.lstatSync(scopePath);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) return unavailable('scope_foreign');
  }
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(join(scopePath, file))) {
      if (created) fs.rmdirSync(scopePath);
      return unavailable('scope_missing_interface');
    }
  }
  return {
    state: 'verified',
    scopePath,
    async close() {
      for (const entry of fs.readdirSync(scopePath, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('w-')) fs.rmdirSync(join(scopePath, entry.name));
      }
      fs.rmdirSync(scopePath);
    },
  };
}

export function createWorkerCgroup({ scopePath, generation, sessionId, fs = nodeFs }) {
  if (!SCOPE_NAME.test(basename(scopePath))) throw new ContainmentError('outside_scope', `Worker cgroups live directly in an ff-* scope: ${scopePath}`);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('generation must be a positive integer');
  if (!SESSION_ID.test(sessionId ?? '')) throw new TypeError('sessionId is not a safe cgroup name');
  const path = join(scopePath, `w-${generation}-${sessionId}`);
  fs.mkdirSync(path);
  return path;
}

const SHIM = 'cg=$1; shift; { printf "%s\\n" "$$" > "$cg/cgroup.procs"; } 2>/dev/null || exit 97; printf "enrolled\\n" >&3 || exit 97; read -r go <&3 || exit 97; [ "$go" = go ] || exit 97; exec 3>&-; exec "$@"';

/**
 * @param {{ cgroupPath: string, executable: string, args?: string[], env: Record<string, string>, cwd: string }} opts
 */
export async function spawnContained({ cgroupPath, executable, args = [], env, cwd }) {
  assertScopePath(cgroupPath);
  const child = spawn('/bin/sh', ['-c', SHIM, 'ff-shim', cgroupPath, executable, ...args], {
    env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const control = /** @type {import('node:net').Socket} */ (child.stdio[3]);
  const enrolled = await new Promise((resolveEnrolled, reject) => {
    let buffered = '';
    const onExit = (code, signal) => reject(new ContainmentError('containment_enrollment_failed', 'Worker shim exited before enrollment', { exitCode: code, signal }));
    child.once('error', reject);
    child.once('exit', onExit);
    control.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.includes('enrolled\n')) {
        child.removeListener('exit', onExit);
        resolveEnrolled(true);
      }
    });
  });
  const details = enrolled && await readProcessDetails(child.pid);
  if (!details || !cgroupPath.endsWith(details.cgroup ?? '\u0000') || details.cgroup === '/') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    throw new ContainmentError('containment_enrollment_failed', 'Worker enrollment was not confirmed', { exitCode: null });
  }
  control.end('go\n');
  return { child, identity: details };
}

export async function readContainment({ cgroupPath, fs = nodeFs }) {
  const pids = [];
  const walk = async (dir, isRoot) => {
    let procs;
    let entries;
    try {
      procs = fs.readFileSync(join(dir, 'cgroup.procs'), 'utf8');
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' && !isRoot) return;
      throw err;
    }
    for (const line of procs.split('\n')) {
      if (!line) continue;
      const details = await readProcessDetails(Number(line));
      if (details) pids.push(details);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), false);
    }
  };
  await walk(cgroupPath, true);
  const events = fs.readFileSync(join(cgroupPath, 'cgroup.events'), 'utf8');
  return { pids, populated: /^populated 1$/m.test(events) };
}

/**
 * @param {{ scopePath: string, cgroupPath: string, generation: number, sessionId: string, fs?: typeof nodeFs, uid?: number }} opts
 */
export function workerLeaf({ scopePath, cgroupPath, generation, sessionId, fs = nodeFs, uid = process.getuid() }) {
  const refuse = (why) => new ContainmentError('not_owned_leaf', `Refusing cgroup operation on ${cgroupPath}: ${why}`);
  if (typeof scopePath !== 'string' || !scopePath.startsWith('/') || !SCOPE_NAME.test(basename(scopePath)) || resolve(scopePath) !== scopePath) throw refuse('no verified ff-* scope');
  if (!Number.isSafeInteger(generation) || generation < 1 || !SESSION_ID.test(sessionId ?? '')) throw refuse('no recorded worker identity');
  const expected = join(scopePath, `w-${generation}-${sessionId}`);
  if (typeof cgroupPath !== 'string' || resolve(cgroupPath) !== expected) throw refuse('not the recorded worker leaf of this scope');
  const scope = fs.lstatSync(scopePath);
  if (!scope.isDirectory() || scope.isSymbolicLink() || scope.uid !== uid || fs.realpathSync(scopePath) !== scopePath) throw refuse('scope is not a private directory');
  let leaf;
  try {
    leaf = fs.lstatSync(expected);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ContainmentError('leaf_missing', `Worker leaf ${expected} does not exist`);
    throw err;
  }
  if (!leaf.isDirectory() || leaf.isSymbolicLink() || leaf.uid !== uid) throw refuse('leaf is not an owned directory');
  return expected;
}

/**
 * @param {{ scopePath: string, cgroupPath: string, generation: number, sessionId: string, fs?: typeof nodeFs }} opts
 */
export async function killContainment({ scopePath, cgroupPath, generation, sessionId, fs = nodeFs }) {
  const leaf = workerLeaf({ scopePath, cgroupPath, generation, sessionId, fs });
  const fd = fs.openSync(join(leaf, 'cgroup.kill'), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.writeSync(fd, '1');
  } finally {
    fs.closeSync(fd);
  }
}

export function containmentOps(containment) {
  if (containment?.ops) return containment.ops;
  const scopePath = containment?.scopePath;
  return {
    leafPath: ({ generation, sessionId }) => join(scopePath, `w-${generation}-${sessionId}`),
    createWorker: ({ generation, sessionId }) => createWorkerCgroup({ scopePath, generation, sessionId }),
    spawn: (opts) => spawnContained(opts),
    leaf: ({ cgroupPath, generation, sessionId }) => workerLeaf({ scopePath, cgroupPath, generation, sessionId }),
    read: ({ cgroupPath }) => readContainment({ cgroupPath }),
    kill: ({ cgroupPath, generation, sessionId }) => killContainment({ scopePath, cgroupPath, generation, sessionId }),
    terminate: terminateVerified,
    holds: async ({ cgroupPath, identity }) => {
      const details = await readProcessDetails(identity.pid);
      if (!details || !sameProcess(details, identity)) return null;
      const actual = details.cgroup === null ? null : join(CGROUP_ROOT, details.cgroup);
      return actual !== null && (actual === cgroupPath || actual.startsWith(`${cgroupPath}/`));
    },
  };
}
