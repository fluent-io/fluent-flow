import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const ADAPTERS = new Map([
  ['claude-code', { bin: 'claude-agent-acp', args: [] }],
  ['claude-agent-acp', { bin: 'claude-agent-acp', args: [] }],
  ['codex', { bin: 'codex-acp', args: [] }],
  ['codex-acp', { bin: 'codex-acp', args: [] }],
  ['opencode', { bin: 'opencode', args: ['acp'] }],
]);

const WINDOWS_PACKAGES = new Map([
  ['claude-agent-acp', [
    '@agentclientprotocol/claude-agent-acp',
  ]],
  ['codex-acp', [
    '@agentclientprotocol/codex-acp',
  ]],
  ['opencode', [
    'opencode-ai',
  ]],
]);

function assertArguments(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new Error('ACP arguments must be an array of strings');
  }
}

function assertExecutable(command) {
  if (typeof command !== 'string' || command.length === 0 || command !== command.trim() || command.includes('\0')) {
    throw new Error('An explicit ACP executable command is required');
  }
  if (/[|&;<>`"'\r\n]/u.test(command) || (/\s/u.test(command) && !/[\\/]/u.test(command))) {
    throw new Error('ACP command must be one executable path, not shell command text');
  }
}

function packageBin(packageJson, executable) {
  if (typeof packageJson.bin === 'string') return packageJson.bin;
  if (packageJson.bin && typeof packageJson.bin === 'object' && typeof packageJson.bin[executable] === 'string') {
    return packageJson.bin[executable];
  }
  return null;
}

function resolveKnownWindowsShim(executable, args) {
  const candidates = WINDOWS_PACKAGES.get(executable);
  if (!candidates) return null;

  for (const pathDirectory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const shim = join(pathDirectory, `${executable}.cmd`);
    if (!existsSync(shim)) continue;

    const packageRoots = [dirname(pathDirectory), join(pathDirectory, 'node_modules')];
    for (const packageRoot of packageRoots) {
      for (const packageName of candidates) {
        const packageDirectory = join(packageRoot, ...packageName.split('/'));
        const metadataPath = join(packageDirectory, 'package.json');
        if (!existsSync(metadataPath)) continue;

        let metadata;
        try {
          metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        } catch {
          throw new Error('Known ACP adapter package metadata is invalid');
        }
        if (metadata?.name !== packageName) continue;

        const declaredBin = packageBin(metadata, executable);
        if (!declaredBin || isAbsolute(declaredBin)) continue;
        const entry = resolve(packageDirectory, declaredBin);
        const packageRelativeEntry = relative(packageDirectory, entry);
        if (packageRelativeEntry === '' || packageRelativeEntry.startsWith('..') || isAbsolute(packageRelativeEntry)) continue;
        if (!existsSync(entry)) continue;
        return { bin: process.execPath, args: [entry, ...args] };
      }
    }

    throw new Error('Known ACP adapter package metadata could not resolve its executable');
  }

  return null;
}

export function canonicalAdapter(agentType) {
  return ADAPTERS.get(agentType)?.bin ?? null;
}

export function resolveAcpCommand({ agentType = undefined, command = undefined, args = [] } = {}) {
  assertArguments(args);

  if (command !== undefined && command !== null) {
    assertExecutable(command);
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
      throw new Error('Windows .cmd and .bat wrappers are not supported for ACP commands');
    }
    return { bin: command, args: [...args] };
  }

  const adapter = ADAPTERS.get(agentType);
  if (!adapter) throw new Error('Unsupported agent type requires an explicit local ACP command');
  if (args.length > 0) throw new Error('ACP arguments require an explicit local ACP command');

  if (process.platform === 'win32') {
    const resolved = resolveKnownWindowsShim(adapter.bin, adapter.args);
    if (resolved) return resolved;
  }

  return { bin: adapter.bin, args: [...adapter.args] };
}
