import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveAcpCommand } from '../../src/acp/command.js';

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const temporaryDirectories = [];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  process.env.PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('resolveAcpCommand', () => {
  it.each([
    ['claude-code', 'claude-agent-acp', []],
    ['claude-agent-acp', 'claude-agent-acp', []],
    ['codex', 'codex-acp', []],
    ['codex-acp', 'codex-acp', []],
    ['opencode', 'opencode', ['acp']],
  ])('maps %s to a local ACP adapter', (agentType, bin, args) => {
    expect(resolveAcpCommand({ agentType })).toEqual({ bin, args });
  });

  it('uses an explicit local command and preserves discrete arguments', () => {
    expect(resolveAcpCommand({
      agentType: 'local-agent',
      command: '/opt/acp agent/bin/agent',
      args: ['--profile', 'local value', '$(not-executed)'],
    })).toEqual({
      bin: '/opt/acp agent/bin/agent',
      args: ['--profile', 'local value', '$(not-executed)'],
    });
  });

  it('requires an explicit command for an unknown agent type', () => {
    expect(() => resolveAcpCommand({ agentType: 'unknown' })).toThrow(/explicit.*command/i);
  });

  it.each(['agent --flag', 'agent | other', 'agent && other', 'agent; other'])('rejects shell command text %s', (command) => {
    expect(() => resolveAcpCommand({ agentType: 'custom', command })).toThrow(/shell|executable|command/i);
  });

  it('uses native Windows executables without a shell', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveAcpCommand({ agentType: 'custom', command: 'C:\\Tools\\agent.exe', args: ['acp'] }))
      .toEqual({ bin: 'C:\\Tools\\agent.exe', args: ['acp'] });
    expect(resolveAcpCommand({ agentType: 'custom', command: 'C:\\Tools\\agent', args: [] }))
      .toEqual({ bin: 'C:\\Tools\\agent', args: [] });
  });

  it('resolves a known Windows npm shim through its adjacent package bin', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const root = mkdtempSync(join(tmpdir(), 'ff-acp-command-'));
    temporaryDirectories.push(root);
    const binDirectory = join(root, 'node_modules', '.bin');
    const packageDirectory = join(root, 'node_modules', '@agentclientprotocol', 'codex-acp');
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(join(binDirectory, 'codex-acp.cmd'), '@echo off\r\nnode "%~dp0\\..\\@agentclientprotocol\\codex-acp\\dist\\cli.js" %*\r\n');
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': './dist/cli.js' } }));
    writeFileSync(join(packageDirectory, 'dist', 'cli.js'), '');
    process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ''}`;

    expect(resolveAcpCommand({ agentType: 'codex' })).toEqual({
      bin: process.execPath,
      args: [join(packageDirectory, 'dist', 'cli.js')],
    });
  });

  it('resolves a known Windows global npm shim through its installed package bin', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const root = mkdtempSync(join(tmpdir(), 'ff-acp-command-global-'));
    temporaryDirectories.push(root);
    const binDirectory = join(root, 'npm');
    const packageDirectory = join(binDirectory, 'node_modules', '@agentclientprotocol', 'codex-acp');
    mkdirSync(join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(join(binDirectory, 'codex-acp.cmd'), '@echo off\r\nnode "%~dp0\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\cli.js" %*\r\n');
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': './dist/cli.js' } }));
    writeFileSync(join(packageDirectory, 'dist', 'cli.js'), '');
    process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ''}`;

    expect(resolveAcpCommand({ agentType: 'codex' })).toEqual({
      bin: process.execPath,
      args: [join(packageDirectory, 'dist', 'cli.js')],
    });
  });

  it('rejects arbitrary Windows cmd wrappers', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => resolveAcpCommand({ agentType: 'custom', command: 'C:\\Tools\\custom.cmd' })).toThrow(/\.cmd|wrapper/i);
  });
});
