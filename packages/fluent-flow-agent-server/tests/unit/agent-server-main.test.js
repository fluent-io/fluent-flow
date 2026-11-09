import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverMocks = vi.hoisted(() => ({ createAgentServer: vi.fn() }));
const loggerMocks = vi.hoisted(() => ({ createLogger: vi.fn(), log: null }));

vi.mock('../../src/server.js', () => ({ createAgentServer: (...args) => serverMocks.createAgentServer(...args) }));
vi.mock('../../src/logger.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createLogger: (...args) => loggerMocks.createLogger(...args),
}));

const { main } = await import('../../bin/fluent-flow-agent-server.js');
const { parseConfig } = await import('../../src/config.js');

const ENROLLMENT_SECRET = 'enroll_main_secret_value';

function fakeProcess(argv, env = {}) {
  return {
    argv: ['node', 'fluent-flow-agent-server', ...argv],
    env,
    cwd: () => '/srv/fluent-flow',
    exitCode: undefined,
    on: vi.fn(),
  };
}

function fakeServer(overrides = {}) {
  return {
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

const ARGV = [
  '--server', 'https://flow.example.com',
  '--provider', 'codex',
  '--deployment', 'local',
  '--capacity', '3',
  '--work-dir', '/srv/work',
  '--state-dir', '/srv/state',
  '--health-host', '0.0.0.0',
  '--health-port', '4010',
  '--execution-timeout-minutes', '7',
  '--acp-command', '/opt/acp-agent',
  '--acp-arg', '--stdio',
  '--enrollment-token', ENROLLMENT_SECRET,
];

beforeEach(() => {
  vi.clearAllMocks();
  loggerMocks.log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isDebug: vi.fn(() => false),
    child: vi.fn(),
  };
  loggerMocks.createLogger.mockImplementation(() => loggerMocks.log);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent server main', () => {
  it('passes every parsed config field, including the execution timeout, to the server', async () => {
    const processLike = fakeProcess(ARGV);
    const server = fakeServer();
    serverMocks.createAgentServer.mockReturnValue(server);

    await main(processLike);

    const expected = parseConfig(processLike.argv.slice(2), { env: processLike.env, cwd: '/srv/fluent-flow' });
    expect(expected.executionTimeoutMs).toBe(7 * 60_000);
    expect(serverMocks.createAgentServer).toHaveBeenCalledOnce();
    const options = serverMocks.createAgentServer.mock.calls[0][0];
    expect(options).toEqual(expect.objectContaining(expected));
    expect(options.executionTimeoutMs).toBe(420_000);
    expect(options).toEqual(expect.objectContaining({
      packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+/u),
      providerEnvironment: expect.any(Object),
      log: loggerMocks.log,
    }));
    expect(server.start).toHaveBeenCalledOnce();
    expect(processLike.exitCode).toBeUndefined();
  });

  it('builds the server logger from LOG_LEVEL', async () => {
    const processLike = fakeProcess(
      ['--server', 'https://flow.example.com', '--provider', 'claude-code'],
      { LOG_LEVEL: 'debug' },
    );
    serverMocks.createAgentServer.mockReturnValue(fakeServer());

    await main(processLike);

    expect(loggerMocks.createLogger).toHaveBeenLastCalledWith(false, 'debug');
    expect(serverMocks.createAgentServer.mock.calls[0][0].logLevel).toBe('debug');
  });

  it('fails configuration without creating a server when LOG_LEVEL is invalid', async () => {
    const processLike = fakeProcess(
      ['--server', 'https://flow.example.com', '--provider', 'claude-code'],
      { LOG_LEVEL: 'loud' },
    );

    await main(processLike);

    expect(serverMocks.createAgentServer).not.toHaveBeenCalled();
    expect(processLike.exitCode).toBe(1);
    expect(loggerMocks.log.error).toHaveBeenCalledWith('Agent server configuration failed', expect.any(Object));
  });

  it('sets a failing exit code and runs shutdown when start rejects', async () => {
    const processLike = fakeProcess(['--server', 'https://flow.example.com', '--provider', 'claude-code', '--enrollment-token', ENROLLMENT_SECRET]);
    const server = fakeServer({
      start: vi.fn(async () => { throw new Error(`enrollment refused ${ENROLLMENT_SECRET}`); }),
    });
    serverMocks.createAgentServer.mockReturnValue(server);

    await main(processLike);

    expect(processLike.exitCode).toBe(1);
    expect(server.shutdown).toHaveBeenCalledOnce();
    expect(loggerMocks.log.error).toHaveBeenCalledWith('Agent server startup failed', {
      error: 'enrollment refused [REDACTED]',
    });
    expect(JSON.stringify(loggerMocks.log.error.mock.calls)).not.toContain(ENROLLMENT_SECRET);
  });

  it('still fails the process and logs a redacted reason when shutdown also rejects', async () => {
    const processLike = fakeProcess(['--server', 'https://flow.example.com', '--provider', 'claude-code']);
    const server = fakeServer({
      start: vi.fn(async () => { throw new Error('start failed'); }),
      shutdown: vi.fn(async () => { throw new Error(`shutdown failed ${ENROLLMENT_SECRET}`); }),
    });
    serverMocks.createAgentServer.mockReturnValue(server);

    await main(processLike);

    expect(processLike.exitCode).toBe(1);
    expect(loggerMocks.log.error).toHaveBeenCalledWith('Agent server shutdown failed', {
      error: 'shutdown failed [REDACTED]',
    });
  });
});
