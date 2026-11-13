import { hostname, platform } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentServer } from '../../src/server.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Expected deterministic condition was not reached');
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(overrides = {}) {
  const events = [];
  const runners = [];
  const runnerOptions = [];
  const clients = [];
  const health = {
    start: vi.fn(async () => { events.push('health:start'); }),
    stop: vi.fn(async () => { events.push('health:stop'); }),
  };
  const createHealthServer = vi.fn(() => health);
  const createClient = vi.fn((options) => {
    clients.push(options);
    return {
      enroll: vi.fn(async () => {
        events.push('enroll');
        return 'ff_enrolled_durable';
      }),
    };
  });
  const createRunner = vi.fn((options) => {
    const index = runners.length;
    let run = deferred();
    let online = false;
    let activeWork = null;
    let shutdownCalls = 0;
    let pollFailures = 0;
    let cleanupFailed = false;
    const startWaiters = [];
    const runner = {
      sessionOnStart: true,
      start: vi.fn(() => {
        events.push(`runner:${index}:start`);
        run = deferred();
        online = runner.sessionOnStart;
        for (const waiter of startWaiters.splice(0)) {
          if (runner.start.mock.calls.length >= waiter.count) waiter.resolve();
          else startWaiters.push(waiter);
        }
        return run.promise;
      }),
      shutdown: vi.fn(async () => {
        shutdownCalls += 1;
        events.push(`runner:${index}:shutdown`);
        online = false;
        run.resolve();
      }),
      get sessionId() {
        return online ? `session-${index}` : null;
      },
      get activeWork() {
        return activeWork;
      },
      get consecutivePollFailures() {
        return pollFailures;
      },
      get cleanupFailed() {
        return cleanupFailed;
      },
      setActive(work) {
        activeWork = work;
      },
      setPollFailures(count) {
        pollFailures = count;
      },
      setCleanupFailed(value) {
        cleanupFailed = value;
      },
      whenStarted(count) {
        if (runner.start.mock.calls.length >= count) return Promise.resolve();
        const waiter = deferred();
        startWaiters.push({ count, resolve: waiter.resolve });
        return waiter.promise;
      },
      fail(error) {
        online = false;
        run.reject(error);
      },
      get shutdownCalls() {
        return shutdownCalls;
      },
    };
    runnerOptions.push(options);
    runners.push(runner);
    return runner;
  });
  const dependencies = {
    loadOrCreateState: vi.fn(async () => {
      events.push('state:load');
      return { instanceId: 'instance-stable', token: 'ff_stored_durable' };
    }),
    storeRuntimeToken: vi.fn(async () => { events.push('state:store'); }),
    readTokenFile: vi.fn(async () => {
      events.push('token-file:read');
      return 'ff_file_durable\n';
    }),
    probeTools: vi.fn(() => {
      events.push('probe');
    }),
    cleanStaleWorktrees: vi.fn(async () => {
      events.push('worktrees:clean');
    }),
    createClient,
    createRunner,
    createHealthServer,
  };
  const options = {
    capacity: 2,
    serverUrl: 'https://flow.example.com',
    provider: 'claude-code',
    deployment: 'local',
    stateDir: '/private/state',
    workDir: '/work',
    tokenFile: null,
    enrollmentToken: null,
    packageVersion: '0.2.0',
    healthHost: '127.0.0.1',
    healthPort: 3860,
    providerEnvironment: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'provider-only' },
    ...dependencies,
    ...overrides,
  };
  return { options, events, runners, runnerOptions, clients, health, createHealthServer };
}

async function startHarness(harness) {
  const server = createAgentServer(harness.options);
  const startPromise = server.start();
  startPromise.catch(() => {});
  await until(() => harness.runners.length === harness.options.capacity);
  await until(() => harness.runners.every((runner) => runner.start.mock.calls.length === 1));
  return { server, startPromise };
}

