import { describe, it, expect } from 'vitest';
import { worktreeUsers } from '../../../src/supervisor/supervisor.js';

const DIR = '/state/worktrees/ffw_0123456789abcdef';
const UID = 1000;
const err = (code) => Object.assign(new Error(code), { code });

function fakeProc(processes) {
  const gone = new Set();
  const op = (pid, name) => {
    const p = processes[pid];
    if (!p || gone.has(pid)) throw err('ENOENT');
    if (p.goneAfter?.has(name)) gone.add(pid);
    if (p.deny?.has(name)) throw err('EACCES');
    return p;
  };
  return {
    async readdir(path) {
      if (path === '/proc') return [...Object.keys(processes), 'self', 'sys'];
      const [, , pid, leaf] = path.split('/');
      if (leaf !== 'fd') throw err('ENOENT');
      return Object.keys(op(pid, 'fd').fds ?? {});
    },
    async stat(path) {
      const [, , pid] = path.split('/');
      return { uid: op(pid, 'stat').uid };
    },
    async readlink(path) {
      const [, , pid, leaf, n] = path.split('/');
      if (leaf === 'cwd') return op(pid, 'cwd').cwd;
      const p = op(pid, `fd/${n}`);
      if (!(n in (p.fds ?? {}))) throw err('ENOENT');
      return p.fds[n];
    },
  };
}

const scan = (processes, extra = {}) => worktreeUsers({ directory: DIR, procRoot: '/proc', selfPid: 1, uid: UID, fsp: fakeProc(processes), ...extra });

describe('worktreeUsers (Task 8 C2)', () => {
  it('finds a same-uid process whose cwd or an open fd is inside the worktree, and excludes the supervisor itself', async () => {
    expect(await scan({
      1: { uid: UID, cwd: DIR },
      10: { uid: UID, cwd: `${DIR}/src` },
      11: { uid: UID, cwd: '/home/u', fds: { 3: `${DIR}/notes.txt` } },
      12: { uid: UID, cwd: '/home/u', fds: { 3: `${DIR}-other/x` } },
    })).toEqual({ users: [10, 11], unverifiable: 0 });
  });

  it.each([
    ['its cwd', { deny: new Set(['cwd']) }],
    ['its fd directory', { deny: new Set(['fd']) }],
    ['one fd', { fds: { 3: '/tmp/x', 4: '/tmp/y' }, deny: new Set(['fd/4']) }],
    ['its ownership', { deny: new Set(['stat']) }],
  ])('a live process whose %s cannot be read is unverifiable, never absent', async (_name, state) => {
    expect(await scan({ 20: { uid: UID, cwd: '/home/u', fds: {}, ...state } })).toEqual({ users: [], unverifiable: 1 });
  });

  it('a process that is gone is skipped, also when the read that failed was a permission error during its exit', async () => {
    expect(await scan({
      30: { uid: UID, cwd: '/home/u', goneAfter: new Set(['stat']) },
      31: { uid: UID, cwd: '/home/u', deny: new Set(['cwd']), goneAfter: new Set(['cwd']) },
    })).toEqual({ users: [], unverifiable: 0 });
  });

  it('an fd closed between listing and reading is skipped while the process stays verifiable', async () => {
    const processes = { 40: { uid: UID, cwd: '/home/u', fds: { 3: '/tmp/x' } } };
    const fsp = fakeProc(processes);
    const listing = fsp.readdir;
    fsp.readdir = async (path) => (path.endsWith('/fd') ? ['3', '9'] : listing(path));
    expect(await worktreeUsers({ directory: DIR, procRoot: '/proc', selfPid: 1, uid: UID, fsp })).toEqual({ users: [], unverifiable: 0 });
  });

  it('another uid is excluded once its ownership is read, whatever else about it is unreadable', async () => {
    expect(await scan({ 50: { uid: 0, cwd: DIR, deny: new Set(['cwd', 'fd']) } })).toEqual({ users: [], unverifiable: 0 });
  });
});
