import { it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
const exec = promisify(execFile);
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const taskId = '11111111-1111-4111-8111-111111111111';
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-workspace-')); roots.push(root);
  const remote = join(root, 'remote.git'); const seed = join(root, 'seed');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim();
  await exec('git', ['init', '--bare', remote]); await exec('git', ['clone', remote, seed]);
  await writeFile(join(seed, 'file'), 'initial'); await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'initial'); await git(seed, 'push', 'origin', 'HEAD');
  const { createChatWorkspaceManager } = await import('../../src/chat-workspace.js');
  const manager = createChatWorkspaceManager({ workDir: join(root, 'work'), remoteForRepo: () => remote });
  return { root, manager, git, work: { claim_id: 1, task_id: taskId, repo: 'org/repo' } };
}
it('checks out task branches, retains dirty work durably, resumes it in the next per-claim worktree', async () => {
  const h = await harness();
  const first = await h.manager.prepare(h.work);
  expect(await h.git(first.path, 'branch', '--show-current')).toBe(`ff/task-${taskId}`);
  await writeFile(join(first.path, 'unsaved'), 'valuable');
  expect(await first.release()).toMatchObject({ retained: true, reason: 'dirty' });
  await h.manager.reconcileStartup();
  expect(await readFile(join(first.path, 'unsaved'), 'utf8')).toBe('valuable');
  const second = await h.manager.prepare({ ...h.work, claim_id: 2 });
  expect(second.path).not.toBe(first.path);
  expect(await readFile(join(second.path, 'unsaved'), 'utf8')).toBe('valuable');
  const receipt = await second.release();
  expect(receipt).toMatchObject({ task_id: taskId, claim_id: 2, retained: true });
  await h.manager.discard({ taskId, claimId: 2, confirm: true });
  await expect(access(second.path)).rejects.toThrow();
});
it('waits for prior local release when a new claim resumes the same task immediately', async () => {
  const h = await harness(); const first = await h.manager.prepare(h.work);
  await writeFile(join(first.path, 'unsaved'), 'resume after cleanup');
  const pending = h.manager.prepare({ ...h.work, claim_id: 2 }).then((workspace) => ({ workspace }), (error) => ({ error }));
  await new Promise((r) => setTimeout(r, 10));
  await first.release();
  const result = await pending;
  expect(result.error).toBeUndefined();
  expect(await readFile(join(result.workspace.path, 'unsaved'), 'utf8')).toBe('resume after cleanup');
  await result.workspace.release();
});
it('prepares concurrent task chats in one repository without clone races or branch collisions', async () => {
  const h = await harness();
  const workspaces = await Promise.all([1, 2, 3].map((n) => h.manager.prepare({ ...h.work, task_id: `11111111-1111-4111-8111-11111111111${n}`, claim_id: n })));
  expect(new Set(workspaces.map((w) => w.path)).size).toBe(3);
  await Promise.all(workspaces.map((w) => w.release()));
});
it('persists a recovery receipt before any repository preparation can be interrupted', async () => {
  const h = await harness(); const { createChatWorkspaceManager } = await import('../../src/chat-workspace.js');
  let manager;
  manager = createChatWorkspaceManager({ workDir: join(h.root, 'other-work'), remoteForRepo: () => {
    if (!existsSync(join(manager.root, 'tasks', taskId, '1.json'))) throw new Error('Missing preparation recovery receipt');
    return join(h.root, 'remote.git');
  } });
  const prepared = await manager.prepare(h.work); await prepared.release();
});
it('retains ignored uncommitted content rather than treating it as disposable', async () => {
  const h = await harness(); const w = await h.manager.prepare(h.work);
  await writeFile(join(w.path, '.gitignore'), 'private-notes\n');
  await h.git(w.path, 'add', '.gitignore'); await h.git(w.path, 'commit', '-m', 'ignore local notes'); await h.git(w.path, 'push', 'origin', 'HEAD:refs/heads/task-test');
  await writeFile(join(w.path, 'private-notes'), 'valuable ignored work');
  expect(await w.release()).toMatchObject({ retained: true, reason: 'dirty' });
  expect(await readFile(join(w.path, 'private-notes'), 'utf8')).toBe('valuable ignored work');
});
it('refreshes remote reachability before treating a clean checkout as safely pushed', async () => {
  const h = await harness(); const w = await h.manager.prepare(h.work);
  const remote = join(h.root, 'remote.git');
  const head = await h.git(remote, 'symbolic-ref', 'HEAD');
  await h.git(remote, 'update-ref', '-d', head);
  expect(await w.release()).toMatchObject({ retained: true, reason: 'unpushed' });
});
it('retains unpushed commits but removes only clean work reachable on origin', async () => {
  const h = await harness(); const w = await h.manager.prepare(h.work);
  expect(await w.release()).toMatchObject({ retained: false });
  const next = await h.manager.prepare({ ...h.work, claim_id: 2 });
  await writeFile(join(next.path, 'new'), 'unpublished'); await h.git(next.path, 'add', '.'); await h.git(next.path, 'commit', '-m', 'unpublished');
  expect(await next.release()).toMatchObject({ retained: true, reason: 'unpushed' });
});
it('reconciles dead-process leases without deleting work, then resumes the retained task branch', async () => {
  const h = await harness(); const w = await h.manager.prepare(h.work);
  await writeFile(join(w.path, 'unsaved'), 'recover');
  const receiptPath = join(h.manager.root, 'tasks', taskId, '1.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, pid: 2147483647 }));
  await writeFile(join(h.manager.root, 'tasks', taskId, 'lease', 'pid'), '2147483647');
  await h.manager.reconcileStartup();
  expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ active: false, retained: true, reason: 'host_lost' });
  expect(await readFile(join(w.path, 'unsaved'), 'utf8')).toBe('recover');
  const next = await h.manager.prepare({ ...h.work, claim_id: 2 });
  expect(await readFile(join(next.path, 'unsaved'), 'utf8')).toBe('recover');
  await next.release();
});
it('explicit discard refuses a replaced scratch symlink and preserves its target', async () => {
  const h = await harness(); const w = await h.manager.prepare({ ...h.work, repo: null }); await w.release();
  const outside = join(h.root, 'valuable'); await mkdir(outside); await writeFile(join(outside, 'file'), 'keep');
  await rm(w.path, { recursive: true }); await symlink(outside, w.path);
  await expect(h.manager.discard({ taskId, claimId: 1, confirm: true })).rejects.toThrow(/symlink/);
  expect(await readFile(join(outside, 'file'), 'utf8')).toBe('keep');
});
it.each(['prepare', 'release', 'discard'])('refuses redirected scratch task ancestry during %s without touching outside data', async (operation) => {
  const h = await harness(); const w = await h.manager.prepare({ ...h.work, repo: null });
  if (operation !== 'release') await w.release();
  const parent = join(h.manager.scratch, taskId);
  await rename(parent, `${parent}-original`);
  const outside = join(h.root, 'outside'); await mkdir(join(outside, 'chat-1'), { recursive: true });
  await writeFile(join(outside, 'chat-1', 'valuable'), 'keep');
  await symlink(outside, parent);
  const action = operation === 'prepare' ? () => h.manager.prepare({ ...h.work, claim_id: 2, repo: null })
    : operation === 'release' ? () => w.release() : () => h.manager.discard({ taskId, claimId: 1, confirm: true });
  await expect(action()).rejects.toThrow(/symlink|containment|replaced/);
  expect(await readFile(join(outside, 'chat-1', 'valuable'), 'utf8')).toBe('keep');
  await expect(access(join(outside, 'chat-2'))).rejects.toThrow();
  const receipt = JSON.parse(await readFile(join(h.manager.root, 'tasks', taskId, '1.json'), 'utf8'));
  expect(receipt.active).toBe(false);
});
it('refuses a replaced real task parent rather than operating on another backing directory', async () => {
  const h = await harness(); const w = await h.manager.prepare({ ...h.work, repo: null }); await w.release();
  const parent = join(h.manager.scratch, taskId); await rename(parent, `${parent}-original`);
  await mkdir(join(parent, 'chat-1'), { recursive: true }); await writeFile(join(parent, 'chat-1', 'valuable'), 'keep');
  await expect(h.manager.discard({ taskId, claimId: 1, confirm: true })).rejects.toThrow(/replaced/);
  expect(await readFile(join(parent, 'chat-1', 'valuable'), 'utf8')).toBe('keep');
});
it('refuses a redirected storage root before preparing receipts or scratch', async () => {
  const h = await harness();
  const outside = join(h.root, 'outside-state'); await mkdir(outside);
  await symlink(outside, join(h.root, 'redirected-state'));
  const { createChatWorkspaceManager } = await import('../../src/chat-workspace.js');
  const manager = createChatWorkspaceManager({ workDir: join(h.root, 'other-work'), storageDir: join(h.root, 'redirected-state') });
  await expect(manager.prepare({ ...h.work, repo: null })).rejects.toThrow(/symlink/);
  await expect(access(join(outside, 'chat-workspaces'))).rejects.toThrow();
});
it('fails closed before creating leases on platforms without anchored removal support', async () => {
  const { createChatWorkspaceManager } = await import('../../src/chat-workspace.js');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    expect(() => createChatWorkspaceManager({ workDir: '/unused/work' })).toThrow(/platform/);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
it('repo-null scratch is outside the base work root and requires explicit local discard', async () => {
  const h = await harness(); const w = await h.manager.prepare({ ...h.work, repo: null });
  expect(relative(join(h.root, 'work'), w.path).startsWith('..')).toBe(true);
  await writeFile(join(w.path, 'notes'), 'keep');
  expect(await w.release()).toMatchObject({ retained: true, reason: 'scratch' });
  await h.manager.reconcileStartup();
  expect(await readFile(join(w.path, 'notes'), 'utf8')).toBe('keep');
  await expect(h.manager.discard({ taskId, claimId: 1, confirm: false })).rejects.toThrow();
  await h.manager.discard({ taskId, claimId: 1, confirm: true });
  await expect(access(w.path)).rejects.toThrow();
});
