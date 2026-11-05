
import { readdir } from 'node:fs/promises';
import net from 'node:net';

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(undefined);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * @param {{ sysClassNet?: string, connect?: (host: string, port: number, timeoutMs: number) => Promise<unknown> }} [opts]
 */
export async function assertNetworkIsolation({ sysClassNet = '/sys/class/net', connect = tcpConnect } = {}) {
  const fail = () => new Error('network_isolation_unavailable');
  let names;
  try {
    names = await readdir(sysClassNet);
  } catch {
    throw fail();
  }
  if (names.length !== 1 || names[0] !== 'lo') throw fail();
  try {
    await connect('192.0.2.1', 9, 1000);
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENETUNREACH') return;
    throw fail();
  }
  throw fail();
}
