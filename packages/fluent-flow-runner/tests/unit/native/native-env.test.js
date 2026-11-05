import { describe, it, expect } from 'vitest';
import { buildNativeEnv, INHERITED_ENV_KEYS } from '../../../src/native/native-env.js';
import { claudeArgs, codexArgs, codexLaunchControls, codexQuestionServerOverrides, NATIVE_OBSERVED, NATIVE_PINS, POLICY_OUTCOMES, readNativeVersion } from '../../../src/native/pins.js';
import { QUESTION_HOLD_MS } from '../../../src/native/question-mcp.js';

const ambient = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  ANTHROPIC_AUTH_TOKEN: 't',
  ANTHROPIC_BASE_URL: 'http://gw',
  CLAUDE_CODE_OAUTH_TOKEN: 'o',
  CLAUDE_CODE_USE_BEDROCK: '1',
  OPENAI_API_KEY: 'sk-x',
  OPENAI_BASE_URL: 'http://gw',
  CODEX_HOME: '/elsewhere',
  HTTPS_PROXY: 'http://proxy',
  AWS_ACCESS_KEY_ID: 'AKIA',
  NODE_OPTIONS: '--require evil',
};

describe('buildNativeEnv', () => {
  it('drops ambient credentials, gateways, proxies and NODE_OPTIONS', () => {
    for (const backend of ['claude-code', 'codex']) {
      const env = buildNativeEnv({ backend, contextDir: '/tmp/ctx', parentEnv: ambient });
      for (const key of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'HTTPS_PROXY',
        'AWS_ACCESS_KEY_ID',
        'NODE_OPTIONS',
      ]) {
        expect(env, `${backend} ${key}`).not.toHaveProperty(key);
      }
      if (backend === 'claude-code') expect(env).not.toHaveProperty('CODEX_HOME');
      else expect(env.CODEX_HOME).toBe('/tmp/ctx');
    }
  });

  it('adds exactly the documented keys per backend', () => {
    const full = Object.fromEntries(INHERITED_ENV_KEYS.map((k) => [k, `v-${k}`]));
    const claude = buildNativeEnv({ backend: 'claude-code', contextDir: '/tmp/c', parentEnv: { ...full, EXTRA: '1' } });
    expect(Object.keys(claude).sort()).toEqual(
      [
        ...INHERITED_ENV_KEYS,
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
        'DISABLE_AUTOUPDATER',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
      ].sort(),
    );
    expect(claude).toMatchObject({
      CLAUDE_CONFIG_DIR: '/tmp/c',
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '0',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    });
    const codex = buildNativeEnv({ backend: 'codex', contextDir: '/tmp/x', parentEnv: full, reportingToken: 'rt' });
    expect(Object.keys(codex).sort()).toEqual([...INHERITED_ENV_KEYS, 'CODEX_HOME', 'FF_REPORTING_TOKEN'].sort());
    expect(codex).toMatchObject({ CODEX_HOME: '/tmp/x', FF_REPORTING_TOKEN: 'rt' });
    const codexNoToken = buildNativeEnv({ backend: 'codex', contextDir: '/tmp/x', parentEnv: full });
    expect(Object.keys(codexNoToken).sort()).toEqual([...INHERITED_ENV_KEYS, 'CODEX_HOME'].sort());
    const codexQuestions = buildNativeEnv({ backend: 'codex', contextDir: '/tmp/x', parentEnv: full, reportingToken: 'rt', questionsToken: 'qt' });
    expect(Object.keys(codexQuestions).sort()).toEqual([...INHERITED_ENV_KEYS, 'CODEX_HOME', 'FF_REPORTING_TOKEN', 'FF_QUESTIONS_TOKEN'].sort());
    expect(codexQuestions.FF_QUESTIONS_TOKEN).toBe('qt');
    const claudeQuestions = buildNativeEnv({ backend: 'claude-code', contextDir: '/tmp/c', parentEnv: full, questionsToken: 'qt' });
    expect(claudeQuestions).not.toHaveProperty('FF_QUESTIONS_TOKEN');
  });

  it('inherits HOME from parentEnv unchanged', () => {
    const env = buildNativeEnv({ backend: 'claude-code', contextDir: '/tmp/c', parentEnv: ambient });
    expect(env.HOME).toBe('/home/someone');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never mutates parentEnv or process.env', () => {
    const parent = { ...ambient };
    const snapshot = { ...parent };
    const procSnapshot = { ...process.env };
    buildNativeEnv({ backend: 'codex', contextDir: '/tmp/c', parentEnv: parent, reportingToken: 'r' });
    buildNativeEnv({ backend: 'claude-code', contextDir: '/tmp/c', parentEnv: parent });
    expect(parent).toEqual(snapshot);
    expect(process.env).toEqual(procSnapshot);
  });

  it('rejects a relative or missing contextDir', () => {
    expect(() => buildNativeEnv({ backend: 'codex', contextDir: 'rel/dir', parentEnv: ambient })).toThrow(/contextDir/);
    expect(() => buildNativeEnv({ backend: 'codex', parentEnv: ambient })).toThrow(/contextDir/);
    expect(() => buildNativeEnv({ backend: 'gemini', contextDir: '/tmp/c', parentEnv: ambient })).toThrow(/backend/);
  });
});

