
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { NATIVE_PINS } from '../../../src/native/pins.js';

const CONFIG = {
  'claude-code': { override: 'FF_NATIVE_CLAUDE_BIN', name: 'claude', pattern: /^(\d+\.\d+\.\d+) \(Claude Code\)$/ },
  codex: { override: 'FF_NATIVE_CODEX_BIN', name: 'codex', pattern: /^codex-cli (\d+\.\d+\.\d+)$/ },
};

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}

/**
 * @param {'claude-code'|'codex'} backend
 * @returns {{ executable: string, version: string } | null}
 */
export function requireNativeBinary(backend) {
  const cfg = CONFIG[backend];
  if (!cfg) throw new Error(`unknown native backend: ${backend}`);
  const executable = process.env[cfg.override] || findOnPath(cfg.name);
  if (!executable) {
    if (!process.env.CI && process.env.FF_NATIVE_REQUIRED !== '1') return null;
    throw new Error(`native_binary_missing: ${backend}`);
  }
  const out = execFileSync(executable, ['--version'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 15_000 }).trim();
  const version = out.match(cfg.pattern)?.[1];
  if (!version || !NATIVE_PINS[backend].versions.includes(version)) {
    throw new Error(`native_version_incompatible: ${backend} reported "${out}"`);
  }
  return { executable, version };
}

export function platformCodex(executable) {
  const fd = openSync(executable, 'r');
  const head = Buffer.alloc(2);
  try {
    readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString() !== '#!') return executable;
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('native test: only the linux x64 Codex package layout is known');
  const packageRoot = dirname(dirname(realpathSync(executable)));
  const binary = join(packageRoot, 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex');
  const version = execFileSync(binary, ['--version'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 15_000 }).trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
  if (!version || !NATIVE_PINS.codex.versions.includes(version)) throw new Error(`native test: platform Codex binary is not pinned (${version})`);
  return binary;
}
