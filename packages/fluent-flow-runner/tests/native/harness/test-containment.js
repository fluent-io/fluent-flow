import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { ContainmentError, containmentOps, instanceHashFor, probeContainment, spawnContained } from '../../../src/supervisor/containment.js';
import { terminateVerified } from '../../../src/supervisor/stop.js';
import { parseStat, readProcessDetails, readProcessIdentity, sameProcess } from '../../../src/supervisor/process-identity.js';

const SCOPE = 'test-containment';

/**
 * @param {{ spawnEnvExtras?: Record<string, string> }} [opts] - test-only additions to every native child environment
 */
export function testContainment({ spawnEnvExtras = {} } = {}) {
  const groups = new Map();
  const leafPath = ({ generation, sessionId }) => `${SCOPE}/w-${generation}-${sessionId}`;

  function alive(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') return false;
      throw err;
    }
  }

  return {
    state: 'verified',
    scopePath: SCOPE,
    async close() {},
    ops: {
      leafPath,
      createWorker({ generation, sessionId }) {
        const key = leafPath({ generation, sessionId });
        groups.set(key, { pgid: null });
        return key;
      },
      async spawn({ cgroupPath, executable, args = [], env, cwd }) {
        const group = groups.get(cgroupPath);
        if (!group) throw new ContainmentError('not_owned_leaf', `No test leaf ${cgroupPath}`);
        const child = spawn(executable, args, { env: { ...env, ...spawnEnvExtras }, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        group.pgid = child.pid;
        const identity = await readProcessIdentity(child.pid);
        return { child, identity };
      },
      leaf({ cgroupPath, generation, sessionId }) {
        if (cgroupPath !== leafPath({ generation, sessionId })) throw new ContainmentError('not_owned_leaf', `Not the recorded test leaf: ${cgroupPath}`);
        if (!groups.has(cgroupPath)) throw new ContainmentError('leaf_missing', `Test leaf ${cgroupPath} is unknown to this lifetime`);
        return cgroupPath;
      },
      async read({ cgroupPath }) {
        const group = groups.get(cgroupPath);
        if (!group) throw Object.assign(new Error('test leaf gone'), { code: 'ENOENT' });
        const populated = group.pgid !== null && alive(group.pgid);
        const pids = [];
        if (populated) {
          for (const name of readdirSync('/proc')) {
            if (!/^[0-9]+$/.test(name)) continue;
            let raw;
            try {
              raw = readFileSync(`/proc/${name}/stat`, 'utf8');
            } catch (err) {
              if (err.code === 'ENOENT' || err.code === 'ESRCH') continue;
              throw err;
            }
            if (parseStat(raw)?.pgid !== group.pgid) continue;
            const details = await readProcessDetails(Number(name));
            if (details && details.pgid === group.pgid) pids.push(details);
          }
        }
        return { populated, pids };
      },
      async holds({ cgroupPath, identity }) {
        const group = groups.get(cgroupPath);
        const details = await readProcessDetails(identity.pid);
        if (!details || !sameProcess(details, identity)) return null;
        return Boolean(group?.pgid) && details.pgid === group.pgid;
      },
      terminate: terminateVerified,
      async kill({ cgroupPath }) {
        const group = groups.get(cgroupPath);
        if (!group?.pgid) return;
        try {
          process.kill(-group.pgid, 'SIGKILL');
        } catch (err) {
          if (err.code !== 'ESRCH') throw err;
        }
      },
    },
  };
}

export async function realTestContainment({ stateDir, instanceId, spawnEnvExtras = {} }) {
  const containment = await probeContainment({ instanceHash: instanceHashFor({ stateDir, instanceId }) });
  if (containment.state !== 'verified') return containment;
  const ops = containmentOps(containment);
  return { ...containment, ops: { ...ops, spawn: (opts) => spawnContained({ ...opts, env: { ...opts.env, ...spawnEnvExtras } }) } };
}
