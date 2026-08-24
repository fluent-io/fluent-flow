import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({
  prepareWorktree: (...args) => mockPrepareWorktree(...args),
}));

import { createRunner } from '../../src/runner.js';
import { createClient } from '../../src/client.js';

function makeClient(overrides = {}) {
  return {
    register: vi.fn().mockResolvedValue({ ok: true, session_id: 1, status: 'online' }),
    poll: vi.fn().mockResolvedValue(null),
    reportClaim: vi.fn().mockResolvedValue({ ok: true, claim_id: 1, status: 'completed' }),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
}

/** Fake child process that exits with the given code after closeDelay ms. */
function fakeProcess(exitCode = 0, closeDelay = 10) {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 1234,
  };
  setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(exitCode)), closeDelay);
  return proc;
}

/** Fake process that ignores SIGTERM and only dies on SIGKILL. */
function stubbornProcess() {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn((sig) => {
      if (sig === 'SIGKILL') setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(137)), 5);
    }),
    pid: 9999,
  };
  return proc;
}

/** Fake process that emits oversized stdout chunks (optionally with a marker in the dropped head) then exits. */
function loudProcess(marker = null) {
  const handlers = {};
  const stdoutListeners = {};
  const proc = {
    on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
    stdout: { on: vi.fn((event, cb) => { stdoutListeners[event] = cb; }) },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 4321,
  };
  setTimeout(() => {
    const head = marker ? Buffer.concat([Buffer.alloc(3 * 1024 * 1024 - 64, 0x61), Buffer.from(marker)]) : Buffer.alloc(3 * 1024 * 1024, 0x61);
    stdoutListeners.data?.(head); // 3MB 'a' (+ marker at the very end)
    stdoutListeners.data?.(Buffer.alloc(3 * 1024 * 1024, 0x62)); // 3MB 'b' → over cap, head dropped
    (handlers.close ?? []).forEach((cb) => cb(0));
  }, 10);
  return proc;
}

const WORK = {
  event: 'review_failed',
  message: 'Fix the bug',
  repo: 'org/repo',
  prNumber: 7,
  attempt: 1,
  claim_id: 42,
  agentType: 'claude-code',
};

function makeRunner(client, { resolveCommand, ...opts } = {}) {
  return createRunner({
    client,
    log: makeLogger(),
    resolveCommand:
      resolveCommand ?? vi.fn().mockImplementation(({ prompt }) => ({ bin: 'claude', args: ['-p', prompt] })),
    ...opts,
  });
}

/** Drive one work item through start() and shut down. */
async function runOneWork(client, opts = {}, work = WORK, spawnImpl) {
  let pollCount = 0;
  client.poll = vi.fn().mockImplementation(async () => {
    pollCount++;
    return pollCount === 1 ? work : null;
  });
  if (spawnImpl) mockSpawn.mockImplementationOnce(spawnImpl);
  const runner = makeRunner(client, opts);
  const startPromise = runner.start();
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 150));
  runner.shutdown();
  await startPromise;
  return runner;
}

describe('client.heartbeat', () => {
  it('POSTs session_id and claim_id to /api/runner/heartbeat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const client = createClient({ serverUrl: 'http://srv', token: 'ff_x', fetch: fetchMock });
    await client.heartbeat(3, 42);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://srv/api/runner/heartbeat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session_id: 3, claim_id: 42 }),
      }),
    );
  });

  it('throws a labeled error on non-ok responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 410, text: async () => 'expired' });
    const client = createClient({ serverUrl: 'http://srv', token: 'ff_x', fetch: fetchMock });
    await expect(client.heartbeat(3, 42)).rejects.toThrow(/Heartbeat failed: 410/);
  });
});

describe('claim heartbeat during execution', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('heartbeats while a claim executes and stops when it finishes', async () => {
    const client = makeClient();
    await runOneWork(client, { heartbeatIntervalMs: 5, settleMs: 120 }, WORK, () => fakeProcess(0, 60));
    expect(client.heartbeat).toHaveBeenCalledWith(1, 42);
    const callsDuringWork = client.heartbeat.mock.calls.length;
    expect(callsDuringWork).toBeGreaterThanOrEqual(2);
    // After handleWork completes the timer is cleared — no further calls.
    await new Promise((r) => setTimeout(r, 30));
    expect(client.heartbeat.mock.calls.length).toBe(callsDuringWork);
  });

  it('stops heartbeating on 410 but still completes and reports the claim', async () => {
    const client = makeClient({
      heartbeat: vi.fn().mockRejectedValue(new Error('Heartbeat failed: 410 — Session expired or offline — re-register')),
    });
    await runOneWork(client, { heartbeatIntervalMs: 5, settleMs: 120 }, WORK, () => fakeProcess(0, 60));
    expect(client.heartbeat.mock.calls.length).toBe(1);
    expect(client.reportClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', claim_id: 42 }),
    );
  });

  it('does not heartbeat when the work has no claim id', async () => {
    const client = makeClient();
    const work = { ...WORK, claim_id: undefined, claimId: undefined, id: undefined };
    await runOneWork(client, { heartbeatIntervalMs: 5 }, work, () => fakeProcess(0));
    expect(client.heartbeat).not.toHaveBeenCalled();
  });
});