describe('portable agent server composition', () => {
  it('loads the operator-local opt-in catalog and shares safe chat startup/workspaces across slots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ff-server-chat-'));
    const profiles = [{ id: 'safe', permission: { configId: 'approval', value: 'ask' }, models: [] }];
    const path = join(root, 'profiles.json'); await writeFile(path, JSON.stringify(profiles));
    const h = createHarness({ workDir: join(root, 'work'), stateDir: join(root, 'state'), chatProfilesFile: path });
    const server = createAgentServer(h.options); const run = server.start();
    try {
      for (let i=0; i<600 && h.runners.length !== 2; i++) await new Promise((r) => setTimeout(r, 5));
      expect(h.runnerOptions).toHaveLength(2);
      expect(h.runnerOptions[0].chat).toEqual({ enabled: true, profiles });
      expect(h.runnerOptions[0].chatWorkspaceManager).toBe(h.runnerOptions[1].chatWorkspaceManager);
      expect(h.runnerOptions[0].chatWorkspaceManager.root).toBe(join(root, 'state', 'chat-workspaces'));
    } finally { await server.shutdown(); await run; await rm(root, { recursive: true, force: true }); }
  });
  it('loads private state and resolves a durable token before constructing any runner', async () => {
    const harness = createHarness({ tokenFile: '/run/secrets/runtime-token' });
    harness.options.createRunner = vi.fn((options) => {
      harness.events.push('runner:construct');
      const startBarrier = deferred();
      return {
        start: vi.fn(() => startBarrier.promise),
        shutdown: vi.fn(async () => { startBarrier.resolve(); }),
        sessionId: null,
        activeWork: null,
        consecutivePollFailures: 0,
        cleanupFailed: false,
      };
    });
    const server = createAgentServer(harness.options);
    server.start().catch(() => {});

    await until(() => harness.options.createRunner.mock.calls.length === 2);

    expect(harness.events.indexOf('state:load')).toBeLessThan(harness.events.indexOf('token-file:read'));
    expect(harness.events.indexOf('token-file:read')).toBeLessThan(harness.events.indexOf('runner:construct'));
    await server.shutdown();
  });

  it('prefers the durable token file over stored state and enrollment', async () => {
    const harness = createHarness({
      tokenFile: '/run/secrets/runtime-token',
      enrollmentToken: 'enroll_should_not_be_used',
    });
    const { server } = await startHarness(harness);

    expect(harness.options.readTokenFile).toHaveBeenCalledOnce();
    expect(harness.options.storeRuntimeToken).not.toHaveBeenCalled();
    expect(harness.runnerOptions.every(({ runnerToken }) => runnerToken === 'ff_file_durable')).toBe(true);
    expect(harness.clients.flatMap(({ token }) => token).includes('enroll_should_not_be_used')).toBe(false);
    await server.shutdown();
  });

  it('uses stored private-state token without reading a token file or enrolling', async () => {
    const harness = createHarness({ enrollmentToken: 'enroll_should_not_be_used' });
    const { server } = await startHarness(harness);

    expect(harness.options.readTokenFile).not.toHaveBeenCalled();
    expect(harness.options.storeRuntimeToken).not.toHaveBeenCalled();
    expect(harness.runnerOptions.every(({ runnerToken }) => runnerToken === 'ff_stored_durable')).toBe(true);
    expect(harness.events).not.toContain('enroll');
    await server.shutdown();
  });

  it('exchanges enrollment exactly once and stores the durable token before constructing runners', async () => {
    const harness = createHarness({ enrollmentToken: 'enroll_single_use' });
    harness.options.loadOrCreateState.mockImplementation(async () => {
      harness.events.push('state:load');
      return { instanceId: 'instance-stable', token: null };
    });
    const originalCreateRunner = harness.options.createRunner;
    harness.options.createRunner = vi.fn((options) => {
      harness.events.push('runner:construct');
      return originalCreateRunner(options);
    });
    const { server } = await startHarness(harness);
    const enrollmentClients = harness.options.createClient.mock.results
      .map(({ value }) => value)
      .filter((client) => client.enroll.mock.calls.length > 0);

    expect(enrollmentClients).toHaveLength(1);
    expect(enrollmentClients[0].enroll).toHaveBeenCalledOnce();
    expect(enrollmentClients[0].enroll).toHaveBeenCalledWith('enroll_single_use', 'instance-stable');
    expect(harness.options.storeRuntimeToken).toHaveBeenCalledWith(
      '/private/state',
      'instance-stable',
      'ff_enrolled_durable',
    );
    expect(harness.events.indexOf('state:store')).toBeLessThan(harness.events.indexOf('runner:construct'));
    expect(harness.runnerOptions.every(({ runnerToken }) => runnerToken === 'ff_enrolled_durable')).toBe(true);
    await server.shutdown();
  });

  describe('enrollment credential lifetime', () => {
    function enrollingHarness(enroll) {
      const harness = createHarness({ enrollmentToken: 'enroll_single_use' });
      harness.options.loadOrCreateState.mockResolvedValue({ instanceId: 'instance-stable', token: null });
      harness.options.createClient = vi.fn((options) => {
        harness.clients.push(options);
        return { enroll };
      });
      return harness;
    }

    it('leaves the credential usable for the next start attempt after a transport failure', async () => {
      const enroll = vi.fn()
        .mockRejectedValueOnce(new Error('Enrollment failed: 503'))
        .mockResolvedValue('ff_enrolled_durable');
      const harness = enrollingHarness(enroll);
      const server = createAgentServer(harness.options);

      await expect(server.start()).rejects.toThrow('Enrollment failed: 503');
      expect(harness.options.createRunner).not.toHaveBeenCalled();

      const retry = server.start();
      retry.catch(() => {});
      await until(() => harness.runners.length === harness.options.capacity);

      expect(enroll).toHaveBeenCalledTimes(2);
      expect(enroll.mock.calls.map(([credential]) => credential)).toEqual(['enroll_single_use', 'enroll_single_use']);
      expect(harness.runnerOptions.every(({ runnerToken }) => runnerToken === 'ff_enrolled_durable')).toBe(true);
      await server.shutdown();
    });

    it('does not reuse a credential after a successful exchange even when storing the token fails', async () => {
      const enroll = vi.fn(async () => 'ff_enrolled_durable');
      const harness = enrollingHarness(enroll);
      harness.options.storeRuntimeToken.mockRejectedValueOnce(new Error('state write failed'));
      const server = createAgentServer(harness.options);

      await expect(server.start()).rejects.toThrow('state write failed');
      await expect(server.start()).rejects.toThrow('No durable credential or enrollment credential is available.');

      expect(enroll).toHaveBeenCalledTimes(1);
      expect(harness.options.createRunner).not.toHaveBeenCalled();
    });

    it('does not retry a start that already constructed runners', async () => {
      const harness = createHarness();
      harness.health.start.mockRejectedValueOnce(new Error('health bind failed'));
      const server = createAgentServer(harness.options);

      await expect(server.start()).rejects.toThrow('health bind failed');
      await expect(server.start()).rejects.toThrow('health bind failed');

      expect(harness.options.createRunner).toHaveBeenCalledTimes(harness.options.capacity);
      expect(harness.health.start).toHaveBeenCalledTimes(1);
      await server.shutdown();
    });
  });

  it('passes the configured provider to every runner', async () => {
    const harness = createHarness({ provider: 'codex' });
    const { server } = await startHarness(harness);

    expect(harness.runnerOptions).toHaveLength(2);
    expect(harness.runnerOptions.every(({ provider }) => provider === 'codex')).toBe(true);
    await server.shutdown();
  });

  describe('stale worktree cleanup at start', () => {
    it('runs after the probe and before any runner is constructed', async () => {
      const harness = createHarness();
      const { server } = await startHarness(harness);

      expect(harness.options.cleanStaleWorktrees).toHaveBeenCalledOnce();
      expect(harness.options.cleanStaleWorktrees).toHaveBeenCalledWith(expect.objectContaining({
        workDir: '/work',
        environment: harness.options.providerEnvironment,
        log: expect.any(Object),
      }));
      expect(harness.events.indexOf('probe')).toBeLessThan(harness.events.indexOf('worktrees:clean'));
      expect(harness.events.indexOf('worktrees:clean')).toBeLessThan(harness.events.indexOf('runner:0:start'));
      await server.shutdown();
    });

    it('fails startup before runners exist when the cleanup fails loudly', async () => {
      const harness = createHarness();
      harness.options.cleanStaleWorktrees.mockRejectedValueOnce(new Error('work directory unreadable'));
      const server = createAgentServer(harness.options);

      await expect(server.start()).rejects.toThrow('work directory unreadable');
      expect(harness.options.createRunner).not.toHaveBeenCalled();
      expect(harness.options.createHealthServer).not.toHaveBeenCalled();
    });
  });

  it('fails before runner construction when no durable or enrollment source exists', async () => {
    const harness = createHarness();
    harness.options.loadOrCreateState.mockResolvedValue({ instanceId: 'instance-stable', token: null });
    const server = createAgentServer(harness.options);

    await expect(server.start()).rejects.toThrow();
    expect(harness.options.createRunner).not.toHaveBeenCalled();
    expect(harness.options.createHealthServer).not.toHaveBeenCalled();
  });

  it('constructs and starts exactly capacity existing runners with stable per-slot metadata', async () => {
    const harness = createHarness({ capacity: 3, provider: 'codex', deployment: 'hosted' });
    const { server } = await startHarness(harness);
    const expectedMeta = (slotId) => ({
      runtime: 'agent-server',
      instance_id: 'instance-stable',
      slot_id: slotId,
      capacity: 3,
      version: '0.2.0',
      provider: 'codex',
      deployment: 'hosted',
      hostname: expect.any(String),
      os: expect.any(String),
    });

    expect(harness.options.createRunner).toHaveBeenCalledTimes(3);
    expect(harness.runnerOptions.map(({ meta }) => meta)).toEqual([
      expectedMeta(0),
      expectedMeta(1),
      expectedMeta(2),
    ]);
    expect(harness.runners.every((runner) => runner.start.mock.calls.length === 1)).toBe(true);
    await server.shutdown();
  });

  it('reports the node hostname and platform in every slot metadata', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);

    for (const { meta } of harness.runnerOptions) {
      expect(meta.hostname).toBe(hostname());
      expect(meta.os).toBe(platform());
    }
    await server.shutdown();
  });

  it('allows both configured slots to be active without constructing a third claim slot', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].setActive({ claim_id: 101 });
    harness.runners[1].setActive({ claim_id: 102 });

    expect(server.getStatus()).toEqual({
      status: 'healthy',
      instance_id: 'instance-stable',
      provider: 'claude-code',
      capacity: 2,
      active: 2,
      online_slots: 2,
    });
    expect(harness.options.createRunner).toHaveBeenCalledTimes(2);
    await server.shutdown();
  });

  it('keeps a healthy runner online and reports degraded when a sibling start rejects', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].fail(new Error('slot registration failed'));
    await until(() => server.getStatus().online_slots === 1);

    expect(harness.runners[1].shutdown).not.toHaveBeenCalled();
    expect(server.getStatus()).toEqual({
      status: 'degraded',
      instance_id: 'instance-stable',
      provider: 'claude-code',
      capacity: 2,
      active: 0,
      online_slots: 1,
    });
    await server.shutdown();
  });

  it('reports unhealthy when no slot can claim work', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].fail(new Error('slot zero failed'));
    harness.runners[1].fail(new Error('slot one failed'));
    await until(() => server.getStatus().online_slots === 0);

    expect(server.getStatus()).toEqual({
      status: 'unhealthy',
      instance_id: 'instance-stable',
      provider: 'claude-code',
      capacity: 2,
      active: 0,
      online_slots: 0,
    });
    await server.shutdown();
  });

  it('exposes only allowlisted aggregate status fields', async () => {
    const harness = createHarness({
      tokenFile: '/run/secrets/runtime-token',
      providerSecretFile: '/run/secrets/provider',
    });
    const { server } = await startHarness(harness);
    const serialized = JSON.stringify(server.getStatus());

    expect(Object.keys(server.getStatus()).sort()).toEqual([
      'active', 'capacity', 'instance_id', 'online_slots', 'provider', 'status',
    ]);
    expect(serialized).not.toContain('ff_file_durable');
    expect(serialized).not.toContain('/run/secrets');
    expect(serialized).not.toContain('provider-only');
    expect(serialized).not.toContain('session-');
    await server.shutdown();
  });

  it('passes only selected provider environment to every runner child', async () => {
    const providerEnvironment = {
      PATH: '/usr/bin',
      CODEX_AUTH_JSON: '{"tokens":{"access_token":"provider-secret"}}',
    };
    const harness = createHarness({
      provider: 'codex',
      enrollmentToken: 'enrollment-secret',
      providerEnvironment,
    });
    const { server } = await startHarness(harness);

    for (const options of harness.runnerOptions) {
      expect(options.childEnvironment).toEqual(providerEnvironment);
      expect(options.childEnvironment).not.toHaveProperty('FLUENT_FLOW_TOKEN');
      expect(JSON.stringify(options.childEnvironment)).not.toContain('ff_stored_durable');
      expect(JSON.stringify(options.childEnvironment)).not.toContain('enrollment-secret');
    }
    await server.shutdown();
  });

  it('makes concurrent shutdown idempotent and awaits every runner drain and health close', async () => {
    const harness = createHarness();
    const runnerDrains = [deferred(), deferred()];
    const healthClose = deferred();
    const { server, startPromise } = await startHarness(harness);
    harness.runners.forEach((runner, index) => {
      runner.shutdown.mockImplementationOnce(async () => {
        harness.events.push(`runner:${index}:shutdown`);
        await runnerDrains[index].promise;
        runner.fail(new Error(`slot ${index} stopped`));
      });
    });
    harness.health.stop.mockImplementationOnce(async () => {
      harness.events.push('health:stop');
      await healthClose.promise;
    });

    const first = server.shutdown();
    const second = server.shutdown();
    const third = server.shutdown();
    let settled = false;
    first.then(() => { settled = true; });
    await until(() => harness.runners.every((runner) => runner.shutdown.mock.calls.length === 1));

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(harness.health.stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    runnerDrains[0].resolve();
    runnerDrains[1].resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    healthClose.resolve();
    await first;
    await startPromise;
    expect(harness.runners.every((runner) => runner.shutdown.mock.calls.length === 1)).toBe(true);
  });

  it('logs each underlying shutdown error through log.error, redacted, before rejecting with the aggregate', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false };
    log.child = () => log;
    const harness = createHarness({ log });
    const { server } = await startHarness(harness);
    harness.runners[0].shutdown.mockImplementationOnce(async () => {
      harness.runners[0].fail(new Error('slot stopped'));
      throw new Error('runner shutdown failed for ff_secret_shutdown_token');
    });
    harness.health.stop.mockRejectedValueOnce(new Error('health close failed with enroll_secret_health_token'));

    const error = await server.shutdown().then(() => null, (reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    const entries = log.error.mock.calls.filter(([, fields]) => (
      fields?.reason === 'runner shutdown failed for [REDACTED]'
      || fields?.reason === 'health close failed with [REDACTED]'
    ));
    expect(entries).toHaveLength(2);
    expect(entries.every(([message]) => typeof message === 'string')).toBe(true);
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('ff_secret_shutdown_token');
    expect(serialized).not.toContain('enroll_secret_health_token');
  });

  it('does not construct or start new runners after shutdown begins', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    const shutdown = server.shutdown();

    await expect(server.start()).rejects.toThrow();
    await shutdown;
    expect(harness.options.createRunner).toHaveBeenCalledTimes(2);
    expect(harness.runners.every((runner) => runner.start.mock.calls.length === 1)).toBe(true);
  });
});

