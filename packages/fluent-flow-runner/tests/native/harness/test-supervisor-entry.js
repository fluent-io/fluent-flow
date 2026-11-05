import { closeSync, writeSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { startSupervisor } from '../../../src/supervisor/supervisor.js';
import { ensurePrivateDir, verifyOwnerLock } from '../../../src/supervisor/owner-lock.js';
import { createClaudeBackend } from '../../../src/native/claude-backend.js';
import { createCodexBackend } from '../../../src/native/codex-backend.js';
import { syntheticClaudeAuth, syntheticCodexAuth } from './synthetic-auth.js';
import { realTestContainment, testContainment } from './test-containment.js';

const log = (record) => console.error(JSON.stringify({ time: new Date().toISOString(), ...record }));
const backendLog = { info: log, warn: log, error: log, debug: () => {} };

function faultOps(ops, { dropThreadStart = 0, killNoop = false }) {
  let drops = dropThreadStart;
  return {
    ...ops,
    ...(killNoop ? { kill: async () => {} } : {}),
    async spawn(opts) {
      const result = await ops.spawn(opts);
      if (drops <= 0 || !result.child.stdout) return result;
      drops -= 1;
      const { child } = result;
      const writes = [];
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) writes.push(JSON.parse(line));
        return write(chunk, ...rest);
      };
      const out = new PassThrough();
      let tail = '';
      let dropped = false;
      child.stdout.on('data', (d) => {
        const lines = (tail + d).split('\n');
        tail = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line);
          const start = writes.find((w) => w.method === 'thread/start');
          if (!dropped && start && msg.id === start.id && msg.method === undefined) {
            dropped = true;
            log({ msg: 'test fault dropped the thread/start reply' });
            continue;
          }
          out.write(`${line}\n`);
        }
      });
      child.stdout.on('end', () => out.end());
      Object.defineProperty(child, 'stdout', { value: out, configurable: true });
      return result;
    },
  };
}

async function main() {
  const { stateDir, instanceId, configFile, fixtures } = JSON.parse(process.env.FF_TEST_SUPERVISOR ?? 'null') ?? {};
  if (!stateDir || !instanceId || !configFile || !fixtures?.parentEnv) {
    log({ msg: 'test supervisor configuration incomplete' });
    return 2;
  }
  if (!(await verifyOwnerLock({ lockFile: join(stateDir, 'supervisor', 'owner.lock') }))) {
    log({ msg: 'test supervisor does not hold its owner lock' });
    return 1;
  }
  const backends = {};
  if (fixtures.anthropicUrl) {
    backends['claude-code'] = createClaudeBackend({ privateDir: ensurePrivateDir(join(stateDir, 'supervisor', 'claude-sessions')), log: backendLog, auth: syntheticClaudeAuth({ fixture: { url: fixtures.anthropicUrl } }), parentEnv: fixtures.parentEnv });
  }
  if (fixtures.openaiUrl) {
    backends.codex = createCodexBackend({ log: backendLog, auth: syntheticCodexAuth({ fixture: { url: fixtures.openaiUrl } }), parentEnv: fixtures.parentEnv });
  }
  const containment = fixtures.containment === 'real'
    ? await realTestContainment({ stateDir, instanceId, spawnEnvExtras: fixtures.spawnEnvExtras })
    : testContainment({ spawnEnvExtras: fixtures.spawnEnvExtras });
  if (containment.state !== 'verified') log({ msg: 'test supervisor containment unavailable', reason: containment.reason });
  if (containment.state === 'verified' && (fixtures.dropThreadStart || fixtures.killNoop)) containment.ops = faultOps(containment.ops, fixtures);
  const supervisor = await startSupervisor({ stateDir, instanceId, configFile, backends, containment, log });
  const done = new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
    supervisor.stopped.then(() => resolve('stopped'));
  });
  writeSync(3, 'ready\n');
  closeSync(3);
  await done;
  await supervisor.close();
  if (fixtures.containment === 'real' && containment.state === 'verified') {
    try {
      await containment.close();
    } catch (err) {
      log({ msg: 'test supervisor scope kept', code: err?.code });
    }
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  log({ msg: 'test supervisor crashed', error: err?.message, stack: err?.stack });
  process.exitCode = 1;
});
