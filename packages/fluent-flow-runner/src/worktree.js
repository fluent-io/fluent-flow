import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

/**
 * Prepare a git worktree for a claim.
 * Clones the repo if not already cloned, fetches latest, creates a worktree on the PR branch.
 *
 * @param {object} opts
 * @param {string} opts.workDir — base working directory (cwd or --cwd flag)
 * @param {string} opts.repo — "owner/repo"
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {string} opts.branch — PR branch name
 * @returns {Promise<{ worktreePath: string, cleanup: () => Promise<void> }>}
 */
export async function prepareWorktree({ workDir, repo, prNumber, attempt, branch }) {
  const [owner, name] = repo.split('/');
  const baseDir = join(workDir, '.fluent-flow', 'repos', owner, name);
  const worktreeName = `pr-${prNumber}-attempt-${attempt}`;
  const worktreePath = join(baseDir, '.worktrees', worktreeName);

  // 1. Clone if base repo doesn't exist
  if (!existsSync(join(baseDir, '.git'))) {
    mkdirSync(baseDir, { recursive: true });
    await exec('git', ['clone', `https://github.com/${repo}.git`, baseDir]);
  }

  // 2. Fetch latest
  await exec('git', ['fetch', 'origin'], { cwd: baseDir });

  // 3. Create worktree
  mkdirSync(join(baseDir, '.worktrees'), { recursive: true });
  await exec('git', ['worktree', 'add', worktreePath, `origin/${branch}`], { cwd: baseDir });

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
