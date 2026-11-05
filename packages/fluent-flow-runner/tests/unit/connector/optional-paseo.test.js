import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const pkg = resolve(import.meta.dirname, '../../..');
const denyHook = join(import.meta.dirname, 'helpers/deny-paseo-sdk.mjs');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-optional-paseo-'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, 'paseo-home'));
  mkdirSync(join(dir, 'ctx'));
  chmodSync(join(dir, 'ctx'), 0o700);
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'token'), 'ffh_tok\n', { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(extra) {
  const file = join(dir, 'connector.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', tokenFile: join(dir, 'token'), instanceId: 'optional-test', repositories: { demo: join(dir, 'repo') }, ...extra }));
  return file;
}

async function node(args, { transitive = false } = {}) {
  const hook = pathToFileURL(denyHook).href + (transitive ? '?transitive=1' : '');
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', hook, ...args], { cwd: pkg, env: { PATH: process.env.PATH, HOME: join(dir, 'home') }, timeout: 15_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('optional Paseo SDK', () => {
  it('standalone config loads and runtime.js imports without the SDK', async () => {
    const file = writeConfig({ profiles: [{ id: 'claude-a', name: 'Claude A', backend: 'claude-code', executable: join(dir, 'tool'), contextDir: join(dir, 'ctx'), model: 'model-a', policy: { permissionMode: 'manual' } }] });
    const script = `
      const sdk = await import('@getpaseo/client').then(() => 'resolved', (error) => error.code);
      if (sdk !== 'ERR_MODULE_NOT_FOUND') { console.error('deny hook inactive: ' + sdk); process.exit(3); }
      const { loadConnectorConfig } = await import(${JSON.stringify(pathToFileURL(join(pkg, 'src/connector/config.js')).href)});
      const config = loadConnectorConfig({ file: ${JSON.stringify(file)} });
      if (!config.profiles[0].complete || config.integrations.paseo.enabled) process.exit(2);
      await import(${JSON.stringify(pathToFileURL(join(pkg, 'src/connector/runtime.js')).href)});`;
    const result = await node(['--input-type=module', '-e', script]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('--enable-integration paseo without the SDK prints the not-installed message and exits 1', async () => {
    const file = writeConfig({ profiles: ['p-coder'], paseo: { home: join(dir, 'paseo-home') } });
    const result = await node([join(pkg, 'bin/fluent-flow-connector.js'), '--config', file, '--enable-integration', 'paseo']);
    expect(result.stderr.trim()).toBe('The Paseo integration is not installed on this host.');
    expect(result.code).toBe(1);
  });

  it('a saved Paseo config without the flag prints the opt-in message and exits 1', async () => {
    const file = writeConfig({ profiles: ['p-coder'], paseo: { home: join(dir, 'paseo-home') } });
    const result = await node([join(pkg, 'bin/fluent-flow-connector.js'), '--config', file]);
    expect(result.stderr.trim()).toBe('Enable the saved integration explicitly or configure an available execution profile.');
    expect(result.code).toBe(1);
  });

  it('a missing SDK dependency is not reported as a missing SDK', async () => {
    const file = writeConfig({ profiles: ['p-coder'], paseo: { home: join(dir, 'paseo-home') } });
    const result = await node([join(pkg, 'bin/fluent-flow-connector.js'), '--config', file, '--enable-integration', 'paseo'], { transitive: true });
    const lines = result.stderr.trim().split('\n');
    expect(lines.at(-1)).toBe('Connector startup failed. Check the local configuration and Node 22 runtime.');
    expect(result.stderr).not.toContain('The Paseo integration is not installed on this host.');
    expect(JSON.parse(lines.at(-2))).toMatchObject({ msg: 'connector startup failed', error: expect.stringContaining("Cannot find package '@getpaseo/protocol'") });
    expect(result.code).toBe(1);
  });
});