async function expectRestartAfter(runner, delayMs, expectedStarts) {
  await settle();
  expect(runner.start).toHaveBeenCalledTimes(expectedStarts - 1);
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  await settle();
  expect(runner.start).toHaveBeenCalledTimes(expectedStarts - 1);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(runner.start).toHaveBeenCalledTimes(expectedStarts);
}

describe('portable agent server runner restart supervision', () => {
  it('restarts a runner whose start rejects without touching its sibling', async () => {
    const harness = createHarness({ restartBaseMs: 1, restartMaxMs: 4 });
    const { server } = await startHarness(harness);

    harness.runners[0].fail(new Error('slot registration failed'));
    await harness.runners[0].whenStarted(2);
    await until(() => server.getStatus().online_slots === 2);

    expect(harness.runners[0].start).toHaveBeenCalledTimes(2);
    expect(harness.runners[1].start).toHaveBeenCalledTimes(1);
    expect(harness.runners[1].shutdown).not.toHaveBeenCalled();
    expect(harness.options.createRunner).toHaveBeenCalledTimes(2);
    expect(server.getStatus().status).toBe('healthy');
    await server.shutdown();
  });

  it('keeps a failed slot offline during its backoff wait and online again after the restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness({ restartBaseMs: 1000, restartMaxMs: 4000 });
    const { server } = await startHarness(harness);

    harness.runners[0].fail(new Error('slot registration failed'));
    await settle();

    expect(server.getStatus()).toMatchObject({ status: 'degraded', online_slots: 1 });
    expect(harness.runners[0].start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(harness.runners[0].start).toHaveBeenCalledTimes(2);
    expect(server.getStatus()).toMatchObject({ status: 'healthy', online_slots: 2 });
    await server.shutdown();
  });

  it('doubles the restart delay per consecutive failure and caps it at restartMaxMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness({ restartBaseMs: 1000, restartMaxMs: 4000 });
    const { server } = await startHarness(harness);
    const [runner, sibling] = harness.runners;
    runner.sessionOnStart = false;

    runner.fail(new Error('first failure'));
    await expectRestartAfter(runner, 1000, 2);
    runner.fail(new Error('second failure'));
    await expectRestartAfter(runner, 2000, 3);
    runner.fail(new Error('third failure'));
    await expectRestartAfter(runner, 4000, 4);
    runner.fail(new Error('fourth failure'));
    await expectRestartAfter(runner, 4000, 5);

    expect(sibling.start).toHaveBeenCalledTimes(1);
    expect(sibling.shutdown).not.toHaveBeenCalled();
    await server.shutdown();
  });

  it('defaults to a 2000 ms base delay and a 60000 ms cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness();
    const { server } = await startHarness(harness);
    const [runner] = harness.runners;
    runner.sessionOnStart = false;
    const delays = [2000, 4000, 8000, 16000, 32000, 60000, 60000];

    for (const [index, delayMs] of delays.entries()) {
      runner.fail(new Error(`failure ${index}`));
      await expectRestartAfter(runner, delayMs, index + 2);
    }
    await server.shutdown();
  });

  it('resets the backoff once a restarted runner reports a session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness({ restartBaseMs: 1000, restartMaxMs: 8000 });
    const { server } = await startHarness(harness);
    const [runner] = harness.runners;
    runner.sessionOnStart = false;

    runner.fail(new Error('first failure'));
    await expectRestartAfter(runner, 1000, 2);
    runner.fail(new Error('second failure'));
    runner.sessionOnStart = true;
    await expectRestartAfter(runner, 2000, 3);
    await until(() => server.getStatus().online_slots === 2);
    await settle();
    runner.fail(new Error('failure after a reported session'));

    await expectRestartAfter(runner, 1000, 4);
    await server.shutdown();
  });

  it('cancels a pending backoff wait promptly on shutdown and never restarts', async () => {
    const harness = createHarness({ restartBaseMs: 3_600_000, restartMaxMs: 3_600_000 });
    const { server } = await startHarness(harness);

    harness.runners[0].fail(new Error('slot registration failed'));
    await settle();
    await server.shutdown();

    expect(harness.runners[0].start).toHaveBeenCalledTimes(1);
    expect(harness.runners[1].start).toHaveBeenCalledTimes(1);
  }, 2000);

  it('does not restart a runner after the backoff delay elapses once shutdown has begun', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness({ restartBaseMs: 1000, restartMaxMs: 4000 });
    const { server } = await startHarness(harness);

    harness.runners[0].fail(new Error('slot registration failed'));
    await settle();
    await server.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(harness.runners[0].start).toHaveBeenCalledTimes(1);
  });

  it('does not restart a runner that fails while shutdown is already draining', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = createHarness({ restartBaseMs: 1000, restartMaxMs: 4000 });
    const { server } = await startHarness(harness);
    const drain = deferred();
    harness.runners[0].shutdown.mockImplementationOnce(async () => {
      await drain.promise;
      harness.runners[0].fail(new Error('slot stopped'));
    });

    const shutdown = server.shutdown();
    await until(() => harness.runners[0].shutdown.mock.calls.length === 1);
    drain.resolve();
    await shutdown;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(harness.runners[0].start).toHaveBeenCalledTimes(1);
  });

  it('logs a redacted reason with the failed slot and never a credential', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false };
    log.child = () => log;
    const harness = createHarness({ log, restartBaseMs: 3_600_000, restartMaxMs: 3_600_000 });
    const { server } = await startHarness(harness);

    harness.runners[1].fail(new Error(
      'registration rejected for ff_secret_slot_token with CLAUDE_CODE_OAUTH_TOKEN=provider-secret-value',
    ));
    await until(() => log.error.mock.calls.length > 0);
    const entry = log.error.mock.calls.find(([message]) => /slot failed/iu.test(message));
    const serialized = JSON.stringify(entry);

    expect(entry[1]).toMatchObject({ slotId: 1 });
    expect(serialized).toContain('registration rejected for [REDACTED] with [REDACTED]');
    expect(serialized).not.toContain('ff_secret_slot_token');
    expect(serialized).not.toContain('provider-secret-value');
    await server.shutdown();
  });
});

