import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withClaimGitHubToken } from './environment.js';
import { safeError } from './safe-error.js';

const STALE_WORKTREE_NAME = /^claim-\d+(?:-[A-Za-z0-9._-]+)?$/u;

const repositoryLocks = new Map();

function exec(cmd, args, opts) {
  return new Promise((resolvePromise, reject) => {
    execFileCb(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function withRepositoryLock(key, operation) {
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release;
  const released = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = previous.catch(() => undefined).then(() => released);
  repositoryLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (repositoryLocks.get(key) === tail) repositoryLocks.delete(key);
  }
}

function safePathComponent(value, label) {
  if (
    (typeof value !== 'string' && !Number.isSafeInteger(value))
    || !/^[A-Za-z0-9._-]+$/u.test(String(value))
    || value === '.'
    || value === '..'
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return String(value);
}

function safeClaimId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Unsafe claim ID: ${value}`);
  }
  return String(value);
}

function parseRepository(repo) {
  if (typeof repo !== 'string') throw new Error(`Unsafe repository: ${repo}`);
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(repo);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error(`Unsafe repository: ${repo}`);
  }
  return { owner: match[1], repoName: match[2] };
}

function isMissingRefError(err) {
  const text = `${err?.message ?? ''} ${err?.stderr ?? ''}`.toLowerCase();
  return (
    text.includes('missing ref')
    || text.includes('couldn\'t find remote ref')
    || text.includes('could not find remote ref')
    || text.includes('unknown revision')
    || text.includes('no such ref')
    || text.includes('refspec')
    || text.includes('remote ref')
  );
}

function isAlreadyAbsentWorktreeError(err) {
  const text = `${err?.message ?? ''} ${err?.stderr ?? ''}`.toLowerCase();
  return text.includes('not a working tree') || text.includes('is not a working tree');
}

function refUnavailableError(ref, repo) {
  return new WorktreeRefUnavailableError(
    ref,
    `Unable to resolve git ref "${ref}" after fetching origin for ${repo}`,
  );
}

export class WorktreeRefUnavailableError extends Error {
  constructor(ref, message) {
    super(message);
    this.name = 'WorktreeRefUnavailableError';
    this.ref = ref;
  }
}

export async function prepareWorktree({
  workDir,
  repo,
  branch,
  claimId,
  name,
  ref,
  environment,
  githubToken,
}) {
  const { owner, repoName } = parseRepository(repo);
  const safeClaim = safeClaimId(claimId);
  if (name != null && typeof name !== 'string') throw new Error(`Unsafe worktree name: ${name}`);
  const safeName = name == null ? null : safePathComponent(name, 'worktree name');
  const baseDir = join(workDir, '.fluent-flow', 'repos', owner, repoName);
  const repositoryKey = resolve(baseDir);
  const worktreeName = `claim-${safeClaim}${safeName ? `-${safeName}` : ''}`;
  const worktreePath = join(baseDir, '.worktrees', worktreeName);
  const cleanRemote = `https://github.com/${owner}/${repoName}.git`;
  const claimEnvironment = withClaimGitHubToken(environment ?? {}, githubToken);

  await withRepositoryLock(repositoryKey, async () => {
    let checkoutRef = ref ?? (branch ? `origin/${branch}` : undefined);
    if (!existsSync(join(baseDir, '.git'))) {
      mkdirSync(baseDir, { recursive: true });
      try {
        await exec('git', ['clone', cleanRemote, baseDir], { env: claimEnvironment });
      } catch (error) {
        if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
        throw error;
      }
    }
    const { stdout: originOutput } = await exec(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: baseDir, env: claimEnvironment },
    );
    const originUrl = originOutput.trim();
    if (originUrl !== cleanRemote) {
      await exec(
        'git',
        ['remote', 'set-url', 'origin', cleanRemote],
        { cwd: baseDir, env: claimEnvironment },
      );
    }

    if (ref) {
      try {
        await exec('git', ['fetch', 'origin', ref], { cwd: baseDir, env: claimEnvironment });
      } catch (explicitError) {
        if (!isMissingRefError(explicitError)) throw explicitError;
        await exec('git', ['fetch', 'origin'], { cwd: baseDir, env: claimEnvironment });
        try {
          await exec('git', ['fetch', 'origin', ref], { cwd: baseDir, env: claimEnvironment });
        } catch (retryError) {
          if (isMissingRefError(retryError)) throw refUnavailableError(ref, repo);
          throw retryError;
        }
      }
      try {
        const { stdout } = await exec(
          'git',
          ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
          { cwd: baseDir, env: claimEnvironment },
        );
        checkoutRef = stdout.trim();
        if (!checkoutRef) throw refUnavailableError(ref, repo);
      } catch (error) {
        if (error instanceof WorktreeRefUnavailableError) throw error;
        throw refUnavailableError(ref, repo);
      }
    } else {
      await exec('git', ['fetch', 'origin'], { cwd: baseDir, env: claimEnvironment });
    }

    mkdirSync(join(baseDir, '.worktrees'), { recursive: true });
    const worktreeArgs = ref
      ? ['worktree', 'add', '--detach', worktreePath, checkoutRef]
      : ['worktree', 'add', worktreePath, checkoutRef];
    await exec('git', worktreeArgs, { cwd: baseDir, env: claimEnvironment });
  });

  return {
    worktreePath,
    cleanup: () => withRepositoryLock(repositoryKey, async () => {
      try {
        await exec(
          'git',
          ['worktree', 'remove', worktreePath, '--force'],
          { cwd: baseDir, env: claimEnvironment },
        );
      } catch (error) {
        if (!isAlreadyAbsentWorktreeError(error)) throw error;
      }
    }),
  };
}

async function readDirectoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function listBaseRepositories(repositoriesRoot, log) {
  const repositories = [];
  let failed = 0;
  for (const owner of await readDirectoryEntries(repositoriesRoot)) {
    if (!owner.isDirectory()) continue;
    const ownerDirectory = join(repositoriesRoot, owner.name);
    let entries;
    try {
      entries = await readDirectoryEntries(ownerDirectory);
    } catch (error) {
      failed += 1;
      log.warn('Stale worktree cleanup failed', {
        event: 'stale_worktree_cleanup_failed',
        repo: owner.name,
        reason: safeError(error),
      });
      continue;
    }
    for (const entry of entries) {
      const base = join(ownerDirectory, entry.name);
      if (entry.isDirectory() && existsSync(join(base, '.git'))) {
        repositories.push({ repo: `${owner.name}/${entry.name}`, base });
      }
    }
  }
  return { repositories, failed };
}

export async function cleanStaleWorktrees({ workDir, environment, log }) {
  const gitEnvironment = withClaimGitHubToken(environment ?? {}, undefined);
  const { repositories, failed: unlistable } = await listBaseRepositories(
    join(workDir, '.fluent-flow', 'repos'),
    log,
  );

  const results = await Promise.all(repositories.map(({ repo, base }) => withRepositoryLock(resolve(base), async () => {
    let removed = 0;
    try {
      const worktreesDirectory = join(base, '.worktrees');
      for (const entry of await readDirectoryEntries(worktreesDirectory)) {
        if (!entry.isDirectory() || !STALE_WORKTREE_NAME.test(entry.name)) continue;
        await rm(join(worktreesDirectory, entry.name), { recursive: true, force: true });
        removed += 1;
      }
      await exec('git', ['worktree', 'prune'], { cwd: base, env: gitEnvironment });
      return { removed, failed: 0 };
    } catch (error) {
      log.warn('Stale worktree cleanup failed', {
        event: 'stale_worktree_cleanup_failed',
        repo,
        reason: safeError(error),
      });
      return { removed, failed: 1 };
    }
  })));

  log.info('Stale worktrees cleaned', {
    event: 'stale_worktrees_cleaned',
    repositories: repositories.length,
    removed: results.reduce((total, result) => total + result.removed, 0),
    failed: unlistable + results.reduce((total, result) => total + result.failed, 0),
  });
}
