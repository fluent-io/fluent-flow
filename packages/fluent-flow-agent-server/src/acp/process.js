import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

function boundedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('stderr byte limit must be a non-negative integer');
  return value;
}

export function spawnAcpProcess({
  bin = undefined,
  args = [],
  cwd = undefined,
  env = undefined,
  spawnImpl = spawn,
  stderrLimitBytes = DEFAULT_STDERR_LIMIT_BYTES,
} = {}) {
  if (typeof bin !== 'string' || bin.length === 0) throw new Error('ACP executable is required');
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new Error('ACP arguments must be an array of strings');
  }
  const limit = boundedLimit(stderrLimitBytes);
  const child = spawnImpl(bin, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  });

  let stderrTail = Buffer.alloc(0);
  child.stderr.on('data', (chunk) => {
    if (limit === 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length >= limit) {
      stderrTail = bytes.subarray(bytes.length - limit);
      return;
    }
    const combinedLength = stderrTail.length + bytes.length;
    stderrTail = combinedLength <= limit
      ? Buffer.concat([stderrTail, bytes], combinedLength)
      : Buffer.concat([stderrTail.subarray(combinedLength - limit), bytes], limit);
  });

  let settleExit;
  let settled = false;
  const exited = new Promise((resolveExit) => {
    settleExit = (result) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
  });

  child.once('error', (error) => settleExit({ code: null, signal: null, error }));
  child.once('exit', (code, signal) => settleExit({ code, signal, error: null }));
  child.once('close', (code, signal) => settleExit({ code, signal, error: null }));

  let inputClosed = false;
  const result = {
    input: Writable.toWeb(child.stdin),
    output: Readable.toWeb(child.stdout),
    exited,
    closeInput() {
      if (inputClosed) return;
      inputClosed = true;
      child.stdin.end();
    },
    kill(signal) {
      return child.kill(signal);
    },
    pid: child.pid,
  };

  Object.defineProperty(result, 'stderr', {
    enumerable: true,
    get: () => stderrTail.toString('utf8'),
  });

  return result;
}
