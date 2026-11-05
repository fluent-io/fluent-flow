import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureRunWorktree, archiveRunWorktree, authorizedUpstream, runWorkspaceRef } from '../../../src/connector/worktrees.js';

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd, ...args) => {
  if (typeof cwd !== 'string' || !roots.some((r) => cwd.startsWith(`${r}/`))) throw new Error(`refusing git outside the test root: ${JSON.stringify(cwd)}`);
  return gitIn(cwd, ...args);
};
const gitIn = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-worktrees-')));
  roots.push(base);
  const repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  return { base, repo, root: join(stateDir, 'worktrees') };
}

function recordingEffects(prior = null) {
  const calls = [];
  let recorded = prior;
  return {
    calls,
    effects: {
      prior: () => recorded,
      barrier: async (ref) => {
        if (recorded) throw new Error('create_worktree barrier repeated');
        calls.push({ effect: 'create_worktree', ref });
        recorded = ref;
      },
    },
  };
}

const RUN = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const BRANCH = `ff/${RUN}/${SESSION}`;

describe('run worktrees (Task 7)', () => {
  it('creates ff/<run>/<session> from baseRef', async () => {
    const { repo, root } = setup();
    const baseCommit = git(repo, 'rev-parse', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'later');
    const { calls, effects } = recordingEffects();
    const result = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: baseCommit, effects });
    expect(result.workspaceRef).toBe(runWorkspaceRef(RUN));
    expect(result.workspaceRef).toMatch(/^ffw_[0-9a-f]{16}$/);
    expect(result.directory).toBe(join(root, result.workspaceRef));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(git(result.directory, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
    expect(git(result.directory, 'rev-parse', 'HEAD')).toBe(baseCommit);
    expect(calls).toEqual([{ effect: 'create_worktree', ref: { workspaceRef: result.workspaceRef, branchName: BRANCH, upstream: expect.objectContaining({ remote: 'origin' }) } }]);
  });

  it('records the barrier before git worktree add', async () => {
    const { repo, root } = setup();
    let existedAtBarrier = null;
    const ref = runWorkspaceRef(RUN);
    await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: {
      prior: () => null,
      barrier: async () => { existedAtBarrier = existsSync(join(root, ref)); },
    } });
    expect(existedAtBarrier).toBe(false);
    const other = '33333333-3333-4333-8333-333333333333';
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: other, sessionId: SESSION, branchName: `ff/${other}/${SESSION}`, baseRef: 'main', effects: {
      prior: () => null, barrier: async () => { throw Object.assign(new Error('fsync failed'), { code: 'EIO' }); },
    } })).rejects.toMatchObject({ code: 'EIO' });
    expect(existsSync(join(root, runWorkspaceRef(other)))).toBe(false);
    expect(git(repo, 'branch', '--list', `ff/${other}/*`)).toBe('');
  });

  it('reuses an owned clean worktree', async () => {
    const { repo, root } = setup();
    const { effects, calls } = recordingEffects();
    const first = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    const second = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: 'another-session', branchName: BRANCH, baseRef: 'main', effects });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('a dirty or foreign path fails worktree_conflict untouched', async () => {
    const { base, repo, root } = setup();
    const ref = runWorkspaceRef(RUN);
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(root, ref));
    writeFileSync(join(root, ref, 'user-file.txt'), 'keep me');
    const unrecorded = recordingEffects();
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: unrecorded.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
    expect(readdirSync(join(root, ref))).toEqual(['user-file.txt']);
    expect(unrecorded.calls).toEqual([]);
    rmSync(join(root, ref), { recursive: true });

    const owned = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: owned.effects });
    writeFileSync(join(directory, 'scratch.txt'), 'uncommitted');
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: owned.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
    expect(readdirSync(directory).sort()).toEqual(['.git', 'README.md', 'scratch.txt']);

    const other = join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
    const run2 = '44444444-4444-4444-8444-444444444444';
    const ref2 = runWorkspaceRef(run2);
    git(other, 'worktree', 'add', '-q', '-b', `ff/${run2}/${SESSION}`, join(root, ref2), 'main');
    const foreign = recordingEffects({ workspaceRef: ref2, branchName: `ff/${run2}/${SESSION}` });
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: run2, sessionId: SESSION, branchName: `ff/${run2}/${SESSION}`, baseRef: 'main', effects: foreign.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
    expect(git(join(root, ref2), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`ff/${run2}/${SESSION}`);

    const run3 = '55555555-5555-4555-8555-555555555555';
    git(repo, 'branch', `ff/${run3}/${SESSION}`, 'main');
    const branchClash = recordingEffects();
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: run3, sessionId: SESSION, branchName: `ff/${run3}/${SESSION}`, baseRef: 'main', effects: branchClash.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
    expect(branchClash.calls).toEqual([]);
    expect(existsSync(join(root, runWorkspaceRef(run3)))).toBe(false);
  });

  it('a clean worktree that matches path, repository and branch but was never recorded is not adopted', async () => {
    const { repo, root } = setup();
    mkdirSync(root, { mode: 0o700 });
    const target = join(root, runWorkspaceRef(RUN));
    git(repo, 'worktree', 'add', '-q', '-b', BRANCH, target, 'main');
    const unrecorded = recordingEffects();
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: unrecorded.effects })).rejects.toMatchObject({ code: 'worktree_conflict', uncertain: false, reason: 'unrecorded_worktree' });
    expect(unrecorded.calls).toEqual([]);
    expect(readdirSync(target).sort()).toEqual(['.git', 'README.md']);
  });

  it('a create_worktree barrier without bind adopts only a clean matching worktree', async () => {
    const { repo, root } = setup();
    const first = recordingEffects();
    const created = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: first.effects });
    const afterCrash = recordingEffects(first.calls[0].ref);
    expect(await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: afterCrash.effects })).toEqual(created);
    expect(afterCrash.calls).toEqual([]);
    git(created.directory, 'checkout', '-q', '-b', 'elsewhere');
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: afterCrash.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
    expect(git(created.directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('elsewhere');
    const mismatched = recordingEffects({ workspaceRef: 'ffw_0000000000000000', branchName: BRANCH });
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: mismatched.effects })).rejects.toMatchObject({ code: 'worktree_conflict' });
  });

  it('a recorded create_worktree barrier whose worktree is missing stays uncertain: no second git worktree add', async () => {
    const { repo, root } = setup();
    const ref = runWorkspaceRef(RUN);
    const crashed = recordingEffects({ workspaceRef: ref, branchName: BRANCH });
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: crashed.effects })).rejects.toMatchObject({ code: 'worktree_conflict', uncertain: true, reason: 'recorded_worktree_missing' });
    expect(crashed.calls).toEqual([]);
    expect(existsSync(join(root, ref))).toBe(false);
    expect(git(repo, 'branch', '--list', BRANCH)).toBe('');
    const owned = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: owned.effects });
    writeFileSync(join(directory, 'scratch.txt'), 'uncommitted');
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects: owned.effects })).rejects.toMatchObject({ code: 'worktree_conflict', uncertain: true, reason: 'dirty' });
    const run2 = '66666666-6666-4666-8666-666666666666';
    mkdirSync(join(root, runWorkspaceRef(run2)));
    await expect(ensureRunWorktree({ repoPath: repo, root, runId: run2, sessionId: SESSION, branchName: `ff/${run2}/${SESSION}`, baseRef: 'main', effects: recordingEffects().effects })).rejects.toMatchObject({ code: 'worktree_conflict', uncertain: false });
  });

  it('archive never forces and refuses dirty or unpushed work', async () => {
    const { repo, root } = setup();
    const { calls, effects } = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    const expectedUpstream = calls[0].ref.upstream;
    expect((await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream })).blockers.map((b) => b.code)).toEqual(['no_upstream']);
    git(directory, 'push', '-q', '-u', 'origin', BRANCH);
    writeFileSync(join(directory, 'work.txt'), 'new');
    let result = await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(['untracked_files']);
    git(directory, 'add', '.');
    git(directory, 'commit', '-q', '-m', 'work');
    result = await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream });
    expect(result.blockers).toEqual([{ code: 'unpushed_commits', count: 1 }]);
    expect(existsSync(directory)).toBe(true);
    expect((await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: 'ff/other', expectedUpstream })).blockers.map((b) => b.code)).toContain('branch_mismatch');
    git(directory, 'push', '-q');
    result = await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream });
    expect(result).toMatchObject({ ok: true, blockers: [], git: { ok: true, upstream: `origin/${BRANCH}`, unpushed: 0 } });
    expect(existsSync(directory)).toBe(false);
    expect(git(repo, 'branch', '--list', BRANCH)).toContain(BRANCH);
  });
});

