import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { assertNetworkIsolation } from '../../native/harness/isolation.js';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-iso-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function netDir(names) {
  const dir = join(root, 'net');
  mkdirSync(dir);
  for (const n of names) mkdirSync(join(dir, n));
  return dir;
}

const unreachable = async () => {
  throw Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' });
};

describe('assertNetworkIsolation', () => {
  it('rejects when an interface other than lo exists', async () => {
    await expect(assertNetworkIsolation({ sysClassNet: netDir(['lo', 'eth0']), connect: unreachable })).rejects.toThrow(
      'network_isolation_unavailable',
    );
  });

  it('rejects when the non-loopback connect does not fail with ENETUNREACH', async () => {
    const dir = netDir(['lo']);
    await expect(assertNetworkIsolation({ sysClassNet: dir, connect: async () => {} })).rejects.toThrow('network_isolation_unavailable');
    const refused = async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    };
    await expect(assertNetworkIsolation({ sysClassNet: dir, connect: refused })).rejects.toThrow('network_isolation_unavailable');
  });

  it('resolves only when both checks pass', async () => {
    await expect(assertNetworkIsolation({ sysClassNet: netDir(['lo']), connect: unreachable })).resolves.toBeUndefined();
  });
});
