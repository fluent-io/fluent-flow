import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Promisified execFile.
 */
function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

export class WorktreeRefUnavailableError extends Error {
  constructor(ref, message) {
    super(message);
    this.name = 'WorktreeRefUnavailableError';
    this.ref = ref;
  }
}

/**
 * Prepare a git worktree for a claim.
 * Clones the repo if not already cloned, fetches latest, creates a worktree on the PR branch.
 *
 * @param {object} opts
 * @param {string} opts.workDir — base working directory (cwd or --cwd flag)
 * @param {string} opts.repo — "owner/repo"
 * @param {number} opts.prNumber
 * @param {number} [opts.attempt]
 * @param {string} [opts.branch] — PR branch name
 * @param {number|string} [opts.claimId]
 * @param {string} [opts.name]
 * @param {string} [opts.ref]
 * @returns {Promise<{ worktreePath: string, cleanup: () => Promise<void> }>}
 */
export async function prepareWorktree({ workDir, repo, prNumber, attempt, branch, claimId, name, ref }) {
  const [owner, repoName] = repo.split('/');
  const baseDir = join(workDir, '.fluent-flow', 'repos', owner, repoName);
  const worktreeName = claimId != null
    ? `pr-${prNumber}-claim-${claimId}${name ? `-${name}` : ''}`
    : `pr-${prNumber}-attempt-${attempt}`;
  const worktreePath = join(baseDir, '.worktrees', worktreeName);
  const checkoutRef = ref ?? (branch ? `origin/${branch}` : undefined);

  // 1. Clone if base repo doesn't exist
  if (!existsSync(join(baseDir, '.git'))) {
    mkdirSync(baseDir, { recursive: true });

    // Build retry attempts: SSH first (if keys detected), then HTTPS+token, then plain HTTPS.
    const sshKeyExists =
      existsSync(join(homedir(), '.ssh', 'id_ed25519')) ||
      existsSync(join(homedir(), '.ssh', 'id_rsa')) ||
      !!process.env.SSH_AUTH_SOCK;

    const attempts = [];
    if (sshKeyExists) {
      attempts.push({
        authMethod: 'ssh',
        args: ['clone', `git@github.com:${repo}.git`, baseDir],
      });
    }
    // HTTPS with token via URL (x-access-token) — works in Docker/container environments
    // where http.extraHeader may not be passed through correctly by git.
    if (process.env.GITHUB_TOKEN) {
      attempts.push({
        authMethod: 'https-token',
        args: ['clone', `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo}.git`, baseDir],
      });
    }
    // Plain HTTPS fallback — always attempted last
    attempts.push({
      authMethod: 'https-plain',
      args: ['clone', `https://github.com/${repo}.git`, baseDir],
    });

    let lastError;
    let successfulAuth = null;
    for (const attempt of attempts) {
      try {
        await exec('git', attempt.args);
        successfulAuth = attempt.authMethod;
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        // Clean up partial clone so the next attempt starts fresh
        const parentDir = join(baseDir, '..');
        if (existsSync(baseDir)) {
          rmSync(baseDir, { recursive: true, force: true });
        }
        // Ensure parent directory still exists
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
      }
    }
    if (lastError) throw lastError;

    // Persist token auth for subsequent git operations (fetch, pull, etc.)
    if (successfulAuth === 'https-token' && process.env.GITHUB_TOKEN) {
      // Set the remote URL to include the token so fetch/pull work
      await exec('git', [
        'remote', 'set-url', 'origin',
        `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo}.git`,
      ], { cwd: baseDir });
    }
  }

  // 2. Fetch latest or explicit ref
  if (ref) {
    try {
      await exec('git', ['fetch', 'origin', ref], { cwd: baseDir });
    } catch (firstErr) {
      try {
        await exec('git', ['fetch', 'origin'], { cwd: baseDir });
        await exec('git', ['fetch', 'origin', ref], { cwd: baseDir });
      } catch {
        throw new WorktreeRefUnavailableError(
          ref,
          `Unable to resolve git ref "${ref}" after fetching origin for ${repo}`,
        );
      }
    }
  } else {
    await exec('git', ['fetch', 'origin'], { cwd: baseDir });
  }

  // 3. Create worktree
  mkdirSync(join(baseDir, '.worktrees'), { recursive: true });
  const worktreeArgs = ref
    ? ['worktree', 'add', '--detach', worktreePath, checkoutRef]
    : ['worktree', 'add', worktreePath, checkoutRef];
  await exec('git', worktreeArgs, { cwd: baseDir });

  // 4. Return path and cleanup function
  return {
    worktreePath,
    cleanup: async () => {
      try {
        await exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: baseDir });
      } catch {
        // Best effort — worktree may already be removed
      }
    },
  };
}
