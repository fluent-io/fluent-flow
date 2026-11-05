import { describe, it, expect, vi } from 'vitest';
import { runOuter, runInner, planSetup, cgroupPreserved, propagationPrivate } from '../../native/harness/netns-launcher.js';

function outerHarness(results) {
  const calls = [];
  const lines = [];
  const attemptNamespace = vi.fn(async (args, env) => {
    calls.push({ args, mapping: env.FF_NETNS_MAPPING });
    return results[calls.length - 1];
  });
  const opts = { command: ['vitest', 'run'], hasTool: () => true, attemptNamespace, uid: 1000, gid: 1000, execPath: '/node', log: (l) => lines.push(l), env: {} };
  return { calls, lines, opts };
}

describe('runOuter', () => {
  it('falls back to the root mapping when unshare itself fails before the command starts', async () => {
    const h = outerHarness([{ code: 1, signal: null, ready: false }, { code: 0, signal: null, ready: true }]);
    const code = await runOuter(h.opts);
    expect(h.calls.map((c) => c.mapping)).toEqual(['caller', 'root']);
    expect(h.calls[1].args.slice(0, 2)).toEqual(['--user', '--map-root-user']);
    expect(code).toBe(0);
  });

  it('never reruns the command after it started, even when it failed', async () => {
    const h = outerHarness([{ code: 1, signal: null, ready: true }, { code: 0, signal: null, ready: true }]);
    expect(await runOuter(h.opts)).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('passes through a started command exit code 86 without fallback', async () => {
    const h = outerHarness([{ code: 86, signal: null, ready: true }, { code: 0, signal: null, ready: true }]);
    expect(await runOuter(h.opts)).toBe(86);
    expect(h.calls).toHaveLength(1);
  });

  it('reports network_isolation_unavailable when setup fails under both mappings', async () => {
    const h = outerHarness([{ code: 1, signal: null, ready: false }, { code: 86, signal: null, ready: false }]);
    expect(await runOuter(h.opts)).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.lines.some((l) => l.startsWith('network_isolation_unavailable'))).toBe(true);
  });

  it('fails closed without running anything when a tool is missing', async () => {
    const h = outerHarness([]);
    expect(await runOuter({ ...h.opts, hasTool: (t) => t !== 'ip' })).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.lines).toEqual(['network_isolation_unavailable (ip missing)']);
  });
});

function innerHarness({ steps = [() => ({ ok: true })], isolation = async () => {}, exit = { code: 0, signal: null } } = {}) {
  const order = [];
  const lines = [];
  const opts = {
    command: ['vitest', 'run'],
    setupSteps: steps,
    assertIsolation: isolation,
    signalReady: () => order.push('ready'),
    runCommand: async () => {
      order.push('command');
      return exit;
    },
    log: (l) => lines.push(l),
  };
  return { order, lines, opts };
}

describe('runInner', () => {
  it('signals readiness after setup and isolation, before the command', async () => {
    const h = innerHarness();
    expect(await runInner(h.opts)).toBe(0);
    expect(h.order).toEqual(['ready', 'command']);
  });

  it('returns the command exit code 86 unchanged', async () => {
    const h = innerHarness({ exit: { code: 86, signal: null } });
    expect(await runInner(h.opts)).toBe(86);
  });

  it('a failed setup step runs nothing and never signals readiness', async () => {
    const h = innerHarness({ steps: [() => ({ ok: false, detail: 'ip link set lo up: EPERM' })] });
    expect(await runInner(h.opts)).not.toBe(0);
    expect(h.order).toEqual([]);
  });

  it('a failed isolation proof runs nothing and never signals readiness', async () => {
    const h = innerHarness({
      isolation: async () => {
        throw new Error('network_isolation_unavailable');
      },
    });
    expect(await runInner(h.opts)).toBe(1);
    expect(h.order).toEqual([]);
    expect(h.lines).toContain('network_isolation_unavailable');
  });
});

const ROOT_LINE = '22 1 259:7 / / rw,relatime - ext4 /dev/nvme0n1p7 rw';
const SYS_LINE = '24 22 0:22 / /sys rw,nosuid - sysfs sysfs rw';
const CG_LINE = '38 24 0:32 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw,nsdelegate';
const info = (...lines) => `${lines.join('\n')}\n`;

