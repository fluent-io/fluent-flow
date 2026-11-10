import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnAcpProcess } from '../../src/acp/process.js';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4312,
    kill: vi.fn(() => true),
  });
}

describe('spawnAcpProcess', () => {
  it('spawns with portable pipe options, an argument array, and no shell', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child);
    spawnAcpProcess({
      bin: '/opt/agent',
      args: ['acp', '--profile', 'local'],
      cwd: '/worktree',
      env: { SAFE: 'value' },
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledWith('/opt/agent', ['acp', '--profile', 'local'], {
      cwd: '/worktree',
      env: { SAFE: 'value' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
  });

  it('exposes stdin and stdout as Web streams', async () => {
    const child = fakeChild();
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child });
    expect(process.input).toBeInstanceOf(WritableStream);
    expect(process.output).toBeInstanceOf(ReadableStream);

    const reader = process.output.getReader();
    child.stdout.write('hello');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('hello');
    reader.releaseLock();
  });

  it('keeps only the bounded tail of stderr', async () => {
    const child = fakeChild();
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child, stderrLimitBytes: 8 });
    child.stderr.write('012345');
    child.stderr.write('6789');
    child.emit('close', 1, null);
    await process.exited;
    expect(process.stderr).toBe('23456789');
  });

  it('settles one exit result when error, exit, and close all arrive', async () => {
    const child = fakeChild();
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child });
    const observed = [];
    process.exited.then((result) => observed.push(result));
    child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await process.exited;
    await Promise.resolve();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ code: null, signal: null, error: expect.objectContaining({ code: 'ENOENT' }) });
  });

  it('reports a normal direct-child exit', async () => {
    const child = fakeChild();
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child });
    child.emit('close', 0, null);
    await expect(process.exited).resolves.toEqual({ code: 0, signal: null, error: null });
    expect(process.pid).toBe(4312);
  });

  it('closes stdin idempotently', () => {
    const child = fakeChild();
    const end = vi.spyOn(child.stdin, 'end');
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child });
    process.closeInput();
    process.closeInput();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('signals only the direct child', () => {
    const child = fakeChild();
    const process = spawnAcpProcess({ bin: 'agent', args: [], spawnImpl: () => child });
    expect(process.kill('SIGTERM')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
