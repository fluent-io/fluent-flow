import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { createGitReader } from './connector/workpad.js';

const sequence = z.string().regex(/^(?:0|[1-9]\d{0,18})$/u).refine((value) => value.length < 19 || value <= '9223372036854775807');
const workspaceState = z.object({ seq: sequence, state: z.enum(['known', 'not_repository', 'unavailable', 'unobserved']), headCommit: z.string().nullable(), dirty: z.boolean().nullable(), final: z.boolean(),
  repository: z.string().nullable(), taskBranch: z.string().nullable(), taskBranchHead: z.string().nullable() });

function resultValue(result) {
  if (result.isError) throw new Error('Workspace reporting is unavailable');
  const content = result.content?.find((item) => item.type === 'text');
  if (!content) throw new Error('Workspace reporting response is invalid');
  return JSON.parse(content.text);
}

function readGit(bin, args, options, environment, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: environment, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const output = [];
    let bytes = 0;
    let failure;
    const stop = (error) => {
      failure = failure ?? error;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch (killError) {
          if (killError?.code !== 'ESRCH') throw killError;
        }
      }
      child.stdout.destroy();
    };
    const abort = () => stop(new Error('Workspace Git read was aborted'));
    const timer = options.timeout > 0 ? setTimeout(() => stop(new Error('Workspace Git read timed out')), options.timeout) : null;
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? 1 << 20)) stop(new Error('Workspace Git output limit exceeded'));
      else output.push(chunk);
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 && !(code === 1 && options.allowMissing === true)) reject(new Error(`Workspace Git failed (${code ?? exitSignal})`));
      else resolve({ stdout: Buffer.concat(output, bytes).toString('utf8') });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createWorkspacePublisher({ config, getClient, requestOptions = undefined, signal = undefined }) {
  let cursor = null;
  let branch = null;
  const environment = Object.fromEntries(['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].flatMap((name) => typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
  const git = createGitReader({ io: { execFile: (bin, args, options) => readGit(bin, args, options, environment, signal) } });
  return {
    async publish({ final = false } = {}) {
      try {
        const client = await getClient();
        if (cursor === null) {
          const task = resultValue(await client.callTool({ name: 'collaboration_get_task', arguments: {} }, undefined, requestOptions));
          cursor = workspaceState.parse(task.workspace).seq;
          branch = z.object({ branch: z.string().nullable() }).parse(task.execution).branch;
        }
        const seq = sequence.parse((BigInt(cursor) + 1n).toString());
        const observed = await git.observe(config.workspace);
        const state = observed.ok ? 'known' : observed.failCode === 'not_repository' ? 'not_repository' : 'unavailable';
        const headCommit = observed.ok ? observed.headCommit : null;
        const dirty = observed.ok ? observed.dirty : null;
        let repository = null;
        let taskBranch = null;
        let taskBranchHead = null;
        if (observed.ok) {
          const options = { cwd: config.workspace, timeout: 10_000, maxBuffer: 65536 };
          const origin = await readGit('git', ['config', '--get-all', 'remote.origin.url'], { ...options, allowMissing: true }, environment, signal);
          const matched = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/iu.exec(origin.stdout.split('\n')[0].trim());
          repository = matched?.[1] ?? null;
          if (branch !== null) {
            const ref = `refs/remotes/origin/${branch}`;
            const refs = await readGit('git', ['for-each-ref', '--format=%(refname)%00%(objectname)', ref], options, environment, signal);
            for (const line of refs.stdout.trim().split('\n')) {
              const [name, sha] = line.split('\0');
              if (name === ref && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
                taskBranch = branch;
                taskBranchHead = sha;
                break;
              }
            }
          }
        }
        const material = JSON.stringify(['fluent-flow:workspace-observation:v1', config.bindingId, config.claimId, seq, state, headCommit, dirty, final, repository, taskBranch, taskBranchHead]);
        const hmac = createHmac('sha256', Buffer.from(config.captureKey, 'base64url')).update(material).digest('base64url');
        const proof = { version: 1, bindingId: config.bindingId, seq, state, headCommit, dirty, final, repository, taskBranch, taskBranchHead, hmac };
        const result = workspaceState.parse(resultValue(await client.callTool({ name: 'collaboration_report_workspace', arguments: {}, _meta: { 'fluent-flow/workspace-observation': proof } }, undefined, requestOptions)));
        if (result.seq !== seq) throw new Error('Workspace reporting response is invalid');
        cursor = result.seq;
        return result;
      } catch (error) {
        cursor = null;
        throw error;
      }
    },
  };
}