describe('cgroup preservation across the namespace-local sysfs remount', () => {
  it('saves the existing cgroup mount privately before the sysfs remount and restores it after', () => {
    const plan = planSetup({ cgroupMounted: true, savedDir: '/tmp/ff-netns-cgroup-x' });
    expect(plan).toEqual([
      ['mount', ['--make-rprivate', '/']],
      ['ip', ['link', 'set', 'lo', 'up']],
      ['mount', ['--rbind', '/sys/fs/cgroup', '/tmp/ff-netns-cgroup-x']],
      ['mount', ['-t', 'sysfs', 'sysfs', '/sys']],
      ['mount', ['--rbind', '/tmp/ff-netns-cgroup-x', '/sys/fs/cgroup']],
      ['umount', ['-l', '/tmp/ff-netns-cgroup-x']],
    ]);
  });

  it('never invents a cgroup mount when none existed', () => {
    expect(planSetup({ cgroupMounted: false, savedDir: null })).toEqual([
      ['mount', ['--make-rprivate', '/']],
      ['ip', ['link', 'set', 'lo', 'up']],
      ['mount', ['-t', 'sysfs', 'sysfs', '/sys']],
    ]);
  });

  it('a sysfs remount that shadows the original cgroup mount is not preserved', () => {
    const before = info(ROOT_LINE, SYS_LINE, CG_LINE);
    const shadowed = info(ROOT_LINE, SYS_LINE, CG_LINE, '90 24 0:60 / /sys rw - sysfs sysfs rw');
    expect(cgroupPreserved(before, shadowed)).toBe(false);
    const restored = info(ROOT_LINE, SYS_LINE, CG_LINE, '90 24 0:60 / /sys rw - sysfs sysfs rw', '92 90 0:32 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw,nsdelegate');
    expect(cgroupPreserved(before, restored)).toBe(true);
    const other = info(ROOT_LINE, SYS_LINE, CG_LINE, '90 24 0:60 / /sys rw - sysfs sysfs rw', '92 90 0:99 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw');
    expect(cgroupPreserved(before, other)).toBe(false);
    expect(cgroupPreserved(info(ROOT_LINE, SYS_LINE), info(ROOT_LINE, SYS_LINE, '90 24 0:60 / /sys rw - sysfs sysfs rw'))).toBe(true);
  });

  it('shared propagation is detected', () => {
    expect(propagationPrivate(info(ROOT_LINE, SYS_LINE))).toBe(true);
    expect(propagationPrivate(info('22 1 259:7 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p7 rw', SYS_LINE))).toBe(false);
    expect(propagationPrivate(info('22 1 259:7 / / rw,relatime master:1 - ext4 /dev/nvme0n1p7 rw'))).toBe(false);
  });

  it('cleanup runs after setup whether it succeeded or failed, and a failed cleanup runs nothing', async () => {
    const ok = innerHarness();
    ok.opts.cleanup = () => { ok.order.push('cleanup'); return { ok: true }; };
    expect(await runInner(ok.opts)).toBe(0);
    expect(ok.order).toEqual(['cleanup', 'ready', 'command']);

    const failed = innerHarness({ steps: [() => ({ ok: false, detail: 'mount: EPERM' })] });
    failed.opts.cleanup = () => { failed.order.push('cleanup'); return { ok: true }; };
    expect(await runInner(failed.opts)).toBe(1);
    expect(failed.order).toEqual(['cleanup']);

    const dirty = innerHarness();
    dirty.opts.cleanup = () => ({ ok: false, detail: 'rmdir: EBUSY' });
    expect(await runInner(dirty.opts)).toBe(1);
    expect(dirty.order).toEqual([]);
  });
});

describe('netns launcher database bridge (Task 7)', () => {
  const URL = 'postgres://ffuser@127.0.0.1:55432/ff_connector_optional_paseo_test';

  it('without a connector test database URL there is no bridge', async () => {
    const h = outerHarness([{ code: 0, signal: null, ready: true }]);
    const startBridge = vi.fn();
    expect(await runOuter({ ...h.opts, startBridge })).toBe(0);
    expect(startBridge).not.toHaveBeenCalled();
  });

  it('starts the outside bridge before unsharing, passes the URL through unchanged and closes it with the suite', async () => {
    const order = [];
    const h = outerHarness([{ code: 0, signal: null, ready: true }]);
    const env = { COLLAB_CONNECTOR_TEST_DATABASE_URL: URL, DATABASE_URL: URL };
    const startBridge = vi.fn(async ({ databaseUrl }) => {
      order.push(`bridge:${databaseUrl}`);
      return { socketPath: '/tmp/ff-db-bridge-x/db.sock', close: async () => order.push('closed') };
    });
    const attemptNamespace = vi.fn(async (_args, childEnv) => {
      order.push('unshare');
      expect(childEnv.COLLAB_CONNECTOR_TEST_DATABASE_URL).toBe(URL);
      expect(childEnv.DATABASE_URL).toBe(URL);
      expect(childEnv.FF_DB_BRIDGE_SOCKET).toBe('/tmp/ff-db-bridge-x/db.sock');
      return { code: 3, signal: null, ready: true };
    });
    expect(await runOuter({ ...h.opts, env, attemptNamespace, startBridge })).toBe(3);
    expect(order).toEqual([`bridge:${URL}`, 'unshare', 'closed']);
  });

  it('a non-127.0.0.1 or portless URL exits database_bridge_refused before any namespace', async () => {
    for (const url of ['postgres://u@localhost:55432/ff_connector_x', 'postgres://u@127.0.0.1/ff_connector_x']) {
      const h = outerHarness([{ code: 0, signal: null, ready: true }]);
      expect(await runOuter({ ...h.opts, env: { COLLAB_CONNECTOR_TEST_DATABASE_URL: url } }), url).toBe(1);
      expect(h.calls, url).toEqual([]);
      expect(h.lines.some((l) => l.includes('database_bridge_refused')), url).toBe(true);
    }
  });

  it('inside, the forwarder starts after setup (lo up), runs while isolation is asserted and the command runs, and closes after', async () => {
    const order = [];
    const startInsideBridge = vi.fn(async () => {
      order.push('forwarder');
      return { close: async () => order.push('forwarder-closed') };
    });
    const code = await runInner({
      command: ['vitest'], setupSteps: [() => { order.push('setup'); return { ok: true }; }], cleanup: () => ({ ok: true }),
      startInsideBridge,
      assertIsolation: async () => { order.push('isolation'); },
      signalReady: () => order.push('ready'),
      runCommand: async () => { order.push('command'); return { code: 0, signal: null }; },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(order).toEqual(['setup', 'forwarder', 'isolation', 'ready', 'command', 'forwarder-closed']);
    startInsideBridge.mockClear();
    expect(await runInner({ command: ['x'], setupSteps: [() => ({ ok: false, detail: 'no' })], startInsideBridge, assertIsolation: async () => {}, signalReady: () => {}, runCommand: async () => ({ code: 0 }), log: () => {} })).toBe(1);
    expect(startInsideBridge).not.toHaveBeenCalled();
  });
});
