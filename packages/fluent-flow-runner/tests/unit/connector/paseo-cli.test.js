import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppImagePath, resolvePaseoCli, createStopAgent } from '../../../src/connector/paseo-cli.js';
import { resolveLocalDaemon, parseListen } from '../../../src/connector/paseo-local.js';

/**
 * Host-control prerequisites: AppImage header detection (verified magic bytes
 * of the installed binary: 7f 45 4c 46 02 01 01 00 41 49 02), extract-and-run
 * resolution, strict stop invocation, and local daemon discovery — all with
 * REAL temp files, only execFile injected.
 */

function appImageBytes() {
  // Real installed header: 7f 45 4c 46 02 01 01 00 41 49 02 00...
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02, 0x00]), Buffer.alloc(64)]);
}

describe('AppImage header detection (fixed header read only)', () => {
  it('invokes a callback-style stop exactly once', async () => {
    let calls = 0;
    const stop = createStopAgent({ cliCommand: '/installed/paseo', home: '/private/paseo', io: { execFile: (_command, _args, _opts, callback) => { calls++; queueMicrotask(() => callback(null, '', '')); return {}; } } });
    await stop('full-agent-id');
    expect(calls).toBe(1);
  });
  it('detects a real AppImage by magic at offsets 8..10', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
    try {
      const img = join(dir, 'Paseo.AppImage');
      writeFileSync(img, appImageBytes());
      expect(isAppImagePath(img)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects through a symlink to the AppImage (installed layout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
    try {
      const img = join(dir, 'Paseo-x86_64.AppImage');
      writeFileSync(img, appImageBytes());
      const link = join(dir, 'paseo');
      symlinkSync(img, link);
      expect(isAppImagePath(link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects ELF non-AppImage binaries and text files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
    try {
      const elf = join(dir, 'prog');
      writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]));
      const txt = join(dir, 'notes.txt');
      writeFileSync(txt, 'hello');
      expect(isAppImagePath(elf)).toBe(false);
      expect(isAppImagePath(txt)).toBe(false);
      expect(isAppImagePath('')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolvePaseoCli (extract-and-run)', () => {
  it('extracts once into a private 0700 cache and runs the inner CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
    const cacheDir = join(dir, 'cache');
    try {
      const img = join(dir, 'Paseo.AppImage');
      writeFileSync(img, appImageBytes());
      const extractions = [];
      const exec = async (command, args, opts) => {
        extractions.push({ command, args, cwd: opts?.cwd });
        // Simulate the AppImage self-extraction into the cwd.
        const inner = join(opts.cwd, 'squashfs-root', 'resources', 'bin', 'paseo');
        mkdirSync(join(opts.cwd, 'squashfs-root', 'resources', 'bin'), { recursive: true });
        writeFileSync(inner, '#!/bin/sh\nexit 0\n');
        chmodSync(inner, 0o755); // real extraction yields an executable entry
        return { stdout: '', stderr: '' };
      };
      const resolved = await resolvePaseoCli({ cliPath: img, cacheDir, io: { execFile: exec, existsSync: (p) => p === img } });
      expect(resolved.command).toBe(join(cacheDir, 'squashfs-root', 'resources', 'bin', 'paseo'));
      expect(resolved.extracted).toBe(true);
      expect(extractions).toHaveLength(1);
      expect(extractions[0].args).toEqual(['--appimage-extract']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses an explicit non-AppImage cliPath as-is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
    try {
      const bin = join(dir, 'paseo-bin');
      writeFileSync(bin, 'not an appimage');
      const resolved = await resolvePaseoCli({ cliPath: bin, cacheDir: join(dir, 'cache'), io: { execFile: async () => ({ stdout: '', stderr: '' }) } });
      expect(resolved.command).toBe(bin);
      expect(resolved.extracted).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with a clear error when no CLI exists', async () => {
    await expect(
      resolvePaseoCli({ cliPath: join(tmpdir(), 'definitely-missing-paseo'), cacheDir: join(tmpdir(), 'ff-cache-x') }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('createStopAgent (strict CLI stop)', () => {
  it('runs paseo stop with the full agent id and selected home, never --all', async () => {
    const calls = [];
    const stop = createStopAgent({
      cliCommand: '/opt/paseo-cli',
      home: '/home/tester/.paseo',
      io: {
        execFile: (command, args, opts, cb) => {
          calls.push({ command, args });
          cb(null, '', '');
        },
      },
    });
    await stop('ag-abc123');
    expect(calls[0]).toEqual({ command: '/opt/paseo-cli', args: ['stop', 'ag-abc123', '--home', '/home/tester/.paseo', '--json'] });
  });

  it('refuses flag-shaped or empty ids that could widen the stop scope', async () => {
    const stop = createStopAgent({
      cliCommand: 'paseo',
      home: '/h',
      io: { execFile: (c, a, cb) => cb(null, '', '') },
    });
    await expect(stop('--all')).rejects.toThrow(/full agent id/i);
    await expect(stop('')).rejects.toThrow(/full agent id/i);
    await expect(stop(undefined)).rejects.toThrow(/full agent id/i);
  });
});

describe('resolveLocalDaemon (real temp home files)', () => {
  it('derives the loopback ws URL and reads the local credential', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
    try {
      writeFileSync(join(home, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:6767' }));
      writeFileSync(join(home, 'local-credential'), `${createHash('sha256').update('x').digest('base64url').slice(0, 43)}\n`);
      const daemon = await resolveLocalDaemon({ home });
      expect(daemon.url).toBe('ws://127.0.0.1:6767/ws');
      expect(daemon.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback daemon addresses', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
    try {
      writeFileSync(join(home, 'paseo.pid'), JSON.stringify({ listen: '10.0.0.5:6767' }));
      writeFileSync(join(home, 'local-credential'), 'x'.repeat(43));
      await expect(resolveLocalDaemon({ home })).rejects.toThrow(/loopback/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a missing credential file without echoing paths into the error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
    try {
      writeFileSync(join(home, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:6767' }));
      await expect(resolveLocalDaemon({ home })).rejects.toThrow(/credential file is unavailable/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parseListen normalizes tcp:// and rejects garbage', () => {
    expect(parseListen('127.0.0.1:6767')).toBe('ws://127.0.0.1:6767/ws');
    expect(parseListen('tcp://127.0.0.1:6767')).toBe('ws://127.0.0.1:6767/ws');
    expect(parseListen('not-an-endpoint')).toBeNull();
    expect(parseListen('10.1.2.3:6767')).toBeNull();
  });
});
