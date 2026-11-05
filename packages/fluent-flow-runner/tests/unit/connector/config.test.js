import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConnectorConfig as loadConfig, loadLocalProfiles, ConnectorConfigError } from '../../../src/connector/config.js';

const loadConnectorConfig = ({ file }) => loadConfig({ file, enableIntegrations: ['paseo'] });

let dir;
let repoDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-conn-cfg-'));
  repoDir = join(dir, 'repos', 'my-repo');
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(overrides = {}, repositories = { 'my-repo': repoDir }) {
  const file = join(dir, 'connector.json');
  writeFileSync(
    file,
    JSON.stringify({
      serverUrl: 'http://127.0.0.1:4000',
      tokenFile: join(dir, 'token'),
      instanceId: 'pc-1',
      repositories,
      profiles: ['p-coder'],
      ...overrides,
    }),
  );
  return file;
}

describe('connector config', () => {
  it('loads a valid config and resolves the host token from its file', () => {
    writeFileSync(join(dir, 'token'), 'ffh_secret-token-value\n');
    const cfg = loadConnectorConfig({ file: writeConfig() });
    expect(cfg.serverUrl).toBe('http://127.0.0.1:4000');
    expect(cfg.instanceId).toBe('pc-1');
    expect(cfg.token).toBe('ffh_secret-token-value');
    expect(cfg.repositories['my-repo']).toBe(repoDir);
  });

  it('accepts an optional local absolute redaction seed file and rejects relative paths', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const redactionSecretsFile = join(dir, 'private-seed.json');
    expect(loadConnectorConfig({ file: writeConfig({ redactionSecretsFile }) }).redactionSecretsFile).toBe(redactionSecretsFile);
    expect(() => loadConnectorConfig({ file: writeConfig({ redactionSecretsFile: 'relative.json' }) })).toThrow(/absolute/i);
  });

  it('rejects a token file that is missing', () => {
    expect(() => loadConnectorConfig({ file: writeConfig() })).toThrow(/token/i);
  });

  it('rejects non-absolute repository paths: only the connector resolves absolute paths', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({}, { 'my-repo': 'relative/path' });
    expect(() => loadConnectorConfig({ file })).toThrow(/absolute/i);
  });

  it('rejects invalid repository keys', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({}, { '../escape': repoDir });
    expect(() => loadConnectorConfig({ file })).toThrow(/key/i);
  });

  it('expands ~ in paths so the config can live in dotfiles', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({ tokenFile: '~/ff-test-token-file-does-not-exist' });
    expect(() => loadConnectorConfig({ file })).toThrow(/token/i);
  });

  it('rejects an empty profiles allowlist: nothing is offered by default', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({ profiles: [] });
    expect(() => loadConnectorConfig({ file })).toThrow(expect.objectContaining({ code: 'no_complete_profile' }));
  });

  it('resolves the canonical real path of each repository', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const link = join(dir, 'link-to-repo');
    symlinkSync(repoDir, link);
    const file = writeConfig({}, { 'my-repo': link });
    const cfg = loadConnectorConfig({ file });
    expect(cfg.repositories['my-repo']).toBe(repoDir);
  });

  it('rejects a repository path that does not exist', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({}, { 'my-repo': join(dir, 'missing') });
    expect(() => loadConnectorConfig({ file })).toThrow(/exist/i);
  });

  it('allows plain http only for loopback server URLs', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    expect(() => loadConnectorConfig({ file: writeConfig({ serverUrl: 'http://127.0.0.1:4000' }) })).not.toThrow();
    expect(() => loadConnectorConfig({ file: writeConfig({ serverUrl: 'http://localhost:4000' }) })).not.toThrow();
    expect(() => loadConnectorConfig({ file: writeConfig({ serverUrl: 'http://[::1]:4000' }) })).not.toThrow();
  });

  it('rejects plain http to non-loopback hosts: bearer token requires https', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({ serverUrl: 'http://flow.example.com' });
    expect(() => loadConnectorConfig({ file })).toThrow(/https/i);
  });

  it('rejects server URLs containing userinfo credentials', () => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    const file = writeConfig({ serverUrl: 'https://user:secret@flow.example.com' });
    expect(() => loadConnectorConfig({ file })).toThrow(/credential|userinfo|url/i);
  });
});