describe('portable agent server degraded status', () => {
  it('counts a slot with consecutive poll failures as offline and reports degraded', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].setPollFailures(3);

    expect(server.getStatus()).toMatchObject({ status: 'degraded', capacity: 2, online_slots: 1 });
    harness.runners[0].setPollFailures(0);
    expect(server.getStatus()).toMatchObject({ status: 'healthy', online_slots: 2 });
    await server.shutdown();
  });

  it('reports unhealthy when every slot has consecutive poll failures', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].setPollFailures(1);
    harness.runners[1].setPollFailures(5);

    expect(server.getStatus()).toMatchObject({ status: 'unhealthy', online_slots: 0 });
    await server.shutdown();
  });

  it('reports degraded while every slot is online but one reports a failed cleanup', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[1].setCleanupFailed(true);

    expect(server.getStatus()).toMatchObject({ status: 'degraded', online_slots: 2 });
    harness.runners[1].setCleanupFailed(false);
    expect(server.getStatus()).toMatchObject({ status: 'healthy', online_slots: 2 });
    await server.shutdown();
  });

  it('reports degraded rather than unhealthy when every online slot reports a failed cleanup', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    harness.runners[0].setCleanupFailed(true);
    harness.runners[1].setCleanupFailed(true);

    expect(server.getStatus()).toMatchObject({ status: 'degraded', online_slots: 2 });
    await server.shutdown();
  });
});

