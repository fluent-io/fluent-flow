import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateState, storeRuntimeToken } from '../../src/state.js';

const STATE_FILE = 'state.json';
const MAX_STATE_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_IS_WINDOWS = process.platform === 'win32';
const PLATFORMS = [...new Set([process.platform, 'win32'])];
const roots = [];

async function temporaryStateDir() {
  const root = await mkdtemp(join(tmpdir(), 'ff-agent-server-state-'));
  roots.push(root);
  return { root, stateDir: join(root, 'state') };
}

async function writeStateFixture(stateDir, contents, mode = 0o600) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, STATE_FILE), contents, { mode });
  await chmod(join(stateDir, STATE_FILE), mode);
}

function systemError(code) {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

function recordingOpen() {
  const calls = [];
  const openImpl = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    const call = { path, synced: false };
    calls.push(call);
    return {
      stat: () => handle.stat(),
      chmod: (value) => handle.chmod(value),
      writeFile: (...args) => handle.writeFile(...args),
      readFile: (...args) => handle.readFile(...args),
      sync: async () => {
        call.synced = true;
        return handle.sync();
      },
      close: () => handle.close(),
    };
  };
  return { calls, openImpl };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(PLATFORMS)('private agent-server state on %s', (platform) => {
  it('creates state with a stable UUID and an explicit null runtime token', async () => {
    const { stateDir } = await temporaryStateDir();

    const created = await loadOrCreateState(stateDir, { platform });
    const loaded = await loadOrCreateState(stateDir, { platform });

    expect(created.instanceId).toMatch(UUID_PATTERN);
    expect(created.token).toBeNull();
    expect(loaded).toEqual(created);
    expect(JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8'))).toEqual(created);
  });

  it('publishes one stable initial identity across concurrent starts', async () => {
    const { stateDir } = await temporaryStateDir();
    const concurrency = 32;

    const states = await Promise.all(
      Array.from({ length: concurrency }, () => loadOrCreateState(stateDir, { platform })),
    );

    const expected = { instanceId: states[0].instanceId, token: null };
    expect(expected.instanceId).toMatch(UUID_PATTERN);
    expect(states).toEqual(Array.from({ length: concurrency }, () => expected));
    expect(JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8'))).toEqual(expected);
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
  });

  it('preserves the instance ID and runtime token across repeated loads', async () => {
    const { stateDir } = await temporaryStateDir();
    const created = await loadOrCreateState(stateDir, { platform });
    const runtimeToken = `ff_${'b'.repeat(64)}`;

    await storeRuntimeToken(stateDir, created.instanceId, runtimeToken, { platform });

    await expect(loadOrCreateState(stateDir, { platform })).resolves.toEqual({
      instanceId: created.instanceId,
      token: runtimeToken,
    });
    await expect(loadOrCreateState(stateDir, { platform })).resolves.toEqual({
      instanceId: created.instanceId,
      token: runtimeToken,
    });
  });

  it('atomically replaces the state file through a temporary file without leaving it behind', async () => {
    const { stateDir } = await temporaryStateDir();
    const created = await loadOrCreateState(stateDir, { platform });
    const statePath = join(stateDir, STATE_FILE);
    const before = await stat(statePath);
    const runtimeToken = `ff_${'c'.repeat(64)}`;
    const renames = [];
    const renameImpl = async (from, to) => {
      renames.push([from, to]);
      return rename(from, to);
    };

    await storeRuntimeToken(stateDir, created.instanceId, runtimeToken, { platform, rename: renameImpl });

    const after = await stat(statePath);
    expect(after.ino).not.toBe(before.ino);
    expect(renames).toHaveLength(1);
    expect(renames[0][1]).toBe(statePath);
    expect(renames[0][0]).not.toBe(statePath);
    expect(renames[0][0].startsWith(stateDir)).toBe(true);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      instanceId: created.instanceId,
      token: runtimeToken,
    });
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
  });

  it('fails loudly on malformed JSON without replacing it', async () => {
    const { stateDir } = await temporaryStateDir();
    const malformed = '{"instanceId":';
    await writeStateFixture(stateDir, malformed);

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect(await readFile(join(stateDir, STATE_FILE), 'utf8')).toBe(malformed);
  });

  it('fails loudly on an invalid instance UUID without regenerating it', async () => {
    const { stateDir } = await temporaryStateDir();
    const invalid = JSON.stringify({ instanceId: 'portable-agent-1', token: null });
    await writeStateFixture(stateDir, invalid);

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect(await readFile(join(stateDir, STATE_FILE), 'utf8')).toBe(invalid);
  });

  it.each([
    ['instanceId', { instanceId: 42, token: null }],
    ['token', { instanceId: randomUUID(), token: 42 }],
  ])('fails loudly when %s has the wrong type', async (_field, value) => {
    const { stateDir } = await temporaryStateDir();
    const invalid = JSON.stringify(value);
    await writeStateFixture(stateDir, invalid);

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect(await readFile(join(stateDir, STATE_FILE), 'utf8')).toBe(invalid);
  });

  it('fails loudly on a state file above the size bound without replacing it', async () => {
    const { stateDir } = await temporaryStateDir();
    const oversized = JSON.stringify({ instanceId: randomUUID(), token: 'x'.repeat(MAX_STATE_BYTES) });
    await writeStateFixture(stateDir, oversized);

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow('unsafe');
    expect((await stat(join(stateDir, STATE_FILE))).size).toBe(Buffer.byteLength(oversized));
  });

  it('rejects a directory where the regular state file must be', async () => {
    const { stateDir } = await temporaryStateDir();
    await mkdir(join(stateDir, STATE_FILE), { recursive: true, mode: 0o700 });

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect((await lstat(join(stateDir, STATE_FILE))).isDirectory()).toBe(true);
  });

  it('rejects a symlink state path without reading or replacing its target', async () => {
    const { root, stateDir } = await temporaryStateDir();
    const target = join(root, 'outside.json');
    const original = JSON.stringify({ instanceId: randomUUID(), token: 'outside-secret' });
    await writeFile(target, original, { mode: 0o600 });
    await mkdir(stateDir, { mode: 0o700 });
    await symlink(target, join(stateDir, STATE_FILE));

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect((await lstat(join(stateDir, STATE_FILE))).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('rejects a symlinked state directory without writing through it', async () => {
    const { root, stateDir } = await temporaryStateDir();
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, stateDir, 'dir');

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a regular file where the state directory must be', async () => {
    const { stateDir } = await temporaryStateDir();
    await writeFile(stateDir, 'not a directory');

    await expect(loadOrCreateState(stateDir, { platform })).rejects.toThrow();
    expect(await readFile(stateDir, 'utf8')).toBe('not a directory');
  });
});

describe('private agent-server state on win32 filesystems that cannot open directories', () => {
  function windowsLikeOpen(stateDir) {
    const { calls, openImpl } = recordingOpen();
    const guarded = async (path, flags, mode) => {
      if (path === stateDir) throw systemError('EISDIR');
      return openImpl(path, flags, mode);
    };
    return { calls, guarded };
  }

  it('completes a create, load and store cycle without opening a directory handle', async () => {
    const { stateDir } = await temporaryStateDir();
    const { calls, guarded } = windowsLikeOpen(stateDir);
    const options = { platform: 'win32', open: guarded };

    const created = await loadOrCreateState(stateDir, options);
    const loaded = await loadOrCreateState(stateDir, options);
    await storeRuntimeToken(stateDir, created.instanceId, `ff_${'d'.repeat(64)}`, options);
    const stored = await loadOrCreateState(stateDir, options);

    expect(loaded).toEqual(created);
    expect(stored).toEqual({ instanceId: created.instanceId, token: `ff_${'d'.repeat(64)}` });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.path)).not.toContain(stateDir);
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
  });

  it('reads a state file whose reported mode is not 0600', async () => {
    const { stateDir } = await temporaryStateDir();
    const state = { instanceId: randomUUID(), token: null };
    await writeStateFixture(stateDir, JSON.stringify(state), 0o666);
    const { calls, openImpl } = recordingOpen();

    await expect(loadOrCreateState(stateDir, { platform: 'win32', open: openImpl })).resolves.toEqual(state);
    expect(calls.map((call) => call.path)).toContain(join(stateDir, STATE_FILE));
  });
});

describe.skipIf(NATIVE_IS_WINDOWS)('private agent-server state POSIX protections', () => {
  it('defaults to the host platform and creates a 0700 directory and a 0600 file', async () => {
    const { stateDir } = await temporaryStateDir();

    await loadOrCreateState(stateDir);

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, STATE_FILE))).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing state directory to 0700', async () => {
    const { stateDir } = await temporaryStateDir();
    await mkdir(stateDir, { mode: 0o755 });
    await chmod(stateDir, 0o755);

    await loadOrCreateState(stateDir, { platform: 'linux' });

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });

  it('keeps a 0600 state file after atomic replacement', async () => {
    const { stateDir } = await temporaryStateDir();
    const created = await loadOrCreateState(stateDir, { platform: 'linux' });

    await storeRuntimeToken(stateDir, created.instanceId, `ff_${'e'.repeat(64)}`, { platform: 'linux' });

    expect((await stat(join(stateDir, STATE_FILE))).mode & 0o777).toBe(0o600);
  });

  it.each(['linux', undefined])('opens and fsyncs the state directory (platform %s)', async (platform) => {
    const { stateDir } = await temporaryStateDir();
    const { calls, openImpl } = recordingOpen();
    const options = platform === undefined ? { open: openImpl } : { platform, open: openImpl };

    await loadOrCreateState(stateDir, options);

    const directoryCalls = calls.filter((call) => call.path === stateDir);
    expect(directoryCalls.length).toBeGreaterThanOrEqual(2);
    expect(directoryCalls.some((call) => call.synced)).toBe(true);
  });

  it.each(['linux', undefined])('rejects a state file that is not 0600 and leaves it untouched (platform %s)', async (platform) => {
    const { stateDir } = await temporaryStateDir();
    const contents = JSON.stringify({ instanceId: randomUUID(), token: null });
    await writeStateFixture(stateDir, contents, 0o644);

    await expect(
      loadOrCreateState(stateDir, platform === undefined ? {} : { platform }),
    ).rejects.toThrow('unsafe');
    expect(await readFile(join(stateDir, STATE_FILE), 'utf8')).toBe(contents);
  });

  it('never retries a rename failure', async () => {
    const { stateDir } = await temporaryStateDir();
    const created = await loadOrCreateState(stateDir, { platform: 'linux' });
    const renameImpl = vi.fn(async () => {
      throw systemError('EPERM');
    });
    const delay = vi.fn(async () => undefined);

    await expect(
      storeRuntimeToken(stateDir, created.instanceId, `ff_${'f'.repeat(64)}`, {
        platform: 'linux',
        rename: renameImpl,
        delay,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(renameImpl).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});

describe('win32 replacement retries', () => {
  async function seededState() {
    const { stateDir } = await temporaryStateDir();
    const created = await loadOrCreateState(stateDir, { platform: 'win32' });
    return { stateDir, created, token: `ff_${'a'.repeat(64)}` };
  }

  it.each(['EPERM', 'EBUSY'])('retries a %s rename failure with backoff and then succeeds', async (code) => {
    const { stateDir, created, token } = await seededState();
    let failures = 2;
    const renameImpl = vi.fn(async (from, to) => {
      if (failures > 0) {
        failures -= 1;
        throw systemError(code);
      }
      return rename(from, to);
    });
    const delay = vi.fn(async () => undefined);

    await storeRuntimeToken(stateDir, created.instanceId, token, { platform: 'win32', rename: renameImpl, delay });

    expect(renameImpl).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay.mock.calls[1][0]).toBeGreaterThan(delay.mock.calls[0][0]);
    expect(await loadOrCreateState(stateDir, { platform: 'win32' })).toEqual({ instanceId: created.instanceId, token });
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
  });

  it('gives up after five attempts, rethrows the last error and removes the temporary file', async () => {
    const { stateDir, created, token } = await seededState();
    const errors = [];
    const renameImpl = vi.fn(async () => {
      const error = systemError('EBUSY');
      errors.push(error);
      throw error;
    });
    const delay = vi.fn(async () => undefined);

    const failure = await storeRuntimeToken(stateDir, created.instanceId, token, {
      platform: 'win32',
      rename: renameImpl,
      delay,
    }).then(() => null, (error) => error);

    expect(failure).toBe(errors[4]);

    expect(renameImpl).toHaveBeenCalledTimes(5);
    expect(delay).toHaveBeenCalledTimes(4);
    for (const [milliseconds] of delay.mock.calls) {
      expect(milliseconds).toBeGreaterThan(0);
      expect(milliseconds).toBeLessThanOrEqual(1000);
    }
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
    expect(await loadOrCreateState(stateDir, { platform: 'win32' })).toEqual(created);
  });

  it('does not retry an error that is not a sharing failure', async () => {
    const { stateDir, created, token } = await seededState();
    const renameImpl = vi.fn(async () => {
      throw systemError('ENOSPC');
    });
    const delay = vi.fn(async () => undefined);

    await expect(
      storeRuntimeToken(stateDir, created.instanceId, token, { platform: 'win32', rename: renameImpl, delay }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(renameImpl).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
