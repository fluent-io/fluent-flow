import { spawn } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import { isLive, readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir } from '../../../src/supervisor/owner-lock.js';
import { openPrivateFile } from '../../../src/supervisor/private-file.js';

const ENTRY = fileURLToPath(new URL('./test-supervisor-entry.js', import.meta.url));
const START_TIMEOUT_MS = 30_000;

/**
 * @param {{ stateDir: string, instanceId: string, configFile: string, fixtures: { anthropicUrl?: string, openaiUrl?: string, parentEnv: Record<string, string>, spawnEnvExtras?: Record<string, string> }, pidNamespace?: boolean }} opts
 * @returns {Promise<{ pid: number, exited: Promise<{ code: number | null, signal: string | null }>, logFile: string, close: () => Promise<void> }>}
 */
export async function startTestSupervisor({ stateDir, instanceId, configFile, fixtures, pidNamespace = false }) {
  const absState = resolve(stateDir);
  ensurePrivateDir(absState);
  const supDir = ensurePrivateDir(join(absState, 'supervisor'));
  const opened = [];
  let child;
  try {
    const privateFile = (name, access) => {
      const fd = /** @type {number} */ (openPrivateFile(join(supDir, name), { access, create: true }));
      opened.push(fd);
      return fd;
    };
    const logFd = privateFile('supervisor.log', 'append');
    const lockFd = privateFile('owner.lock', 'read');
    const command = ['flock', '--nonblock', '--conflict-exit-code', '75', '/proc/self/fd/4', process.execPath, ENTRY];
    const argv = pidNamespace ? ['unshare', '--user', '--map-current-user', '--pid', '--fork', '--mount', '--mount-proc', ...command] : command;
    child = spawn(argv[0], argv.slice(1), {
      cwd: supDir,
      detached: true,
      stdio: ['ignore', logFd, logFd, 'pipe', lockFd],
      env: { PATH: process.env.PATH ?? '', FF_TEST_SUPERVISOR: JSON.stringify({ stateDir: absState, instanceId, configFile: resolve(configFile), fixtures }) },
    });
  } finally {
    for (const fd of opened) closeSync(fd);
  }
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  await new Promise((resolveReady, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('test supervisor did not become ready')), START_TIMEOUT_MS);
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`test supervisor exited before ready (${code ?? signal})`));
    });
    child.stdio[3].on('data', (chunk) => {
      buffered += chunk;
      if (buffered.includes('ready\n')) {
        clearTimeout(timer);
        resolveReady(undefined);
      }
    });
  });
  child.stdio[3].destroy();
  return {
    pid: child.pid,
    exited,
    logFile: join(supDir, 'supervisor.log'),
    async close() {
      const inner = [];
      try {
        for (const pid of readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) {
          const identity = await readProcessIdentity(Number(pid));
          if (identity) inner.push(identity);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
      await exited;
      const deadline = Date.now() + 30_000;
      while (inner.length && (await Promise.all(inner.map((identity) => isLive(identity)))).some(Boolean)) {
        if (Date.now() > deadline) throw new Error('test supervisor did not exit after its flock wrapper');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}
