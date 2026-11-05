#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, writeSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNetworkIsolation } from './isolation.js';
import { startDbBridgeInside, startDbBridgeOutside } from './db-bridge.js';

const SELF = fileURLToPath(import.meta.url);
const INNER = '--ff-netns-inner';
const TOOLS = ['unshare', 'ip', 'mount', 'setpriv'];

/**
 * @param {{ command: string[], hasTool: (t: string) => boolean, attemptNamespace: (args: string[], env: Record<string, string|undefined>) => Promise<{ code: number|null, signal?: string|null, ready?: boolean }>, uid: number, gid: number, execPath: string, log: (line: string) => void, env?: Record<string, string|undefined>, startBridge?: (opts: { databaseUrl: string }) => Promise<{ socketPath: string, close: () => Promise<void> }> }} opts
 * @returns {Promise<number>} the exit code
 */
export async function runOuter({ command, hasTool, attemptNamespace, uid, gid, execPath, log, env = process.env, startBridge = startDbBridgeOutside }) {
  for (const tool of TOOLS) {
    if (!hasTool(tool)) {
      log(`network_isolation_unavailable (${tool} missing)`);
      return 1;
    }
  }
  const databaseUrl = env.COLLAB_CONNECTOR_TEST_DATABASE_URL;
  let bridge = null;
  if (databaseUrl !== undefined) {
    try {
      bridge = await startBridge({ databaseUrl });
    } catch (err) {
      if (err?.code !== 'database_bridge_refused') throw err;
      log(err.message);
      return 1;
    }
  }
  const base = ['--net', '--mount', '--', execPath, SELF, INNER, '--', ...command];
  const attempts = [
    ['caller', ['--user', `--map-user=${uid}`, `--map-group=${gid}`, '--keep-caps', ...base]],
    ['root', ['--user', '--map-root-user', ...base]],
  ];
  try {
    for (const [mapping, args] of attempts) {
      const result = await attemptNamespace(args, { ...env, FF_NETNS_MAPPING: mapping, ...(bridge ? { FF_DB_BRIDGE_SOCKET: bridge.socketPath } : {}) });
      if (result.ready) return exitCode(result);
      log(`[netns] ${mapping} mapping setup failed before the command started (exit ${result.code ?? result.signal})`);
    }
    log('network_isolation_unavailable (namespace setup failed under both mappings)');
    return 1;
  } finally {
    await bridge?.close();
  }
}

/**
 * @param {{ command: string[], setupSteps: (() => { ok: boolean, detail?: string })[], cleanup?: () => { ok: boolean, detail?: string }, assertIsolation: () => Promise<void>, signalReady: () => void, runCommand: (command: string[]) => Promise<{ code: number|null, signal?: string|null }>, log: (line: string) => void, startInsideBridge?: (() => Promise<{ close: () => Promise<void> }>) | null }} opts
 * @returns {Promise<number>} the exit code
 */
export async function runInner({ command, setupSteps, cleanup = () => ({ ok: true }), assertIsolation, signalReady, runCommand, log, startInsideBridge = null }) {
  let bridge = null;
  try {
    return await runInnerStages({ command, setupSteps, cleanup, assertIsolation, signalReady, runCommand, log, startBridge: async () => {
      if (startInsideBridge) bridge = await startInsideBridge();
    } });
  } finally {
    await bridge?.close();
  }
}

