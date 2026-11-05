#!/usr/bin/env node
import { fstatSync, closeSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instanceHashFor, probeContainment } from '../src/supervisor/containment.js';
import { ensurePrivateDir, verifyOwnerLock } from '../src/supervisor/owner-lock.js';
import { startSupervisor } from '../src/supervisor/supervisor.js';
import { createClaudeBackend } from '../src/native/claude-backend.js';
import { createCodexBackend } from '../src/native/codex-backend.js';
import { claudeSubscriptionAuth } from '../src/native/claude-auth.js';
import { chatgptSubscriptionAuth } from '../src/native/codex-auth.js';

const log = (record) => console.error(JSON.stringify({ time: new Date().toISOString(), ...record }));
const backendLog = { info: log, warn: log, error: log, debug: () => {} };
const { FF_SUPERVISOR_STATE_DIR: stateDir, FF_SUPERVISOR_INSTANCE: instanceId, FF_SUPERVISOR_CONFIG: configFile } = process.env;

function readyFdOpen() {
  try {
    const st = fstatSync(3);
    return st.isFIFO() || st.isSocket();
  } catch (err) {
    if (err.code === 'EBADF') return false;
    throw err;
  }
}

async function main() {
  if (!stateDir || !instanceId || !configFile) {
    log({ msg: 'supervisor environment incomplete' });
    return 2;
  }
  if (!(await verifyOwnerLock({ lockFile: join(resolve(stateDir), 'supervisor', 'owner.lock') }))) {
    log({ msg: 'supervisor failed to start', code: 'owner_lock_not_held' });
    return 1;
  }
  const containment = await probeContainment({ instanceHash: instanceHashFor({ stateDir, instanceId }) });
  const claudePrivateDir = ensurePrivateDir(join(resolve(stateDir), 'supervisor', 'claude-sessions'));
  const backends = {
    'claude-code': createClaudeBackend({ privateDir: claudePrivateDir, log: backendLog, auth: claudeSubscriptionAuth() }),
    codex: createCodexBackend({ log: backendLog, auth: chatgptSubscriptionAuth() }),
  };
  let supervisor;
  try {
    supervisor = await startSupervisor({ stateDir, instanceId, configFile, backends, containment, log });
  } catch (err) {
    log({ msg: 'supervisor failed to start', code: err.code, error: err.message });
    if (containment.state === 'verified') await containment.close();
    return 1;
  }
  const done = new Promise((resolveDone) => {
    const shutdown = (signal) => resolveDone(signal);
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    supervisor.stopped.then(() => resolveDone('stopped'));
  });
  if (readyFdOpen()) {
    writeSync(3, 'ready\n');
    closeSync(3);
  }
  const signal = await done;
  log({ msg: 'supervisor stopping', signal });
  try {
    await supervisor.close();
  } finally {
    if (containment.state === 'verified') await containment.close();
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  log({ msg: 'supervisor crashed', code: err?.code, error: err?.message });
  process.exitCode = 1;
});
