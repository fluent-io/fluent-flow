import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConnectorConfig } from '../../../src/connector/config.js';

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
    expect(() => loadConnectorConfig({ file })).toThrow(/profile/i);
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