describe('portable agent server startup probe', () => {
  it('probes git, gh and the ACP adapter on the child environment before building runners or health', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);
    const [probeOrder] = harness.options.probeTools.mock.invocationCallOrder;

    expect(harness.options.probeTools).toHaveBeenCalledOnce();
    const [{ names, environment }] = harness.options.probeTools.mock.calls[0];
    expect([...names].sort()).toEqual(['claude-agent-acp', 'gh', 'git']);
    expect(environment).toEqual(harness.options.providerEnvironment);
    expect(probeOrder).toBeLessThan(harness.options.createRunner.mock.invocationCallOrder[0]);
    expect(probeOrder).toBeLessThan(harness.options.createHealthServer.mock.invocationCallOrder[0]);
    await server.shutdown();
  });

  it('probes the explicit ACP command instead of a provider default', async () => {
    const harness = createHarness({ acpCommand: '/opt/acp/agent', acpArgs: ['--serve'] });
    const { server } = await startHarness(harness);
    const [{ names }] = harness.options.probeTools.mock.calls[0];

    expect([...names].sort()).toEqual(['/opt/acp/agent', 'gh', 'git']);
    await server.shutdown();
  });

  it('rejects start without creating runners or a health server when a tool is missing', async () => {
    const harness = createHarness();
    harness.options.probeTools.mockImplementation(() => {
      throw new Error('Required tools are missing: gh');
    });
    const server = createAgentServer(harness.options);

    await expect(server.start()).rejects.toThrow('Required tools are missing: gh');
    expect(harness.options.createRunner).not.toHaveBeenCalled();
    expect(harness.options.createHealthServer).not.toHaveBeenCalled();
    expect(harness.health.start).not.toHaveBeenCalled();
    await expect(server.shutdown()).resolves.toBeUndefined();
  });
});

