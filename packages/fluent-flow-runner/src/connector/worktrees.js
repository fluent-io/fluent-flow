import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensurePrivateDir } from '../supervisor/owner-lock.js';
import { createGitReader } from './workpad.js';

const execFile = promisify(execFileCb);


export class WorktreeConflict extends Error {
  /**
   * @param {string} reason - protected detail for host logs
   * @param {{ cause?: unknown, uncertain?: boolean }} [options] - `uncertain` when a create_worktree barrier for this run exists without a resolution: the run's worktree effect is unknown (reconciling), not a definite refusal
   */
  constructor(reason, { uncertain = false, ...options } = {}) {
    super(`Run worktree conflict: ${reason}`, options);
    this.name = 'WorktreeConflict';
    this.code = 'worktree_conflict';
    this.reason = reason;
    this.uncertain = uncertain;
  }
}

const GIT_TIMEOUT_MS = 30_000;
const git = async (cwd, args) => (await execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 << 20 })).stdout;

export function runWorkspaceRef(runId) {
  return `ffw_${createHash('sha256').update(`ff:worktree:${runId}`).digest('hex').slice(0, 16)}`;
}

async function branchExists(repoPath, branchName) {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch (err) {
    if (err.code === 1) return false;
    throw err;
  }
}

async function registeredWorktrees(repoPath) {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
}

async function adoptionProblem({ repoPath, directory, branchName }) {
  let st;
  try {
    st = lstatSync(directory);
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) return 'not_owned_directory';
  if (!(await registeredWorktrees(repoPath)).includes(directory)) return 'not_a_worktree_of_repository';
  let head;
  try {
    head = (await git(directory, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
  } catch (err) {
    return err.code === 1 ? 'branch_mismatch' : 'git_unreadable';
  }
  if (head !== `refs/heads/${branchName}`) return 'branch_mismatch';
  const status = await git(directory, ['status', '--porcelain', '--untracked-files=all']);
  if (status.trim() !== '') return 'dirty';
  return null;
}

/**
 * @param {{ repoPath: string, root: string, runId: string, sessionId: string, branchName?: string, baseRef: string, effects: { prior: () => ({ workspaceRef: string, branchName: string } | null), barrier: (ref: object) => Promise<void> } }} opts
 * @returns {Promise<{ workspaceRef: string, directory: string }>}
 */
export async function ensureRunWorktree({ repoPath, root, runId, sessionId, branchName, baseRef, effects }) {
  const branch = branchName ?? `ff/${runId}/${sessionId}`;
  if (typeof baseRef !== 'string' || baseRef === '' || baseRef.startsWith('-')) throw new WorktreeConflict('invalid_base_ref');
  try {
    await execFile('git', ['check-ref-format', '--branch', branch], { timeout: GIT_TIMEOUT_MS });
  } catch (err) {
    throw new WorktreeConflict('invalid_branch_name', { cause: err });
  }
  const repo = realpathSync(repoPath);
  ensurePrivateDir(root);
  const workspaceRef = runWorkspaceRef(runId);
  const directory = join(realpathSync(root), workspaceRef);
  const prior = effects.prior();
  const recordedHere = prior !== null && prior.workspaceRef === workspaceRef && prior.branchName === branch;
  if (prior !== null && !recordedHere) throw new WorktreeConflict('recorded_worktree_mismatch', { uncertain: true });

  const problem = await adoptionProblem({ repoPath: repo, directory, branchName: branch });
  if (problem === null) {
    if (!recordedHere) throw new WorktreeConflict('unrecorded_worktree');
    return { workspaceRef, directory };
  }
  if (problem !== 'missing') throw new WorktreeConflict(problem, { uncertain: recordedHere });
  if (recordedHere) throw new WorktreeConflict('recorded_worktree_missing', { uncertain: true });
  if (await branchExists(repo, branch)) throw new WorktreeConflict('branch_exists');
  if ((await registeredWorktrees(repo)).includes(directory)) throw new WorktreeConflict('registered_worktree_missing');
  const upstream = await authorizedUpstream({ repoPath: repo, branchName: branch });
  await effects.barrier({ workspaceRef, branchName: branch, upstream });
  await git(repo, ['worktree', 'add', '--quiet', '-b', branch, directory, baseRef]);
  return { workspaceRef, directory };
}

async function configValue(cwd, key) {
  try {
    return (await git(cwd, ['config', '--get', key])).trim() || null;
  } catch (err) {
    if (err.code === 1) return null;
    throw err;
  }
}

async function configValues(cwd, key) {
  try {
    return (await git(cwd, ['config', '--get-all', key])).split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 1) return [];
    throw err;
  }
}

function mapRefspec(spec, ref) {
  const body = spec.startsWith('+') ? spec.slice(1) : spec;
  const negative = body.startsWith('^');
  const colon = body.indexOf(':');
  const qualify = (name) => (name.startsWith('refs/') ? name : `refs/heads/${name}`);
  const src = qualify(negative ? body.slice(1) : colon === -1 ? body : body.slice(0, colon));
  const dst = colon === -1 || negative ? src : qualify(body.slice(colon + 1));
  const star = src.indexOf('*');
  let middle = null;
  if (star === -1) {
    if (src !== ref) return null;
  } else {
    const pre = src.slice(0, star);
    const post = src.slice(star + 1);
    if (!ref.startsWith(pre) || !ref.endsWith(post) || ref.length < pre.length + post.length) return null;
    middle = ref.slice(pre.length, ref.length - post.length);
  }
  if (negative) return { negative: true };
  return { dst: middle === null ? dst : dst.replace('*', middle) };
}

function mapThrough(specs, ref) {
  const mapped = new Set();
  for (const spec of specs) {
    const m = mapRefspec(spec, ref);
    if (m?.negative) return null;
    if (m) mapped.add(m.dst);
  }
  return mapped.size === 1 ? [...mapped][0] : null;
}

const gitBytes = async (cwd, args) => (await execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: 'buffer' })).stdout;