async function runInnerStages({ command, setupSteps, cleanup, assertIsolation, signalReady, runCommand, log, startBridge }) {
  let failed = null;
  for (const step of setupSteps) {
    const r = step();
    if (!r.ok) {
      failed = r;
      break;
    }
  }
  const cleaned = cleanup();
  if (failed) {
    log(`netns setup step failed: ${failed.detail ?? ''}`);
    return 1;
  }
  if (!cleaned.ok) {
    log(`netns setup cleanup failed: ${cleaned.detail ?? ''}`);
    return 1;
  }
  try {
    await startBridge();
  } catch (err) {
    log(`netns database bridge failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    await assertIsolation();
  } catch {
    log('network_isolation_unavailable');
    return 1;
  }
  try {
    signalReady();
  } catch (err) {
    log(`netns readiness signal failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return exitCode(await runCommand(command));
}

const CGROUP_MOUNT = '/sys/fs/cgroup';

function mounts(mountinfo) {
  return mountinfo.split('\n').filter(Boolean).map((line) => {
    const [left, right] = line.split(' - ');
    const fields = left.split(' ');
    return { id: fields[0], parent: fields[1], dev: fields[2], mountPoint: fields[4], optional: fields.slice(6), fsType: right?.split(' ')[0] };
  });
}

function mountsAt(mountinfo, path) {
  return mounts(mountinfo).some((m) => m.mountPoint === path);
}

export function hasCgroupMount(mountinfo) {
  return mountsAt(mountinfo, CGROUP_MOUNT);
}

/**
 * @param {{ cgroupMounted: boolean, savedDir: string | null }} opts
 * @returns {Array<[string, string[]]>}
 */
export function planSetup({ cgroupMounted, savedDir }) {
  const keep = cgroupMounted && savedDir;
  return [
    ['mount', ['--make-rprivate', '/']],
    ['ip', ['link', 'set', 'lo', 'up']],
    ...(keep ? [['mount', ['--rbind', CGROUP_MOUNT, savedDir]]] : []),
    ['mount', ['-t', 'sysfs', 'sysfs', '/sys']],
    ...(keep ? [['mount', ['--rbind', savedDir, CGROUP_MOUNT]], ['umount', ['-l', savedDir]]] : []),
  ];
}

function effective(mountinfo, path) {
  let visible = [];
  const under = (p, mp) => mp === '/' || p === mp || p.startsWith(`${mp}/`);
  for (const m of mounts(mountinfo)) {
    visible = visible.filter((v) => !under(v.mountPoint, m.mountPoint));
    visible.push(m);
  }
  return visible.filter((m) => under(path, m.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0] ?? null;
}

export function cgroupPreserved(before, after) {
  if (!hasCgroupMount(before)) return true;
  const was = effective(before, CGROUP_MOUNT);
  const now = effective(after, CGROUP_MOUNT);
  return Boolean(now) && now.mountPoint === CGROUP_MOUNT && now.dev === was.dev && now.fsType === was.fsType;
}

export function propagationPrivate(mountinfo) {
  return mounts(mountinfo).every((m) => !m.optional.some((tag) => /^(shared|master|propagate_from):/.test(tag)));
}

function exitCode({ code, signal }) {
  if (signal) return 128 + (/** @type {Record<string, number>} */ (osConstants.signals)[signal] ?? 0);
  return code ?? 1;
}

function splitArgs(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv.slice(idx + 1);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const isInner = argv[0] === INNER;
  const command = splitArgs(isInner ? argv.slice(1) : argv);
  const log = (line) => process.stderr.write(`${line}\n`);
  if (!command) {
    log('usage: netns-launcher.js -- <command> [args...]');
    return 2;
  }
  if (!isInner) {
    return runOuter({
      command,
      hasTool: (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0,
      attemptNamespace: (args, env) =>
        new Promise((resolve) => {
          let ready = false;
          const child = spawn('unshare', args, { env, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
          child.stdio[3]?.on('data', (d) => {
            if (String(d).includes('ready')) ready = true;
          });
          child.once('error', () => resolve({ code: 1, signal: null, ready: false }));
          child.once('close', (code, signal) => resolve({ code, signal, ready }));
        }),
      uid: process.getuid?.() ?? -1,
      gid: process.getgid?.() ?? -1,
      execPath: process.execPath,
      log,
    });
  }
  const readMountinfo = () => readFileSync('/proc/self/mountinfo', 'utf8');
  const before = readMountinfo();
  const cgroupMounted = hasCgroupMount(before);
  const savedDir = cgroupMounted ? realpathSync(mkdtempSync(join(tmpdir(), 'ff-netns-cgroup-'))) : null;
  const step = (cmd, args) => () => {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: r.status === 0, detail: `${cmd} ${args.join(' ')}: ${String(r.stderr ?? '').trim()}` };
  };
  return runInner({
    command,
    setupSteps: [
      ...planSetup({ cgroupMounted, savedDir }).map(([cmd, args]) => step(cmd, args)),
      () => {
        const after = readMountinfo();
        if (!propagationPrivate(after)) return { ok: false, detail: 'mount propagation is not private' };
        if (!cgroupPreserved(before, after)) return { ok: false, detail: 'the existing cgroup mount was not preserved' };
        return { ok: true };
      },
    ],
    cleanup: () => {
      if (!savedDir) return { ok: true };
      if (mountsAt(readMountinfo(), savedDir)) {
        const detached = step('umount', ['-l', savedDir])();
        if (!detached.ok) return detached;
      }
      try {
        rmdirSync(savedDir);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: `rmdir ${savedDir}: ${err.code}` };
      }
    },
    startInsideBridge: process.env.FF_DB_BRIDGE_SOCKET
      ? () => startDbBridgeInside({ databaseUrl: String(process.env.COLLAB_CONNECTOR_TEST_DATABASE_URL), socketPath: String(process.env.FF_DB_BRIDGE_SOCKET) })
      : null,
    assertIsolation: () => assertNetworkIsolation(),
    signalReady: () => {
      writeSync(3, 'ready\n');
      closeSync(3);
    },
    runCommand: (cmd) => {
      const uidMap = spawnSync('cat', ['/proc/self/uid_map'], { encoding: 'utf8' }).stdout.trim().replace(/\s+/g, ' ');
      log(`[netns] isolated: lo only; mapping=${process.env.FF_NETNS_MAPPING} uid_map="${uidMap}" uid=${process.getuid?.()} cgroup=${cgroupMounted ? 'preserved' : 'absent'}`);
      const env = { ...process.env, FF_NATIVE_REQUIRED: '1', FF_NETNS_UID_MAP: uidMap };
      return run('setpriv', ['--inh-caps=-all', '--ambient-caps=-all', '--', ...cmd], { env });
    },
    log,
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === SELF) {
  main().then((code) => process.exit(code));
}