describe('claim report retry', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('retries a 500 and succeeds on the second attempt', async () => {
    const client = makeClient({
      reportClaim: vi
        .fn()
        .mockRejectedValueOnce(new Error('Claim report failed: 500 — boom'))
        .mockResolvedValue({ ok: true }),
    });
    const origDelay = 1000;
    const t0 = Date.now();
    // settle must exceed the 1s retry delay so shutdown doesn't race the in-flight report
    await runOneWork(client, { settleMs: 1600 }, WORK, () => fakeProcess(0));
    expect(client.reportClaim).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  }, 10000);

  it('does not retry a permanent 404', async () => {
    const client = makeClient({
      reportClaim: vi.fn().mockRejectedValue(new Error('Claim report failed: 404 — not found')),
    });
    await runOneWork(client, {}, WORK, () => fakeProcess(0));
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
  });

  it('carries claim_id on every report', async () => {
    const client = makeClient();
    await runOneWork(client, {}, WORK, () => fakeProcess(0));
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ claim_id: 42 }));
  });
});

describe('failure classification', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('reports worktree prep failure as transient', async () => {
    mockPrepareWorktree.mockRejectedValueOnce(new Error('clone failed'));
    const client = makeClient();
    await runOneWork(client, {}, { ...WORK, branch: 'fix-branch' }); // no spawnImpl — spawn is never reached
    expect(mockPrepareWorktree).toHaveBeenCalled();
    expect(client.reportClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failure_kind: 'transient', claim_id: 42 }),
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('reports command-resolution failure as transient', async () => {
    const client = makeClient();
    await runOneWork(
      client,
      { resolveCommand: vi.fn().mockImplementation(() => { throw new Error('no template'); }) },
      { ...WORK, agentType: 'unknown-type' },
    );
    expect(client.reportClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failure_kind: 'transient' }),
    );
  });

  it('keeps non-zero agent exit terminal (no failure_kind)', async () => {
    const client = makeClient();
    await runOneWork(client, {}, WORK, () => fakeProcess(3));
    const payload = client.reportClaim.mock.calls[0][0];
    expect(payload.status).toBe('failed');
    expect(payload.failure_kind).toBeUndefined();
  });
});

describe('execution timeout', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('SIGTERMs then SIGKILLs a hung agent and reports transient with exit code 124', async () => {
    const client = makeClient();
    await runOneWork(client, { agentTimeoutMs: 20, killEscalationMs: 30, settleMs: 300 }, WORK, () => stubbornProcess());
    const killCalls = mockSpawn.mock.results[0].value.kill.mock.calls.map((c) => c[0]);
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(client.reportClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failure_kind: 'transient', claim_id: 42 }),
    );
  }, 10000);
});

describe('stdout cap', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('drops the head when stdout exceeds 5MB — a marker in the dropped chunk is absent from the verdict', async () => {
    const client = makeClient();
    // loudProcess emits 3MB of 'a' then 3MB of 'b'. With the marker embedded
    // at the end of the FIRST chunk, the cap must drop it — so the review
    // verdict stays undefined. Without the cap the marker survives.
    const work = { ...WORK, claim_type: 'review' };
    await runOneWork(client, { settleMs: 300 }, work, () => loudProcess('<!-- reviewer-result: { "status": "PASS" } -->'));
    const payload = client.reportClaim.mock.calls[0][0];
    expect(payload.status).toBe('completed');
    expect(payload.claim_id).toBe(42);
    expect(payload.verdict).toBeUndefined();
  }, 10000);
});

describe('shutdown', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // reset, not clear: clearAllMocks leaves queued mockImplementationOnce impls
  });

  it('kills the active agent and reports the active claim as transient', async () => {
    let pollCount = 0;
    const client = makeClient({
      poll: vi.fn().mockImplementation(async () => {
        pollCount++;
        return pollCount === 1 ? WORK : null;
      }),
    });
    // Process only dies when SIGTERM'd (kill → close), never on its own.
    const handlers = {};
    const proc = {
      on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(() => {
        setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(143)), 10);
      }),
      pid: 3141,
    };
    mockSpawn.mockImplementationOnce(() => proc);
    const runner = makeRunner(client, { killEscalationMs: 200 });
    const startPromise = runner.start();
    await new Promise((r) => setTimeout(r, 80)); // work now executing
    await runner.shutdown();
    const p2 = runner.shutdown(); // memoized — same promise, no second report
    expect(p2).toBeInstanceOf(Promise);
    await startPromise;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    // Two reports are expected and server-safe: (1) shutdown's transient
    // failure report, (2) handleWork's own terminal report after the killed
    // process closes — the server answers the second with already_resolved.
    expect(client.reportClaim).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failure_kind: 'transient', claim_id: 42 }),
    );
    expect(client.reportClaim).toHaveBeenCalledTimes(2);
  }, 10000);
});
