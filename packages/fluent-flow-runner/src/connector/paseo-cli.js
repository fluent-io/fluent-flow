import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, existsSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

function runExec(exec, command, args, opts) {
  return new Promise((resolve, reject) => {
    const result = exec(command, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    if (result && typeof result.then === 'function') result.then((value) => resolve(value ?? { stdout: '', stderr: '' }), reject);
  });
}

const HEADER_BYTES = 16;

function readHeaderOnly(path, { length }) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function isAppImagePath(candidate, readHeader = readHeaderOnly) {
  if (!candidate) return false;
  if (candidate.toLowerCase().endsWith('.appimage')) return true;
  try {
    const header = readHeader(candidate, { length: HEADER_BYTES });
    const buf = Buffer.isBuffer(header) ? header : Buffer.from(header);
    return (
      buf.length >= 11 &&
      buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 &&
      buf[8] === 0x41 && buf[9] === 0x49 && buf[10] === 0x02
    );
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.cliPath] - explicit CLI path from connector config
 * @param {string} opts.cacheDir - private writable cache for AppImage extraction
 * @param {{execFile?: Function, existsSync?: Function}} [opts.io]
 * @returns {Promise<{command: string, extracted: boolean}>}
 */
export async function resolvePaseoCli({ cliPath, cacheDir, io = {} }) {
  const exec = io.execFile ?? execFile;
  const exists = io.existsSync ?? existsSync;
  const candidates = cliPath ? [cliPath] : [join(process.env.HOME ?? '', '.local', 'bin', 'paseo')];
  let found = null;
  for (const candidate of candidates) {
    if (exists(candidate)) {
      found = { path: candidate };
      break;
    }
  }
  if (!found) throw new Error('The local paseo CLI was not found; cancel is unavailable on this host.');

  let target = found.path;
  let extracted = false;
  if (isAppImagePath(target)) {
    const inner = join(cacheDir, 'squashfs-root', 'resources', 'bin', 'paseo');
    if (!exists(inner)) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      await runExec(exec, target, ['--appimage-extract'], { cwd: cacheDir, timeout: 120_000 });
    }
    accessSync(inner, constants.X_OK);
    target = inner;
    extracted = true;
  }
  return { command: target, extracted };
}

/**
 * @param {object} opts
 * @param {string} opts.cliCommand - resolved CLI path
 * @param {string} opts.home - paseo home directory (daemon selection)
 * @param {{execFile?: Function}} [opts.io]
 */
export function createStopAgent({ cliCommand, home, io = {} }) {
  const exec = io.execFile ?? execFileCb;
  return async function stopAgent(agentId) {
    if (!agentId || typeof agentId !== 'string' || /(^|\s)-/.test(agentId)) {
      throw new Error('A full agent id is required for stop.');
    }
    await runExec(exec, cliCommand, ['stop', agentId, '--home', home, '--json'], { timeout: 30_000 });
  };
}
