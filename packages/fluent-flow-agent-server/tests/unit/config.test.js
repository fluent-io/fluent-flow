import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProviderEnvironment, parseConfig } from '../../src/config.js';

const cwd = '/srv/fluent-flow';
const homeDir = '/home/agent';
const baseArgv = ['--server', 'https://flow.example.com', '--provider', 'claude-code'];

function parse(argv = baseArgv, env = {}) {
  return parseConfig(argv, { env, cwd, homeDir });
}

function providerConfig(provider, providerSecretFile = '/run/secrets/provider') {
  return {
    deployment: 'self_hosted',
    provider,
    providerSecretFile,
  };
}

describe('agent server configuration', () => {
  it('applies portable local defaults', () => {
    expect(parse()).toEqual({
      serverUrl: 'https://flow.example.com',
      provider: 'claude-code',
      deployment: 'local',
      capacity: 2,
      enrollmentToken: null,
      tokenFile: null,
      providerSecretFile: null,
      workDir: join(cwd, '.fluent-flow', 'work'),
      stateDir: join(homeDir, '.fluent-flow', 'agent-server'),
      healthHost: '127.0.0.1',
      healthPort: 3860,
      acpCommand: null,
      acpArgs: [],
      executionTimeoutMs: 3_600_000,
      logLevel: 'info',
    });
  });

  it.each([
    ['1', 60_000],
    ['60', 3_600_000],
    ['90', 5_400_000],
    ['1440', 86_400_000],
  ])('converts --execution-timeout-minutes %s to %i milliseconds', (minutes, milliseconds) => {
    expect(parse([...baseArgv, '--execution-timeout-minutes', minutes]).executionTimeoutMs).toBe(milliseconds);
  });

  it.each(['0', '1441', '-1', '1.5', '2e1', 'sixty', '', ' 60', '99999999'])(
    'rejects invalid --execution-timeout-minutes %j',
    (minutes) => {
      expect(() => parse([...baseArgv, '--execution-timeout-minutes', minutes])).toThrow();
    },
  );

  it('requires a value for --execution-timeout-minutes', () => {
    expect(() => parse([...baseArgv, '--execution-timeout-minutes'])).toThrow();
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])('reads LOG_LEVEL=%s from the environment', (level) => {
    expect(parse(baseArgv, { LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it.each(['', 'verbose', 'INFO', 'warning', ' info', 'silent', '10'])('rejects the invalid LOG_LEVEL %j', (level) => {
    expect(() => parse(baseArgv, { LOG_LEVEL: level })).toThrow(/LOG_LEVEL/u);
  });

  it('does not add a log level flag', () => {
    expect(() => parse([...baseArgv, '--log-level', 'debug'])).toThrow();
  });

  it.each([
    ['https://flow.example.com'],
    ['http://127.0.0.1:3847'],
    ['http://localhost:3847'],
    ['http://[::1]:3847'],
  ])('accepts the safe server URL %s', (serverUrl) => {
    expect(parse(['--server', serverUrl, '--provider', 'codex']).serverUrl).toBe(serverUrl);
  });

  it.each([
    ['missing server URL', ['--provider', 'claude-code']],
    ['missing provider', ['--server', 'https://flow.example.com']],
    ['embedded username', ['--server', 'https://user@flow.example.com', '--provider', 'claude-code']],
    ['embedded password', ['--server', 'https://user:secret@flow.example.com', '--provider', 'claude-code']],
    ['unsupported protocol', ['--server', 'ftp://flow.example.com', '--provider', 'claude-code']],
    ['remote plaintext HTTP', ['--server', 'http://flow.example.com', '--provider', 'claude-code']],
    ['remote IPv4 plaintext HTTP', ['--server', 'http://192.168.1.10:3847', '--provider', 'claude-code']],
    ['malformed URL', ['--server', 'not a URL', '--provider', 'claude-code']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parse(argv)).toThrow();
  });

  it.each([1, 16])('accepts capacity boundary %i', (capacity) => {
    expect(parse([...baseArgv, '--capacity', String(capacity)]).capacity).toBe(capacity);
  });

  it.each(['0', '17', '-1', '1.5', '2e0', 'two', '', ' 2'])('rejects invalid capacity %j', (capacity) => {
    expect(() => parse([...baseArgv, '--capacity', capacity])).toThrow();
  });

  it('parses deployment, enrollment, provider secret, paths, and health bind', () => {
    expect(parse([
      ...baseArgv,
      '--deployment', 'self_hosted',
      '--enrollment-token', 'enroll_once',
      '--provider-secret-file', '/run/secrets/claude',
      '--work-dir', '/var/lib/fluent-flow/work',
      '--state-dir', '/var/lib/fluent-flow/state',
      '--health-host', '0.0.0.0',
      '--health-port', '43860',
    ])).toMatchObject({
      deployment: 'self_hosted',
      enrollmentToken: 'enroll_once',
      providerSecretFile: '/run/secrets/claude',
      workDir: '/var/lib/fluent-flow/work',
      stateDir: '/var/lib/fluent-flow/state',
      healthHost: '0.0.0.0',
      healthPort: 43860,
    });
  });

  it.each(['self_hosted', 'hosted'])('requires a provider secret file for %s deployment', (deployment) => {
    expect(() => parse([...baseArgv, '--deployment', deployment])).toThrow();
    expect(parse([
      ...baseArgv,
      '--deployment', deployment,
      '--provider-secret-file', '/run/secrets/provider',
    ]).deployment).toBe(deployment);
  });

  it('allows local deployment without a provider secret file', () => {
    expect(parse([...baseArgv, '--deployment', 'local']).providerSecretFile).toBeNull();
  });

  it.each(['claude-code', 'codex'])('accepts provider %s', (provider) => {
    expect(parse(['--server', 'https://flow.example.com', '--provider', provider]).provider).toBe(provider);
  });

  it.each(['claude', 'openai', 'CLAUDE-CODE', ''])('rejects invalid provider %j', (provider) => {
    expect(() => parse(['--server', 'https://flow.example.com', '--provider', provider])).toThrow();
  });

  it.each(['local', 'self_hosted', 'hosted'])('accepts deployment %s', (deployment) => {
    const argv = [...baseArgv, '--deployment', deployment];
    if (deployment !== 'local') argv.push('--provider-secret-file', '/run/secrets/provider');
    expect(parse(argv).deployment).toBe(deployment);
  });

  it.each(['self-hosted', 'container', 'cloud', ''])('rejects invalid deployment %j', (deployment) => {
    expect(() => parse([...baseArgv, '--deployment', deployment])).toThrow();
  });

  it('preserves a discrete ACP executable and repeatable argument array', () => {
    const config = parse([
      ...baseArgv,
      '--acp-command', '/opt/bin/custom-agent',
      '--acp-arg', '--stdio',
      '--acp-arg', 'profile with spaces',
    ]);

    expect(config.acpCommand).toBe('/opt/bin/custom-agent');
    expect(config.acpArgs).toEqual(['--stdio', 'profile with spaces']);
  });

  it('rejects shell command strings instead of treating them as executable plus arguments', () => {
    expect(() => parse([...baseArgv, '--command', 'agent --stdio'])).toThrow();
  });

  it('accepts a durable token file only from FLUENT_FLOW_TOKEN_FILE', () => {
    expect(parse(baseArgv, { FLUENT_FLOW_TOKEN_FILE: '/run/secrets/fluent-flow-token' }).tokenFile)
      .toBe('/run/secrets/fluent-flow-token');
    expect(() => parse([...baseArgv, '--token-file', '/tmp/token'])).toThrow();
  });

  it('rejects plaintext control-plane token inputs', () => {
    expect(() => parse([...baseArgv, '--token', 'ff_secret'])).toThrow();
    expect(() => parse(baseArgv, { FLUENT_FLOW_TOKEN: 'ff_secret' })).toThrow();
  });

  it.each([
    ['unknown flag', [...baseArgv, '--mystery']],
    ['missing server value', ['--server']],
    ['missing provider value', ['--server', 'https://flow.example.com', '--provider']],
    ['missing capacity value', [...baseArgv, '--capacity']],
    ['missing ACP argument value', [...baseArgv, '--acp-arg']],
    ['flag where value is required', [...baseArgv, '--work-dir', '--capacity', '2']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parse(argv)).toThrow();
  });

  it.each([
    ['ACP executable', [...baseArgv, '--acp-command', 'agent\0evil'], {}],
    ['ACP argument', [...baseArgv, '--acp-arg', 'arg\0evil'], {}],
    ['work path', [...baseArgv, '--work-dir', '/work\0elsewhere'], {}],
    ['state path', [...baseArgv, '--state-dir', '/state\0elsewhere'], {}],
    ['provider secret path', [...baseArgv, '--provider-secret-file', '/secret\0elsewhere'], {}],
    ['token file path', baseArgv, { FLUENT_FLOW_TOKEN_FILE: '/token\0elsewhere' }],
  ])('rejects a NUL-containing %s', (_label, argv, env) => {
    expect(() => parse(argv, env)).toThrow();
  });

  it.each(['0', '65536', '-1', '1.5', 'port'])('rejects invalid health port %j', (port) => {
    expect(() => parse([...baseArgv, '--health-port', port])).toThrow();
  });
});

describe('provider secret loading', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses local CLI login without reading a provider secret or inheriting host credentials', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-claude-token');
    vi.stubEnv('CODEX_AUTH_JSON', '{"host":"codex"}');
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'host-openai-key');
    const readFile = vi.fn();

    await expect(loadProviderEnvironment({
      deployment: 'local',
      provider: 'claude-code',
      providerSecretFile: null,
    }, { readFile })).resolves.toEqual({});

    expect(readFile).not.toHaveBeenCalled();
  });

  it('loads only the Claude OAuth token and removes one trailing line ending', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'host-openai-key');
    const readFile = vi.fn().mockResolvedValue(Buffer.from(' leading token \ninterior token \r\n'));

    await expect(loadProviderEnvironment(
      providerConfig('claude-code'),
      { readFile },
    )).resolves.toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: ' leading token \ninterior token ',
    });

    expect(readFile.mock.calls[0][0]).toBe('/run/secrets/provider');
  });

  it('validates and loads only the Codex auth JSON document', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'host-openai-key');
    const document = '{"tokens": {"access_token": "codex-token"}, "account_id": "acct"}';
    const readFile = vi.fn().mockResolvedValue(Buffer.from(document));

    await expect(loadProviderEnvironment(
      providerConfig('codex'),
      { readFile },
    )).resolves.toEqual({
      CODEX_AUTH_JSON: document,
    });
  });

  it.each([
    ['claude-code'],
    ['codex'],
  ])('rejects an empty %s provider secret', async (provider) => {
    const readFile = vi.fn().mockResolvedValue(Buffer.from('\r\n'));

    await expect(loadProviderEnvironment(
      providerConfig(provider),
      { readFile },
    )).rejects.toThrow();
  });

  it.each([
    ['claude-code'],
    ['codex'],
  ])('rejects an oversized %s provider secret', async (provider) => {
    const readFile = vi.fn().mockResolvedValue(Buffer.alloc((64 * 1024) + 1, 0x61));

    await expect(loadProviderEnvironment(
      providerConfig(provider),
      { readFile },
    )).rejects.toThrow();
  });

  it.each([
    ['malformed JSON', '{"tokens":'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"token"'],
    ['a number', '42'],
    ['a boolean', 'true'],
  ])('rejects Codex provider secret containing %s', async (_label, contents) => {
    const readFile = vi.fn().mockResolvedValue(Buffer.from(contents));

    await expect(loadProviderEnvironment(
      providerConfig('codex'),
      { readFile },
    )).rejects.toThrow();
  });

  it.each([
    ['claude-code'],
    ['codex'],
  ])('propagates %s provider secret read failures', async (provider) => {
    const readFile = vi.fn().mockRejectedValue(new Error('provider secret read failed'));

    await expect(loadProviderEnvironment(
      providerConfig(provider),
      { readFile },
    )).rejects.toThrow();
  });
});
