import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * @param {{io?: {execFile?: Function}, timeoutMs?: number}} [opts]
 */
export function createGitReader({ io = {}, timeoutMs = 10_000 } = {}) {
  const exec = io.execFile ?? execFile;
  const git = async (cwd, args) => {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return stdout;
  };

  return {
    /**
     * @param {string} cwd - repository/worktree directory
     * @returns {Promise<{ok:boolean, branch?:string, headCommit?:string, upstream?:string|null, uncommitted?:number, untracked?:number, unpushed?:number, failCode?:string}>}
     */
    async state(cwd) {
      try {
        const branchOut = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const branch = branchOut.trim();
        const upstreamOut = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
        const upstream = upstreamOut.trim() || null;
        const [head, status, unpushedOut] = await Promise.all([
          git(cwd, ['rev-parse', 'HEAD']),
          git(cwd, ['status', '--porcelain']),
          upstream ? git(cwd, ['rev-list', '--count', `${upstream}..HEAD`]) : Promise.resolve('null'),
        ]);
        const lines = status.split('\n').filter((line) => line.trim());
        return {
          ok: true,
          branch,
          headCommit: head.trim(),
          upstream,
          uncommitted: lines.filter((l) => !l.startsWith('??')).length,
          untracked: lines.filter((l) => l.startsWith('??')).length,
          unpushed: unpushedOut.trim() === 'null' ? null : Number.parseInt(unpushedOut.trim(), 10) || 0,
        };
      } catch {
        return { ok: false, failCode: 'git_unreadable' };
      }
    },
  };
}