describe('pins', () => {
  it('keeps the NATIVE_PINS enums exactly as Task 1 recorded them', () => {
    expect(JSON.parse(JSON.stringify(NATIVE_PINS))).toEqual({
      'claude-code': { versions: ['2.1.317'], permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] },
      codex: { versions: ['0.162.1'], approvalPolicies: ['untrusted', 'on-request', 'never'], sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'] },
    });
  });

  it('production policy outcomes use the extended enum and cover every pinned mode and policy', () => {
    expect([...POLICY_OUTCOMES]).toEqual(['runs', 'asks', 'refused', 'unproven']);
    const claude = NATIVE_OBSERVED['claude-code'].policyOutcomes;
    const codex = NATIVE_OBSERVED.codex.policyOutcomes;
    expect(Object.keys(claude).sort()).toEqual([...NATIVE_PINS['claude-code'].permissionModes].sort());
    expect(Object.keys(codex).sort()).toEqual([...NATIVE_PINS.codex.approvalPolicies].sort());
    for (const outcome of [...Object.values(claude), ...Object.values(codex)]) {
      expect(Object.keys(outcome).sort()).toEqual(['questions', 'reporting']);
      for (const v of Object.values(outcome)) expect(POLICY_OUTCOMES).toContain(v);
    }
    expect(claude.auto.reporting).toBe('unproven');
  });

  it('codexQuestionServerOverrides returns exactly its four keys', () => {
    expect(codexQuestionServerOverrides({ url: 'http://127.0.0.1:5/mcp/s' })).toEqual({
      'mcp_servers.ff_questions.url': 'http://127.0.0.1:5/mcp/s',
      'mcp_servers.ff_questions.bearer_token_env_var': 'FF_QUESTIONS_TOKEN',
      'mcp_servers.ff_questions.required': true,
      'mcp_servers.ff_questions.tool_timeout_sec': 604800,
    });
    expect(QUESTION_HOLD_MS).toBeLessThan(604800 * 1000);
  });

  it('pins the exact native versions', () => {
    expect(NATIVE_PINS['claude-code'].versions).toEqual(['2.1.317']);
    expect(NATIVE_PINS.codex.versions).toEqual(['0.162.1']);
  });

  it('builds the Claude argv with exact session selection', () => {
    const base = { sessionId: 'abc', model: 'm', permissionMode: 'manual', mcpConfigPath: '/c/mcp.json', settingsPath: '/c/s.json', workspaceDir: '/w/repo' };
    const fresh = claudeArgs(base);
    expect(fresh.slice(-2)).toEqual(['--session-id', 'abc']);
    expect(fresh.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(fresh[fresh.indexOf('--add-dir') + 1]).toBe('/w/repo');
    expect(fresh[fresh.indexOf('--setting-sources') + 1]).toBe('user');
    expect(fresh).toContain('--strict-mcp-config');
    expect(() => claudeArgs({ ...base, workspaceDir: 'rel/repo' })).toThrow(/workspaceDir/);
    expect(() => claudeArgs({ ...base, workspaceDir: undefined })).toThrow(/workspaceDir/);
    expect(fresh).toContain('-p');
    expect(fresh[fresh.indexOf('--model') + 1]).toBe('m');
    expect(fresh[fresh.indexOf('--mcp-config') + 1]).toBe('/c/mcp.json');
    expect(claudeArgs({ ...base, resume: true }).slice(-2)).toEqual(['--resume', 'abc']);
    expect(() => claudeArgs({ ...base, permissionMode: 'yolo' })).toThrow(/permissionMode/);
  });

  it('pins the codex launch controls', () => {
    expect(codexLaunchControls()).toEqual({ 'features.plugins': false, 'features.apps': false });
    expect(codexArgs({ overrides: codexLaunchControls() }).slice(4)).toEqual(['-c', 'features.plugins=false', '-c', 'features.apps=false']);
  });

  it('emits codex overrides as TOML -c values', () => {
    expect(codexArgs({ overrides: { model: 'ff-probe-model', 'features.x': true, n: 3 } })).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
      '-c',
      'model="ff-probe-model"',
      '-c',
      'features.x=true',
      '-c',
      'n=3',
    ]);
  });

  it('parses the native version string', async () => {
    const fake = { execFile: async () => ({ stdout: '2.1.317 (Claude Code)\n' }) };
    expect(await readNativeVersion({ backend: 'claude-code', executable: 'claude', env: {}, ...fake })).toBe('2.1.317');
    const codex = { execFile: async () => ({ stdout: 'codex-cli 0.162.1\n' }) };
    expect(await readNativeVersion({ backend: 'codex', executable: 'codex', env: {}, ...codex })).toBe('0.162.1');
    const junk = { execFile: async () => ({ stdout: 'hello' }) };
    await expect(readNativeVersion({ backend: 'codex', executable: 'codex', env: {}, ...junk })).rejects.toMatchObject({ code: 'version_unreadable' });
  });
});
