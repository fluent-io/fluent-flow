import { readProcessIdentity, sameProcess } from './process-identity.js';

const POLL_MS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function terminateVerified({ pgid, identity }) {
  if (!identity || !Number.isSafeInteger(pgid) || pgid <= 1 || pgid !== identity.pid) return false;
  if (!sameProcess(identity, await readProcessIdentity(identity.pid))) return false;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
  return true;
}

async function waitEmpty(containment, cgroupPath, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    let populated;
    try {
      ({ populated } = await containment.read({ cgroupPath }));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      populated = null;
    }
    if (populated === false) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * @param {{ worker: { sessionId: string, generation: number, cgroupPath: string, pgid?: number | null, identity?: { pid: number, startTicks: number, bootId: string } | null }, containment: { read: Function, kill: Function, terminate?: Function }, graceMs?: number, killWaitMs?: number }} opts
 * @returns {Promise<'quiesced' | 'uncertain'>}
 */
export async function stopContained({ worker, containment, graceMs = 10_000, killWaitMs = 5_000 }) {
  const { cgroupPath, generation, sessionId } = worker;
  const signalled = worker.identity && typeof containment.terminate === 'function' ? await containment.terminate({ pgid: worker.pgid ?? null, identity: worker.identity }) : false;
  if (signalled && (await waitEmpty(containment, cgroupPath, graceMs))) return 'quiesced';
  await containment.kill({ cgroupPath, generation, sessionId });
  return (await waitEmpty(containment, cgroupPath, killWaitMs)) ? 'quiesced' : 'uncertain';
}
