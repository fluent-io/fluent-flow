import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeExecutables } from '../../src/probe.js';

let root;
let binDir;
let otherDir;

async function probe(options) {
  return probeExecutables(options);
}

async function install(directory, name, mode) {
  const path = join(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, mode);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fluent-flow-probe-'));
  binDir = join(root, 'bin');
  otherDir = join(root, 'other-bin');
  await Promise.all([mkdir(binDir), mkdir(otherDir)]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('executable probe with win32 lookup rules', () => {
  it('finds a tool through a mixed-case Path key and the PATHEXT extensions', async () => {
    await install(binDir, 'git.CMD', 0o755);
    await install(binDir, 'gh.EXE', 0o755);

    await probe({
      platform: 'win32',
      names: ['git', 'gh'],
      environment: { Path: binDir, PathExt: '.COM;.EXE;.BAT;.CMD' },
    });
  });

  it('falls back to the default executable extensions when PATHEXT is absent', async () => {
    await install(binDir, 'git.EXE', 0o755);

    await probe({ platform: 'win32', names: ['git'], environment: { Path: binDir } });
  });

  it('reports a tool whose extension is not listed in PATHEXT as missing', async () => {
    await install(binDir, 'git.CMD', 0o755);

    await expect(probe({
      platform: 'win32',
      names: ['git'],
      environment: { Path: binDir, PATHEXT: '.EXE' },
    })).rejects.toThrow(/git/u);
  });

  it('does not apply Windows extensions or key casing to another platform', async () => {
    await install(binDir, 'git.CMD', 0o755);

    await expect(probe({
      platform: 'linux',
      names: ['git'],
      environment: { Path: binDir, PATHEXT: '.CMD' },
    })).rejects.toThrow(/git/u);
  });

  it('defaults to the host platform', async () => {
    await install(binDir, 'git', 0o755);

    await probe({ names: ['git'], environment: { PATH: binDir, Path: binDir } });
  });
});

describe.skipIf(process.platform === 'win32')('executable probe', () => {
  it('accepts executables found on the child environment PATH', async () => {
    await install(binDir, 'git', 0o755);
    await install(otherDir, 'gh', 0o755);

    await probe({
      names: ['git', 'gh'],
      environment: { PATH: [binDir, otherDir].join(delimiter) },
    });
  });

  it('resolves names against the supplied environment rather than the process PATH', async () => {
    await expect(probe({
      names: ['node'],
      environment: { PATH: binDir },
    })).rejects.toThrow();
  });

  it('reports a file without execute permission as missing', async () => {
    await install(binDir, 'gh', 0o644);

    await expect(probe({
      names: ['gh'],
      environment: { PATH: binDir },
    })).rejects.toThrow(/gh/u);
  });

  it('accepts an absolute executable path without consulting PATH', async () => {
    const absolute = await install(binDir, 'custom-adapter', 0o755);

    await probe({ names: [absolute], environment: { PATH: '' } });
  });

  it('reports an absolute path that is not executable or does not exist', async () => {
    const notExecutable = await install(binDir, 'plain-file', 0o644);
    const absent = join(binDir, 'absent-adapter');

    await expect(probe({ names: [notExecutable], environment: { PATH: binDir } })).rejects.toThrow(notExecutable);
    await expect(probe({ names: [absent], environment: { PATH: binDir } })).rejects.toThrow(absent);
  });

  it('throws a generic Error naming only the missing tools', async () => {
    await install(binDir, 'present-tool-xyz', 0o755);
    const environment = { PATH: binDir, GH_TOKEN: 'ff_probe_secret_value' };
    let caught;

    try {
      await probe({ names: ['present-tool-xyz', 'missing-tool-abc', 'missing-tool-def'], environment });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('missing-tool-abc');
    expect(caught.message).toContain('missing-tool-def');
    expect(caught.message).not.toContain('present-tool-xyz');
    expect(caught.message).not.toContain(binDir);
    expect(caught.message).not.toContain('ff_probe_secret_value');
  });

  it('reports every name as missing when PATH is empty', async () => {
    await expect(probe({
      names: ['node', 'sh'],
      environment: { PATH: '' },
    })).rejects.toThrow(/node.*sh|sh.*node/su);
  });

  it('reports every name as missing when the environment has no PATH', async () => {
    await expect(probe({
      names: ['node'],
      environment: {},
    })).rejects.toThrow(/node/u);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'continues past a PATH entry whose stat is denied and finds the tool in a later entry',
    async () => {
      const locked = join(root, 'locked-bin');
      await mkdir(locked);
      await install(locked, 'git', 0o755);
      await install(otherDir, 'git', 0o755);
      await chmod(locked, 0o000);

      try {
        await probe({ names: ['git'], environment: { PATH: [locked, otherDir].join(delimiter) } });
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'still throws the generic missing-names error when an unsearchable entry precedes the end of PATH',
    async () => {
      const locked = join(root, 'locked-bin');
      await mkdir(locked);
      await chmod(locked, 0o000);
      let caught;

      try {
        await probe({ names: ['absent-tool-xyz'], environment: { PATH: [locked, otherDir].join(delimiter) } });
      } catch (error) {
        caught = error;
      } finally {
        await chmod(locked, 0o700);
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('Required tools are missing: absent-tool-xyz');
      expect(caught.code).toBeUndefined();
    },
  );

  it('continues past a PATH entry that is a symlink loop', async () => {
    const loopA = join(root, 'loop-a');
    const loopB = join(root, 'loop-b');
    await symlink(loopB, loopA);
    await symlink(loopA, loopB);
    await install(otherDir, 'git', 0o755);

    await probe({ names: ['git'], environment: { PATH: [loopA, otherDir].join(delimiter) } });
  });

  it('continues past an overlong PATH entry', async () => {
    const overlong = join(root, 'a'.repeat(5000));
    await install(otherDir, 'git', 0o755);

    await probe({ names: ['git'], environment: { PATH: [overlong, otherDir].join(delimiter) } });
  });
});
