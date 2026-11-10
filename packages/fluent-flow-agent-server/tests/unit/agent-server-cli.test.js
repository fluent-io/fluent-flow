import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { installSignalShutdown, isDirectRun } from '../../bin/fluent-flow-agent-server.js';

describe('agent server CLI signal shutdown', () => {
  it('waits for aggregate server shutdown instead of exiting on a timer or second signal', async () => {
    const processLike = new EventEmitter();
    processLike.exit = vi.fn();
    processLike.exitCode = undefined;
    let finishShutdown;
    const server = {
      shutdown: vi.fn(() => new Promise((resolve) => {
        finishShutdown = resolve;
      })),
    };
    const waitForShutdown = installSignalShutdown(server, processLike);

    processLike.emit('SIGTERM');
    await Promise.resolve();
    expect(server.shutdown).toHaveBeenCalledOnce();
    expect(processLike.exit).not.toHaveBeenCalled();

    processLike.emit('SIGINT');
    expect(processLike.exitCode).toBe(1);
    expect(processLike.exit).not.toHaveBeenCalled();

    finishShutdown();
    await waitForShutdown();
    expect(processLike.exit).not.toHaveBeenCalled();
  });
});

describe('agent server CLI signal registration per platform', () => {
  function installed(platform) {
    const processLike = new EventEmitter();
    processLike.exitCode = undefined;
    const server = { shutdown: vi.fn(async () => undefined) };
    installSignalShutdown(server, processLike, undefined, { platform });
    return { processLike, server };
  }

  it.each(['linux', 'darwin'])('listens for SIGTERM and SIGINT but not SIGBREAK on %s', (platform) => {
    const { processLike } = installed(platform);

    expect(processLike.listenerCount('SIGTERM')).toBe(1);
    expect(processLike.listenerCount('SIGINT')).toBe(1);
    expect(processLike.listenerCount('SIGBREAK')).toBe(0);
  });

  it.each(['SIGBREAK', 'SIGINT', 'SIGTERM'])('shuts down once on %s when the platform is win32', async (signal) => {
    const { processLike, server } = installed('win32');

    expect(processLike.listenerCount('SIGBREAK')).toBe(1);
    processLike.emit(signal);
    await Promise.resolve();

    expect(server.shutdown).toHaveBeenCalledOnce();
  });

  it('defaults to the host platform', () => {
    const processLike = new EventEmitter();

    installSignalShutdown({ shutdown: vi.fn() }, processLike);

    expect(processLike.listenerCount('SIGBREAK')).toBe(process.platform === 'win32' ? 1 : 0);
  });
});

describe('agent server CLI entry detection', () => {
  it('compares canonical native paths so drive-letter case and short names do not matter', () => {
    const canonical = (path) => path.replace(/\//gu, '\\').replace(/^\\(?=[a-z]:)/iu, '').toLowerCase();
    const moduleHref = 'file:///C:/Repo/bin/cli.js';

    expect(isDirectRun('c:\\repo\\bin\\cli.js', moduleHref, { realpath: canonical })).toBe(true);
    expect(isDirectRun('C:\\Repo\\other.js', moduleHref, { realpath: canonical })).toBe(false);
  });

  const realBin = fileURLToPath(new URL('../../bin/fluent-flow-agent-server.js', import.meta.url));
  const moduleUrl = new URL('../../bin/fluent-flow-agent-server.js', import.meta.url).href;

  it('is true for the module path and for a package-manager symlink to it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-flow-entry-'));
    try {
      const shim = join(directory, 'fluent-flow-agent-server');
      await symlink(realBin, shim);

      expect(isDirectRun(realBin, moduleUrl)).toBe(true);
      expect(isDirectRun(shim, moduleUrl)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('is false when another file is the entry or there is no entry', () => {
    expect(isDirectRun(fileURLToPath(import.meta.url), moduleUrl)).toBe(false);
    expect(isDirectRun(undefined, moduleUrl)).toBe(false);
    expect(isDirectRun('', moduleUrl)).toBe(false);
  });

  it('does not depend on the test runner environment variable', () => {
    const saved = process.env.VITEST;
    try {
      delete process.env.VITEST;
      expect(isDirectRun(fileURLToPath(import.meta.url), moduleUrl)).toBe(false);
      expect(isDirectRun(realBin, moduleUrl)).toBe(true);
    } finally {
      process.env.VITEST = saved;
    }
  });
});

function runToCompletion(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

describe('agent server CLI launched through a package-manager symlink', () => {
  it('runs main and fails invalid arguments with a generic error and no echoed secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluent-flow-cli-link-'));
    try {
      const realBin = fileURLToPath(new URL('../../bin/fluent-flow-agent-server.js', import.meta.url));
      const shim = join(directory, 'fluent-flow-agent-server');
      await symlink(realBin, shim);

      const result = await runToCompletion(
        process.execPath,
        [
          shim,
          '--server', 'http://example.invalid',
          '--provider', 'claude-code',
          '--enrollment-token', 'enroll_symlink_secret_value',
        ],
        {
          PATH: process.env.PATH,
          HOME: directory,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      );

      expect(result.signal).toBeNull();
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/configuration failed/iu);
      expect(result.output).not.toContain('enroll_symlink_secret_value');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