async function configCount(cwd, key) {
  try {
    const out = await gitBytes(cwd, ['config', '--null', '--get-all', key]);
    return out.reduce((n, byte) => n + (byte === 0 ? 1 : 0), 0);
  } catch (err) {
    if (err.code === 1) return 0;
    throw err;
  }
}

/**
 * @returns {Promise<Buffer | null>}
 */
async function singlePushUrl(cwd, remote) {
  const out = await gitBytes(cwd, ['remote', 'get-url', '--push', '--all', remote]);
  if (out.length === 0 || out[out.length - 1] !== 0x0a) return null;
  const records = [];
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 0x0a) {
      records.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  const configured = (await configCount(cwd, `remote.${remote}.pushurl`)) || (await configCount(cwd, `remote.${remote}.url`));
  if (records.length !== (configured || 1) || records.some((r) => r.length === 0)) return null;
  const distinct = new Map(records.map((r) => [r.toString('hex'), r]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {{ repoPath: string, branchName: string }} opts
 * @returns {Promise<{ remote: string, destination: string, trackingRef: string, pushUrlSha256: string } | null>}
 */
export async function authorizedUpstream({ repoPath, branchName }) {
  const remotes = (await git(repoPath, ['remote'])).split('\n').filter(Boolean);
  const remote = (await configValue(repoPath, `branch.${branchName}.pushRemote`)) ?? (await configValue(repoPath, 'remote.pushDefault')) ??
    (await configValue(repoPath, `branch.${branchName}.remote`)) ?? (remotes.length === 1 ? remotes[0] : null);
  if (remote === null || remote === '.' || !remotes.includes(remote)) return null;
  const pushSpecs = await configValues(repoPath, `remote.${remote}.push`);
  const ref = `refs/heads/${branchName}`;
  const destination = pushSpecs.length ? mapThrough(pushSpecs, ref) : ref;
  if (destination === null || !destination.startsWith('refs/heads/')) return null;
  const trackingRef = mapThrough(await configValues(repoPath, `remote.${remote}.fetch`), destination);
  if (trackingRef === null || !trackingRef.startsWith('refs/remotes/')) return null;
  const pushUrl = await singlePushUrl(repoPath, remote);
  if (pushUrl === null) return null;
  return { remote, destination, trackingRef, pushUrlSha256: sha256(pushUrl) };
}

/**
 * @param {{ directory: string, branchName: string, headCommit: string, expected: any }} opts
 * @returns {Promise<{ problem: string | null, count?: number, upstream?: string }>}
 */
export async function upstreamProblem({ directory, branchName, headCommit, expected }) {
  if (!expected || typeof expected !== 'object' || typeof expected.remote !== 'string' || typeof expected.trackingRef !== 'string') return { problem: 'upstream_unverified' };
  const remote = await configValue(directory, `branch.${branchName}.remote`);
  const merge = await configValue(directory, `branch.${branchName}.merge`);
  if (remote === null && merge === null) return { problem: 'no_upstream' };
  if (remote !== expected.remote || merge !== expected.destination) return { problem: 'upstream_mismatch' };
  const remotes = (await git(directory, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.includes(remote)) return { problem: 'upstream_mismatch' };
  const pushUrl = await singlePushUrl(directory, remote);
  if (pushUrl === null || sha256(pushUrl) !== expected.pushUrlSha256) return { problem: 'upstream_mismatch' };
  const pushSpecs = await configValues(directory, `remote.${remote}.push`);
  if ((pushSpecs.length ? mapThrough(pushSpecs, `refs/heads/${branchName}`) : `refs/heads/${branchName}`) !== expected.destination) return { problem: 'upstream_mismatch' };
  const tracked = mapThrough(await configValues(directory, `remote.${remote}.fetch`), expected.destination);
  if (tracked !== expected.trackingRef) return { problem: 'upstream_mismatch' };
  try {
    await git(directory, ['rev-parse', '--verify', '--quiet', `${expected.trackingRef}^{commit}`]);
  } catch (err) {
    if (err.code === 1) return { problem: 'no_upstream' };
    throw err;
  }
  const ahead = Number.parseInt((await git(directory, ['rev-list', '--count', `${expected.trackingRef}..${headCommit}`])).trim(), 10);
  if (!Number.isSafeInteger(ahead)) throw new Error('Unreadable ahead count');
  if (ahead > 0) return { problem: 'unpushed_commits', count: ahead };
  return { problem: null, upstream: expected.trackingRef.slice('refs/remotes/'.length) };
}

/**
 * @returns {Promise<{ blockers: Array<{ code: string, count?: number }>, git: Record<string, unknown> }>}
 */
export async function worktreeGitCheck({ directory, branchName, expectedUpstream }) {
  const state = await createGitReader().state(directory);
  if (!state.ok) return { blockers: [{ code: 'git_unreadable' }], git: { ok: false, failCode: 'git_unreadable' } };
  /** @type {Array<{ code: string, count?: number }>} */
  const blockers = [];
  if (state.uncommitted > 0) blockers.push({ code: 'uncommitted_changes', count: state.uncommitted });
  if (state.untracked > 0) blockers.push({ code: 'untracked_files', count: state.untracked });
  const up = await upstreamProblem({ directory, branchName, headCommit: state.headCommit, expected: expectedUpstream });
  if (up.problem) blockers.push(up.count ? { code: up.problem, count: up.count } : { code: up.problem });
  const git = { ok: true, branch: state.branch, headCommit: state.headCommit, upstream: up.upstream ?? null, uncommitted: state.uncommitted, untracked: state.untracked, unpushed: up.problem === 'unpushed_commits' ? up.count : up.problem ? null : 0 };
  return { blockers, git };
}

/**
 * @param {{ repoPath: string, directory: string, branchName: string }} opts
 */
export async function ownedWorktreeProblem({ repoPath, directory, branchName }) {
  return adoptionProblem({ repoPath: realpathSync(repoPath), directory, branchName });
}

export async function missingWorktreeEvidence({ repoPath, directory, branchName }) {
  const listed = (await git(repoPath, ['worktree', 'list', '--porcelain'])).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  let branchHead = null;
  try {
    branchHead = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`])).trim() || null;
  } catch (err) {
    if (err?.code !== 1) throw err;
    branchHead = null;
  }
  return { worktreeRegistered: listed.includes(directory), branchHead };
}

/**
 * @param {{ repoPath: string, directory: string, expectedBranch: string, expectedUpstream: any }} opts
 * @returns {Promise<{ ok: boolean, blockers: Array<{ code: string, count?: number }>, git?: object }>}
 */
export async function archiveRunWorktree({ repoPath, directory, expectedBranch, expectedUpstream }) {
  const repo = realpathSync(repoPath);
  const problem = await adoptionProblem({ repoPath: repo, directory, branchName: expectedBranch });
  if (problem && problem !== 'dirty') return { ok: false, blockers: [{ code: problem }] };
  const { blockers, git: sample } = await worktreeGitCheck({ directory, branchName: expectedBranch, expectedUpstream });
  if (blockers.length) return { ok: false, blockers };
  await git(repo, ['worktree', 'remove', directory]);
  return { ok: true, blockers: [], git: sample };
}
