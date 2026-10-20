import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Read-only git state association for workpad evidence and wrap-up preflight.
 * `unpushed` is the EXACT upstream-ahead count (`@{upstream}..HEAD`): work on
 * other LOCAL branches — even a backup branch pointing at the same commit — is
 * NOT preservation; only the upstream counts. `upstream` is null when no
 * upstream is configured, which the wrap-up treats as an explicit blocker
 * rather than a clean zero.
 *
 * Raw git stderr stays local (can contain paths); callers receive codes only.
 *
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
     * @returns {Promise<{ok:boolean, branch?:string, headCommit?:string, upstream?:string|null,
     *   uncommitted?:number, untracked?:number, unpushed?:number, failCode?:string}>}
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
          // Exact upstream-ahead count. Work on other LOCAL branches — even a
          // backup branch pointing at the same commit — is not preservation;
          // only the upstream counts. Without an upstream the count is UNKNOWN
          // (null), never a clean zero: the wrap-up blocks on upstream === null.
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