function recordingLog() {
  const children = [];
  const make = (bindings) => {
    const entry = {
      bindings,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      isDebug: () => false,
      child: vi.fn((extra) => {
        const created = make({ ...bindings, ...extra });
        children.push(created);
        return created;
      }),
    };
    return entry;
  };
  return { log: make({}), children };
}

describe('portable agent server decision events', () => {
  it('logs the validated startup configuration once without credentials', async () => {
    const { log } = recordingLog();
    const harness = createHarness({
      log,
      capacity: 3,
      provider: 'codex',
      deployment: 'hosted',
      enrollmentToken: 'enroll_secret_startup_token',
      providerEnvironment: { PATH: '/usr/bin', CODEX_AUTH_JSON: 'provider-startup-secret' },
    });
    const { server } = await startHarness(harness);

    const started = log.info.mock.calls.filter(([message]) => message === 'Agent server started');
    expect(started).toHaveLength(1);
    expect(started[0][1]).toEqual(expect.objectContaining({
      event: 'agent_server_started',
      instanceId: 'instance-stable',
      capacity: 3,
      provider: 'codex',
      deployment: 'hosted',
      version: '0.2.0',
    }));
    const serialized = JSON.stringify(log.info.mock.calls);
    expect(serialized).not.toContain('enroll_secret_startup_token');
    expect(serialized).not.toContain('provider-startup-secret');
    expect(serialized).not.toContain('ff_stored_durable');
    await server.shutdown();
  });

  it('gives every runner a child logger bound to its instance and slot', async () => {
    const { log, children } = recordingLog();
    const harness = createHarness({ log, capacity: 3 });
    const { server } = await startHarness(harness);

    expect(log.child).toHaveBeenCalledTimes(3);
    expect(log.child.mock.calls.map(([bindings]) => bindings)).toEqual([
      { instanceId: 'instance-stable', slotId: 0 },
      { instanceId: 'instance-stable', slotId: 1 },
      { instanceId: 'instance-stable', slotId: 2 },
    ]);
    expect(harness.runnerOptions.map(({ log: runnerLog }) => runnerLog)).toEqual(children);
    await server.shutdown();
  });

  it('passes the execution timeout to every runner', async () => {
    const harness = createHarness({ executionTimeoutMs: 5_400_000 });
    const { server } = await startHarness(harness);

    expect(harness.runnerOptions.map(({ executionTimeoutMs }) => executionTimeoutMs)).toEqual([5_400_000, 5_400_000]);
    await server.shutdown();
  });

  it('does not pass an execution timeout when none is configured', async () => {
    const harness = createHarness();
    const { server } = await startHarness(harness);

    expect(harness.runnerOptions.every((options) => !('executionTimeoutMs' in options) || options.executionTimeoutMs === undefined)).toBe(true);
    await server.shutdown();
  });

  it('logs each restart decision with the attempt, delay and slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { log } = recordingLog();
    const harness = createHarness({ log, restartBaseMs: 1000, restartMaxMs: 60_000 });
    const { server } = await startHarness(harness);
    harness.runners[0].sessionOnStart = false;

    harness.runners[0].fail(new Error('first failure'));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    harness.runners[0].fail(new Error('second failure'));
    await settle();

    const failures = log.error.mock.calls.filter(([message]) => message === 'Agent server slot failed');
    expect(failures.map(([, fields]) => fields)).toEqual([
      expect.objectContaining({
        event: 'slot_restart_scheduled',
        instanceId: 'instance-stable',
        slotId: 0,
        attempt: 1,
        restartInMs: 1000,
      }),
      expect.objectContaining({
        event: 'slot_restart_scheduled',
        instanceId: 'instance-stable',
        slotId: 0,
        attempt: 2,
        restartInMs: 2000,
      }),
    ]);
    await server.shutdown();
  });

  it('logs shutdown completion once after every runner and the health server stopped', async () => {
    const { log } = recordingLog();
    const harness = createHarness({ log });
    const { server } = await startHarness(harness);

    await server.shutdown();
    await server.shutdown();

    const completed = log.info.mock.calls.filter(([message]) => message === 'Agent server shutdown complete');
    expect(completed).toHaveLength(1);
    expect(completed[0][1]).toEqual(expect.objectContaining({
      event: 'agent_server_shutdown_complete',
      instanceId: 'instance-stable',
    }));
    expect(harness.health.stop).toHaveBeenCalledOnce();
  });

  it('does not log shutdown completion when a shutdown error rejects the aggregate', async () => {
    const { log } = recordingLog();
    const harness = createHarness({ log });
    const { server } = await startHarness(harness);
    harness.health.stop.mockRejectedValueOnce(new Error('health close failed'));

    await expect(server.shutdown()).rejects.toBeInstanceOf(AggregateError);

    expect(log.info.mock.calls.filter(([message]) => message === 'Agent server shutdown complete')).toHaveLength(0);
  });
});
