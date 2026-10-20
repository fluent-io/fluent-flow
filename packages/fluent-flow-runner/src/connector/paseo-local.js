import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the LOCAL Paseo daemon connection the way the desktop app and CLI
 * do: address from `paseo.pid`, credential from `local-credential`. Both stay
 * on this host; the credential is never logged, never sent to the control
 * plane, and never appears in errors (connection verification happens in the
 * runtime via the actual client connect).
 */

export function parseListen(listen) {
  const value = typeof listen === 'string' ? listen.trim().replace(/^tcp:\/\//, '') : '';
  if (!/^[\w.-]+:\d+$|^\[[\da-f:]+\]:\d+$/i.test(value)) return null;
  const idx = value.lastIndexOf(':');
  const host = value.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = value.slice(idx + 1);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
  if (!loopback) return null;
  return `ws://127.0.0.1:${port}/ws`;
}

/**
 * @param {object} opts
 * @param {string} [opts.home] - paseo home (default ~/.paseo)
 * @param {{readFile?: Function}} [opts.io]
 * @returns {Promise<{url: string, password: string, home: string}>}
 */
export async function resolveLocalDaemon({ home, io = {} } = {}) {
  const read = io.readFile ?? readFile;
  const resolvedHome = home ?? join(homedir(), '.paseo');
  let lock;
  try {
    lock = JSON.parse(await read(join(resolvedHome, 'paseo.pid'), 'utf8'));
  } catch {
    throw new Error('The local Paseo daemon address could not be read (is the desktop app running?).');
  }
  const url = parseListen(lock.listen);
  if (!url) throw new Error('The local Paseo daemon address is not a loopback endpoint.');
  let password = '';
  try {
    password = (await read(join(resolvedHome, 'local-credential'), 'utf8')).trim();
  } catch {
    throw new Error('The local Paseo credential file is unavailable.');
  }
  if (!password) throw new Error('The local Paseo credential file is empty.');
  return { url, password, home: resolvedHome };
}
