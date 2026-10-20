import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitReader } from '../../../src/connector/workpad.js';

const execFile = promisify(execFileCb);

let tmp;
let repoDir;

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args]);
}

async function initRealRepo(withRemote = false) {
  repoDir = join(tmp, 'repo');
  mkdirSync(repoDir, { recursive: true });
  await git(repoDir, 'init', '-b', 'main');
  await git(repoDir, 'config', 'user.email', 'test@example.com');
  await git(repoDir, 'config', 'user.name', 'Test');
  writeFileSync(join(repoDir, 'README.md'), '# smoke\n');
  await git(repoDir, 'add', '.');
  await git(repoDir, 'commit', '-m', 'init');
  if (withRemote) {
    const remote = join(tmp, 'remote.git');
    await execFile('git', ['clone', '--bare', repoDir, remote]);
    await git(repoDir, 'remote', 'add', 'origin', remote);
    await git(repoDir, 'push', '-u', 'origin', 'main');
  }
  return repoDir;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ff-git-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('git reader against a REAL disposable repository', () => {
  it('counts unpushed commits on a branch with a remote that lacks them', async () => {
    const cwd = await initRealRepo(true);
    writeFileSync(join(cwd, 'feature.txt'), 'work');
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-m', 'local work only');
    const state = await createGitReader().state(cwd);
    expect(state.ok).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.uncommitted).toBe(0);
    expect(state.untracked).toBe(0);
    expect(state.unpushed).toBe(1);
    expect(state.upstream).toBe('origin/main');
  });

  it('counts upstream-behind commits as unpushed even when a LOCAL backup branch points at them', async () => {
    const cwd = await initRealRepo(true);
    // A local backup branch AT THE NEW COMMIT must NOT count as preservation.
    writeFileSync(join(cwd, 'feature.txt'), 'work');
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-m', 'local work only');
    await git(cwd, 'branch', 'backup', 'HEAD');
    const state = await createGitReader().state(cwd);
    expect(state.upstream).toBe('origin/main');
    expect(state.unpushed).toBe(1);
  });

  it('reports a missing upstream explicitly instead of pretending zero', async () => {
    const cwd = await initRealRepo(false);
    writeFileSync(join(cwd, 'orphan.txt'), 'work');
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-m', 'no upstream work');
    const state = await createGitReader().state(cwd);
    expect(state.ok).toBe(true);
    expect(state.upstream).toBeNull();
    // Unknown, never a clean zero — the wrap-up blocks on no_upstream.
    expect(state.unpushed).toBeNull();
  });

  it('separates uncommitted modifications from untracked files', async () => {
    const cwd = await initRealRepo(false);
    writeFileSync(join(cwd, 'README.md'), '# changed\n');
    writeFileSync(join(cwd, 'new.txt'), 'untracked\n');
    const state = await createGitReader().state(cwd);
    expect(state.uncommitted).toBe(1);
    expect(state.untracked).toBe(1);
  });

  it('reports unreadable directories as ok:false with a code only', async () => {
    const state = await createGitReader().state(join(tmp, 'not-a-repo'));
    expect(state.ok).toBe(false);
    expect(state.failCode).toBe('git_unreadable');
    expect(state.reason).toBeUndefined(); // raw git stderr stays local
  });
});
