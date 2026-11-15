import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, readdir, rm, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { withClaimGitHubToken } from './environment.js';
import { withRepositoryLock } from './worktree.js';

const exec = promisify(execFile);
const localTaskLeases = new Map();
const identity = z.object({ task_id: z.uuid(), claim_id: z.number().int().positive(), repo: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/u).nullable() });
const receiptSchema = identity.extend({ active: z.boolean(), retained: z.boolean(), reason: z.string(), pid: z.number().int(), updated_at: z.string() });
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function createChatWorkspaceManager({ workDir, storageDir = undefined, environment = {}, remoteForRepo = (repo) => `https://github.com/${repo}.git` }) {
  if (process.platform !== 'linux') throw new Error('Safe chat storage is unavailable on this platform');
  const root = storageDir ? resolve(storageDir, 'chat-workspaces') : resolve(dirname(workDir), `${basename(workDir)}-chat`);
  const scratch = storageDir ? resolve(storageDir, 'chat-scratch') : resolve(dirname(workDir), `${basename(workDir)}-chat-scratch`);
  for (const directory of [root, scratch]) {
    const path = relative(resolve(workDir), directory);
    if (!(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))) throw new Error('Chat storage must be outside the work root');
  }
  const directoryIdentities = new Map();
  const signature = (stat) => `${stat.dev}:${stat.ino}`;
  async function inspect(path, create = false) {
    const absolute = resolve(path);
    const parts = absolute.split(sep).filter(Boolean);
    let current = resolve(sep);
    for (let i = 0; i < parts.length; i += 1) {
      current = join(current, parts[i]);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (directoryIdentities.has(current)) throw new Error('Chat storage directory replaced');
        if (!create) return false;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = await lstat(current);
      }
      if (stat.isSymbolicLink()) throw new Error('Chat workspace symlink rejected');
      if (i < parts.length - 1 || create) {
        if (!stat.isDirectory()) throw new Error('Chat storage ancestor is not a directory');
      }
      if (stat.isDirectory()) {
        const prior = directoryIdentities.get(current);
        if (prior && prior !== signature(stat)) throw new Error('Chat storage directory replaced');
        directoryIdentities.set(current, signature(stat));
      }
    }
    return true;
  }
  const exists = (path) => inspect(path);
  const directories = (path) => inspect(path, true);
  function forget(path) {
    for (const key of directoryIdentities.keys()) if (key === path || key.startsWith(`${path}${sep}`)) directoryIdentities.delete(key);
  }
  async function remove(path) {
    await exists(path);
    if (process.platform !== 'linux') throw new Error('Safe chat discard is unavailable on this platform');
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (signature(await parent.stat()) !== directoryIdentities.get(dirname(path))) throw new Error('Chat storage directory replaced');
      await exists(path);
      await rm(`/proc/self/fd/${parent.fd}/${basename(path)}`, { recursive: true });
      forget(path);
    } finally { await parent.close(); }
  }
  const taskRoot = (taskId) => join(root, 'tasks', taskId);
  const receiptPath = (taskId, claimId) => join(taskRoot(taskId), `${claimId}.json`);
  const workspacePath = (row) => row.repo == null ? join(scratch, row.task_id, `chat-${row.claim_id}`) : join(taskRoot(row.task_id), `chat-${row.claim_id}`);
  const git = async (cwd, args, env = withClaimGitHubToken(environment)) => {
    await exists(cwd);
    for (const arg of args) if (isAbsolute(arg) && (arg.startsWith(`${root}${sep}`) || arg.startsWith(`${scratch}${sep}`))) await exists(arg);
    return (await exec('git', args, { cwd, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  };
  async function record(row) {
    await directories(taskRoot(row.task_id));
    const path = receiptPath(row.task_id, row.claim_id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...row, updated_at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    await directories(taskRoot(row.task_id));
    await rename(temporary, path);
  }
  async function receipts(taskId) {
    await directories(taskRoot(taskId));
    const rows = [];
    for (const entry of await readdir(taskRoot(taskId))) {
      if (!/^\d+\.json$/u.test(entry)) continue;
      const path = join(taskRoot(taskId), entry);
      await exists(path);
      const row = receiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (row.task_id !== taskId || entry !== `${row.claim_id}.json`) throw new Error('Chat receipt identity mismatch');
      rows.push(row);
    }
    return rows;
  }
  async function lock(taskId) {
    const key = taskRoot(taskId);
    const previous = localTaskLeases.get(key) ?? Promise.resolve();
    let releaseLocal;
    const released = new Promise((resolve) => { releaseLocal = resolve; });
    const tail = previous.then(() => released);
    localTaskLeases.set(key, tail);
    await previous;
    const freeLocal = () => { releaseLocal(); if (localTaskLeases.get(key) === tail) localTaskLeases.delete(key); };
    try {
      await directories(key);
      const path = join(key, 'lease');
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600 });
      await exists(path);
      return async () => { try { await remove(path); } finally { freeLocal(); } };
    } catch (error) { freeLocal(); throw error; }
  }
  async function prepare(work) {
    const row = { ...identity.parse(work), active: true, retained: true, reason: 'active', pid: process.pid };
    const unlock = await lock(row.task_id);
    const path = workspacePath(row);
    try {
      if (await exists(path)) throw new Error('Chat claim workspace already exists');
      await record(row);
      if (row.repo == null) await directories(path);
      else {
        const base = join(root, 'repos', ...row.repo.split('/'));
        const env = withClaimGitHubToken(environment, work.githubToken);
        const branch = `ff/task-${row.task_id}`;
        await withRepositoryLock(base, async () => {
        await directories(dirname(base));
        if (!await exists(base)) await git(dirname(base), ['clone', '--no-checkout', remoteForRepo(row.repo), base], env);
        await exists(base);
        const retained = (await receipts(row.task_id)).filter((r) => r.claim_id !== row.claim_id && r.repo === row.repo && r.retained);
        if (retained.some((r) => r.active)) throw new Error('Chat task workspace is still active');
        const previous = retained.sort((a, b) => b.claim_id - a.claim_id)[0];
        if (previous && await exists(workspacePath(previous))) {
          await git(base, ['worktree', 'move', workspacePath(previous), path], env);
          forget(workspacePath(previous));
          await record({ ...previous, retained: false, reason: 'resumed' });
        } else {
          await git(base, ['fetch', 'origin'], env);
          const branches = await git(base, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], env);
          await git(base, branches ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'origin/HEAD'], env);
        }
        });
      }
      await exists(path);
      await record(row);
    } catch (error) {
      try { await record({ ...row, active: false, reason: 'preparation_failed' }); }
      finally { await unlock(); }
      throw error;
    }
    let releasePromise;
    return { path, handoff: async () => {
      if (row.repo == null || releasePromise) throw new Error('Handoff requires an open repository session');
      await exists(path);
      const branch = `ff/task-${row.task_id}`;
      if (await git(path, ['branch', '--show-current']) !== branch) throw Object.assign(new Error('Return to the task branch before handoff'), { handoffCode: 'task_branch_required' });
      if (await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])) {
        throw Object.assign(new Error('Commit session changes before handoff'), { handoffCode: 'commit_required' });
      }
      const headSha = await git(path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const remote = await git(path, ['ls-remote', 'origin', `refs/heads/${branch}`], withClaimGitHubToken(environment, work.githubToken));
      if (remote.split(/\s/u)[0] !== headSha) throw Object.assign(new Error('Push the task branch before handoff'), { handoffCode: 'push_required' });
      return { branch, headSha };
    }, release: () => {
      releasePromise ??= (async () => {
        let result = { ...row, active: false, retained: true, reason: row.repo == null ? 'scratch' : 'inspection_failed' };
        try {
          await exists(path);
          if (row.repo != null) {
            const base = join(root, 'repos', ...row.repo.split('/'));
            await withRepositoryLock(base, async () => {
            await exists(path);
            const dirty = await git(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
            if (dirty) result.reason = 'dirty';
            else {
              await git(base, ['fetch', '--prune', 'origin'], withClaimGitHubToken(environment, work.githubToken));
              const pushed = await git(path, ['for-each-ref', '--format=%(refname)', '--contains=HEAD', 'refs/remotes/origin/']);
              if (!pushed) result.reason = 'unpushed';
              else {
                await git(base, ['worktree', 'remove', path]);
                forget(path);
                result = { ...result, retained: false, reason: 'clean_pushed' };
              }
            }
            });
          }
          await record(result);
          return result;
        } catch (error) { await record(result); throw error; }
        finally { await unlock(); }
      })();
      return releasePromise;
    } };
  }
  async function reconcileStartup() {
    await directories(join(root, 'tasks'));
    for (const taskId of await readdir(join(root, 'tasks'))) {
      if (!z.uuid().safeParse(taskId).success) continue;
      await exists(taskRoot(taskId));
      const rows = await receipts(taskId);
      for (const row of rows) {
        if (row.active && !alive(row.pid)) await record({ ...row, active: false, retained: true, reason: 'host_lost' });
      }
      const lease = join(taskRoot(taskId), 'lease');
      if (await exists(lease)) {
        const pid = Number(await readFile(join(lease, 'pid'), 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid chat workspace lease');
        if (!alive(pid)) {
          await remove(lease);
          localTaskLeases.delete(taskRoot(taskId));
        }
      }
    }
  }
  async function discard({ taskId, claimId, confirm }) {
    z.uuid().parse(taskId); z.number().int().positive().parse(claimId);
    if (confirm !== true) throw new Error('Explicit discard confirmation required');
    const unlock = await lock(taskId);
    try {
      const row = (await receipts(taskId)).find((r) => r.claim_id === claimId);
      if (!row || row.active || !row.retained) throw new Error('No inactive retained workspace');
      const path = workspacePath(row); await exists(path);
      if (row.repo == null) await remove(path);
      else {
        await git(join(root, 'repos', ...row.repo.split('/')), ['worktree', 'remove', '--force', path]);
        forget(path);
      }
      await record({ ...row, retained: false, reason: 'explicit_discard' });
    } finally { await unlock(); }
  }
  return { prepare, reconcileStartup, discard, root, scratch };
}