describe('local execution profiles', () => {
  let executable;
  let claudeContext;
  let codexContext;

  beforeEach(() => {
    writeFileSync(join(dir, 'token'), 'ffh_tok');
    executable = join(dir, 'bin', 'native-tool');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    claudeContext = join(dir, 'ctx-claude');
    codexContext = join(dir, 'ctx-codex');
    for (const context of [claudeContext, codexContext]) { mkdirSync(context); chmodSync(context, 0o700); }
  });

  const claudeProfile = (overrides = {}) => ({ id: 'claude-a', name: 'Claude A', backend: 'claude-code', executable, contextDir: claudeContext, model: 'model-a', policy: { permissionMode: 'manual' }, ...overrides });
  const codexProfile = (overrides = {}) => ({ id: 'codex-a', name: 'Codex A', backend: 'codex', executable, contextDir: codexContext, model: 'model-b', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, ...overrides });
  const profilesFile = (value) => {
    const file = join(dir, 'profiles.json');
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  it('a legacy Paseo-only config without the flag fails with the opt-in message', () => {
    const file = writeConfig({ paseo: { home: join(dir, 'paseo-home') } });
    let error;
    try { loadConfig({ file }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ConnectorConfigError);
    expect(error.code).toBe('paseo_opt_in_required');
    expect(error.message).toBe('Enable the saved integration explicitly or configure an available execution profile.');
  });

  it('with enableIntegrations [\'paseo\'] the saved ids are served unchanged', () => {
    const file = writeConfig({ paseo: { home: join(dir, 'paseo-home') } });
    const before = readFileSync(file, 'utf8');
    const cfg = loadConfig({ file, enableIntegrations: ['paseo'] });
    expect(cfg.integrations.paseo).toEqual({ enabled: true, savedProfileIds: ['p-coder'], home: join(dir, 'paseo-home'), cliPath: null });
    expect(cfg.profiles).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps saved Paseo ids unserved when a complete standalone profile starts without the flag', () => {
    const file = writeConfig({ profiles: [claudeProfile()], integrations: { paseo: { profiles: ['p-coder'] } } });
    const cfg = loadConfig({ file });
    expect(cfg.integrations.paseo.enabled).toBe(false);
    expect(cfg.integrations.paseo.savedProfileIds).toEqual(['p-coder']);
    expect(cfg.profiles.map((p) => [p.id, p.complete])).toEqual([['claude-a', true]]);
  });

  it('an incomplete profile keeps its problems and does not block a complete one', () => {
    const file = writeConfig({ profiles: [claudeProfile(), codexProfile({ model: undefined })] });
    const cfg = loadConfig({ file });
    const [complete, incomplete] = cfg.profiles;
    expect(complete).toMatchObject({ id: 'claude-a', complete: true, problems: [], policy: { permissionMode: 'manual' } });
    expect(incomplete).toMatchObject({ id: 'codex-a', complete: false });
    expect(incomplete.problems).toContain('missing_model');
  });

  it('a config with only incomplete profiles and no saved ids is no_complete_profile', () => {
    const file = writeConfig({ profiles: [codexProfile({ model: undefined })] });
    expect(() => loadConfig({ file })).toThrow(expect.objectContaining({ code: 'no_complete_profile', message: 'Configure a complete execution profile before starting the runner.' }));
  });

  it('a context dir with group/other bits is context_dir_not_private', () => {
    chmodSync(claudeContext, 0o750);
    const { profiles } = loadLocalProfiles({ file: profilesFile({ profiles: [claudeProfile()] }) });
    expect(profiles[0].complete).toBe(false);
    expect(profiles[0].problems).toContain('context_dir_not_private');
  });

  it('a Codex profile without approvalPolicy is incomplete', () => {
    const { profiles } = loadLocalProfiles({ file: profilesFile({ profiles: [codexProfile({ policy: { sandbox: 'workspace-write', networkAccess: false } })] }) });
    expect(profiles[0]).toMatchObject({ complete: false, policy: null });
    expect(profiles[0].problems).toContain('missing_policy_field');
  });

  it('a Claude profile without a permission mode gets no implicit policy', () => {
    const { profiles } = loadLocalProfiles({ file: profilesFile({ profiles: [claudeProfile({ policy: {} })] }) });
    expect(profiles[0]).toMatchObject({ complete: false, policy: null });
    expect(profiles[0].problems).toContain('missing_policy_field');
  });

  it('resolves the executable real path', () => {
    const link = join(dir, 'bin', 'linked-tool');
    symlinkSync(executable, link);
    const { profiles } = loadLocalProfiles({ file: profilesFile({ profiles: [claudeProfile({ executable: link })] }) });
    expect(profiles[0]).toMatchObject({ complete: true, executable });
  });

  it('capacity defaults to 1 and rejects 0 or non-integers', () => {
    expect(loadLocalProfiles({ file: profilesFile({ profiles: [] }) }).capacity).toEqual({ 'claude-code': 1, codex: 1 });
    expect(loadLocalProfiles({ file: profilesFile({ profiles: [], capacity: { codex: 3 } }) }).capacity).toEqual({ 'claude-code': 1, codex: 3 });
    expect(() => loadLocalProfiles({ file: profilesFile({ profiles: [], capacity: { codex: 0 } }) })).toThrow(/capacity/);
    expect(() => loadLocalProfiles({ file: profilesFile({ profiles: [], capacity: { 'claude-code': 1.5 } }) })).toThrow(/capacity/);
    expect(loadConfig({ file: writeConfig({ profiles: [claudeProfile()], capacity: { 'claude-code': 2 } }) }).capacity).toEqual({ 'claude-code': 2, codex: 1 });
    expect(() => loadConfig({ file: writeConfig({ profiles: [claudeProfile()], capacity: { 'claude-code': 0 } }) })).toThrow(/capacity/);
  });

  it('duplicate standalone profile ids are rejected, not resolved by order', () => {
    const file = writeConfig({ profiles: [claudeProfile(), codexProfile({ id: 'claude-a' })] });
    expect(() => loadConfig({ file })).toThrow(expect.objectContaining({ code: 'duplicate_profile_id' }));
    expect(() => loadLocalProfiles({ file: profilesFile({ profiles: [claudeProfile(), codexProfile({ id: 'claude-a', model: undefined })] }) })).toThrow(expect.objectContaining({ code: 'duplicate_profile_id' }));
  });

  it('a standalone id equal to a saved Paseo id is rejected with or without the flag', () => {
    const file = writeConfig({ profiles: [claudeProfile({ id: 'p-coder' })], integrations: { paseo: { profiles: ['p-coder'] } } });
    for (const enableIntegrations of [[], ['paseo']]) {
      expect(() => loadConfig({ file, enableIntegrations })).toThrow(expect.objectContaining({ code: 'duplicate_profile_id', message: 'Execution profile ids must be unique across local profiles and saved integrations. Fix the local configuration.' }));
    }
  });

  it('a saved Paseo id repeated within its own list is rejected, not collapsed', () => {
    for (const extra of [{ profiles: [], integrations: { paseo: { profiles: ['p-coder', 'p-coder'] } } }, { profiles: ['p-coder', 'p-coder'], paseo: {} }]) {
      for (const enableIntegrations of [[], ['paseo']]) {
        expect(() => loadConfig({ file: writeConfig(extra), enableIntegrations }), JSON.stringify(extra)).toThrow(expect.objectContaining({ code: 'duplicate_profile_id' }));
      }
    }
  });
});