describe('authorized push target (Task 8 fix 1)', () => {
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const bare = (base, name) => {
    const path = join(base, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', path]);
    return path;
  };

  it('is frozen into the create_worktree barrier from the source repository before the worktree exists', async () => {
    const { base, repo, root } = setup();
    const { calls, effects } = recordingEffects();
    await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    expect(calls).toEqual([{ effect: 'create_worktree', ref: { workspaceRef: runWorkspaceRef(RUN), branchName: BRANCH,
      upstream: { remote: 'origin', destination: `refs/heads/${BRANCH}`, trackingRef: `refs/remotes/origin/${BRANCH}`, pushUrlSha256: sha(join(base, 'remote.git')) } } }]);
  });

  it('follows the source configuration: branch pushRemote, then remote.pushDefault, then a single remote; push refspecs define the destination', async () => {
    const { base, repo } = setup();
    const mirror = bare(base, 'mirror');
    git(repo, 'remote', 'add', 'mirror', mirror);
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toBeNull();
    git(repo, 'config', 'remote.pushDefault', 'mirror');
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toEqual({ remote: 'mirror', destination: `refs/heads/${BRANCH}`, trackingRef: `refs/remotes/mirror/${BRANCH}`, pushUrlSha256: sha(mirror) });
    git(repo, 'config', `branch.${BRANCH}.pushRemote`, 'origin');
    expect((await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).remote).toBe('origin');
    git(repo, 'config', '--unset', `branch.${BRANCH}.pushRemote`);
    git(repo, 'config', 'remote.mirror.push', 'refs/heads/*:refs/heads/review/*');
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toMatchObject({ destination: `refs/heads/review/${BRANCH}`, trackingRef: `refs/remotes/mirror/review/${BRANCH}` });
    git(repo, 'config', '--replace-all', 'remote.mirror.push', 'refs/heads/main:refs/heads/main');
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.mirror.push');
    git(repo, 'config', 'remote.mirror.pushurl', join(base, 'remote.git'));
    expect((await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).pushUrlSha256).toBe(sha(join(base, 'remote.git')));
    git(repo, 'config', 'remote.pushDefault', 'missing');
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toBeNull();
  });

  it('a repository without remotes has no authority', async () => {
    const { repo } = setup();
    git(repo, 'remote', 'remove', 'origin');
    expect(await authorizedUpstream({ repoPath: repo, branchName: BRANCH })).toBeNull();
  });

  it('the final archive check refuses a local backup, another remote, another ref, a changed push identity and a missing expectation, and returns the final sample it validated', async () => {
    const { base, repo, root } = setup();
    const { calls, effects } = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    const expectedUpstream = calls[0].ref.upstream;
    const archive = (expected = expectedUpstream) => archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream: expected });
    const codes = async (expected) => (await archive(expected)).blockers.map((b) => b.code);
    git(repo, 'branch', 'backup', BRANCH);
    git(directory, 'branch', '-q', '-u', 'backup', BRANCH);
    expect(await codes()).toEqual(['upstream_mismatch']);
    const mirror = bare(base, 'mirror');
    git(repo, 'remote', 'add', 'mirror', mirror);
    git(directory, 'push', '-q', '-u', 'mirror', BRANCH);
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(directory, 'push', '-q', '-u', 'origin', `${BRANCH}:refs/heads/elsewhere`);
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(directory, 'push', '-q', '-u', 'origin', BRANCH);
    git(repo, 'remote', 'set-url', 'origin', mirror);
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(repo, 'remote', 'set-url', 'origin', join(base, 'remote.git'));
    expect(await codes(null)).toEqual(['upstream_unverified']);
    expect((await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH })).blockers.map((b) => b.code)).toEqual(['upstream_unverified']);
    expect(existsSync(directory)).toBe(true);
    const head = git(directory, 'rev-parse', 'HEAD');
    const result = await archive();
    expect(result).toEqual({ ok: true, blockers: [], git: { ok: true, branch: BRANCH, headCommit: head, upstream: `origin/${BRANCH}`, uncommitted: 0, untracked: 0, unpushed: 0 } });
    expect(existsSync(directory)).toBe(false);
    expect(git(repo, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(head);
  });

  it('several applicable push or fetch mappings with distinct results, or several distinct push URLs, are no authority; exact duplicates collapse (Task 8 fix 2)', async () => {
    const { base, repo } = setup();
    const authority = () => authorizedUpstream({ repoPath: repo, branchName: BRANCH });
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/first`);
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/second`);
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.push');
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
    git(repo, 'config', '--add', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
    expect(await authority()).toMatchObject({ destination: `refs/heads/${BRANCH}` });
    git(repo, 'config', '--unset-all', 'remote.origin.push');
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
    git(repo, 'config', '--add', 'remote.origin.push', 'refs/heads/*:refs/heads/review/*');
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.push');
    git(repo, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/other/*');
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.fetch', 'other');
    expect(await authority()).toMatchObject({ trackingRef: `refs/remotes/origin/${BRANCH}` });
    const second = bare(base, 'second');
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', second);
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    expect(await authority()).toMatchObject({ remote: 'origin', pushUrlSha256: sha(join(base, 'remote.git')) });
  });

  it('a push URL added or replaced after the freeze, or a second fetch or push mapping, refuses the final archive check (Task 8 fix 2)', async () => {
    const { base, repo, root } = setup();
    const { calls, effects } = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    const expectedUpstream = calls[0].ref.upstream;
    expect(expectedUpstream).toMatchObject({ remote: 'origin' });
    git(directory, 'push', '-q', '-u', 'origin', BRANCH);
    const codes = async () => (await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream })).blockers.map((b) => b.code);
    const second = bare(base, 'second');
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', second);
    expect(await codes()).toEqual(['upstream_mismatch']);
    const third = bare(base, 'third');
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', third);
    expect(git(repo, 'remote', 'get-url', '--push', '--all', 'origin').split('\n')).toEqual([join(base, 'remote.git'), third]);
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/${BRANCH}`);
    git(repo, 'config', '--add', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/elsewhere`);
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(repo, 'config', '--unset-all', 'remote.origin.push');
    git(repo, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/other/*');
    expect(await codes()).toEqual(['upstream_mismatch']);
    git(repo, 'config', '--unset-all', 'remote.origin.fetch', 'other');
    expect(existsSync(directory)).toBe(true);
    expect(await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream })).toMatchObject({ ok: true, git: { upstream: `origin/${BRANCH}` } });
    expect(existsSync(directory)).toBe(false);
  });

  it('push URL identity is byte-exact: whitespace-distinct destinations are distinct, a unique whitespace-bearing URL and a byte-identical repeat are one target (Task 8 fix 3)', async () => {
    const { base, repo } = setup();
    const authority = () => authorizedUpstream({ repoPath: repo, branchName: BRANCH });
    const plain = join(base, 'remote.git');
    const spaced = `${plain} `;
    execFileSync('git', ['init', '-q', '--bare', spaced]);
    const leading = join(base, ' lead.git');
    execFileSync('git', ['init', '-q', '--bare', leading]);
    git(repo, 'config', '--add', 'remote.origin.pushurl', plain);
    git(repo, 'config', '--add', 'remote.origin.pushurl', spaced);
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', spaced);
    expect(await authority()).toMatchObject({ remote: 'origin', pushUrlSha256: sha(spaced) });
    expect(sha(spaced)).not.toBe(sha(plain));
    git(repo, 'config', '--add', 'remote.origin.pushurl', spaced);
    expect(await authority()).toMatchObject({ pushUrlSha256: sha(spaced) });
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', leading);
    expect(await authority()).toMatchObject({ pushUrlSha256: sha(leading) });
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', `${plain}\n${spaced}`);
    expect(await authority()).toBeNull();
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', `${plain}\n${plain}`);
    expect(git(repo, 'remote', 'get-url', '--push', '--all', 'origin').split('\n')).toEqual([plain, plain]);
    expect(await authority()).toBeNull();
  });

  it('a whitespace-distinct push URL added after the freeze refuses the final archive check (Task 8 fix 3)', async () => {
    const { base, repo, root } = setup();
    const { calls, effects } = recordingEffects();
    const { directory } = await ensureRunWorktree({ repoPath: repo, root, runId: RUN, sessionId: SESSION, branchName: BRANCH, baseRef: 'main', effects });
    const expectedUpstream = calls[0].ref.upstream;
    expect(expectedUpstream.pushUrlSha256).toBe(sha(join(base, 'remote.git')));
    git(directory, 'push', '-q', '-u', 'origin', BRANCH);
    const spaced = `${join(base, 'remote.git')} `;
    execFileSync('git', ['init', '-q', '--bare', spaced]);
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', spaced);
    expect((await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream })).blockers.map((b) => b.code)).toEqual(['upstream_mismatch']);
    expect(existsSync(directory)).toBe(true);
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    git(repo, 'config', '--add', 'remote.origin.pushurl', join(base, 'remote.git'));
    expect(await archiveRunWorktree({ repoPath: repo, directory, expectedBranch: BRANCH, expectedUpstream })).toMatchObject({ ok: true });
  });
});
