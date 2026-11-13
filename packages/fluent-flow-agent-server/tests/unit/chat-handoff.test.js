import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAcpRuntime } from '../../src/acp/runtime.js';
import { runChatSession } from '../../src/chat-loop.js';
import { fileURLToPath } from 'node:url';
import { createChatWorkspaceManager } from '../../src/chat-workspace.js';
import { prepareWorktree } from '../../src/worktree.js';

const exec = promisify(execFile);
const cleanups = [];
const taskId = '11111111-1111-4111-8111-111111111111';
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-handoff-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: environment })).stdout.trim();
  await git(root, 'init', '--bare', remote);
  await git(root, 'clone', remote, seed);
  await writeFile(join(seed, 'design.md'), 'Accepted design');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'design');
  await git(seed, 'push', 'origin', 'HEAD');
  const manager = createChatWorkspaceManager({ workDir: join(root, 'work'), environment, remoteForRepo: () => remote });
  const prepared = await manager.prepare({ task_id: taskId, claim_id: 1, repo: 'org/repo' });
  cleanups.push(() => prepared.release());
  return { prepared, git, remote };
}

it('hands off a clean published task branch without ending the attended workspace', async () => {
  const { prepared, git } = await workspace();
  await git(prepared.path, 'push', 'origin', `HEAD:refs/heads/ff/task-${taskId}`);
  const headSha = await git(prepared.path, 'rev-parse', 'HEAD');
  expect(await prepared.handoff()).toEqual({ branch: `ff/task-${taskId}`, headSha });
  expect(await readFile(join(prepared.path, 'design.md'), 'utf8')).toBe('Accepted design');
  await writeFile(join(prepared.path, 'next-design.md'), 'Chat continues');
  expect(await prepared.release()).toMatchObject({ retained: true, reason: 'dirty' });
});

it('refuses dirty or unpublished work rather than giving unattended execution an incomplete snapshot', async () => {
  const { prepared, git } = await workspace();
  await git(prepared.path, 'push', 'origin', `HEAD:refs/heads/ff/task-${taskId}`);
  await writeFile(join(prepared.path, 'design.md'), 'Uncommitted decision');
  await expect(prepared.handoff()).rejects.toThrow(/commit/i);
  expect(await readFile(join(prepared.path, 'design.md'), 'utf8')).toBe('Uncommitted decision');
  await git(prepared.path, 'add', '.');
  await git(prepared.path, 'commit', '-m', 'unpublished design');
  await expect(prepared.handoff()).rejects.toThrow(/push/i);
  await git(prepared.path, 'push', 'origin', `HEAD:refs/heads/ff/task-${taskId}`);
  expect((await prepared.handoff()).headSha).toBe(await git(prepared.path, 'rev-parse', 'HEAD'));
});

it('requires the actual task branch rather than any pushed branch', async () => {
  const { prepared, git } = await workspace();
  await git(prepared.path, 'switch', '-c', 'unrelated');
  await git(prepared.path, 'push', 'origin', 'HEAD:refs/heads/unrelated');
  await expect(prepared.handoff()).rejects.toThrow(/task branch/i);
});

it('generates a bounded handoff digest in the current ACP context and keeps that session open', async () => {
  const { prepared, git } = await workspace();
  await git(prepared.path, 'push', 'origin', `HEAD:refs/heads/ff/task-${taskId}`);
  let text = '';
  const bridge = {
    resetAgentMessageText: () => { text = ''; },
    agentMessageText: () => text,
    finalizeEvents: async () => {},
  };
  const runtime = createAcpRuntime({
    cwd: prepared.path, env: { PATH: process.env.PATH },
    command: { bin: process.execPath, args: [fileURLToPath(new URL('./fake-acp-agent.js', import.meta.url)), '--scenario', 'handoff-summary'] },
    onEvent: async event => { if (event.update.sessionUpdate === 'agent_message_chunk') text += event.update.content.text; },
    limits: { requestTimeoutMs: 1000, silenceMs: 100, shutdownIdleMs: 100, shutdownExitMs: 100, shutdownKillMs: 100 },
  });
  cleanups.push(() => runtime.close());
  const commands = [{ id: 1, kind: 'handoff', payload: {} }];
  const acks = [];
  let stage = 0;
  const client = {
    renewClaimCommand: async () => ({ renewed: true }),
    ackClaimCommand: async (_session, _claim, id, status, result) => { acks.push({ id, status, result }); },
    pollClaimCommands: async () => {
      if (acks.some(ack => ack.id === 1) && stage === 0) {
        stage = 1;
        commands.push({ id: 2, kind: 'prompt', payload: { text: 'Keep designing' } });
      }
      if (acks.some(ack => ack.id === 2) && stage === 1) {
        stage = 2;
        commands.push({ id: 3, kind: 'end_session', payload: {} });
      }
      return { commands: commands.splice(0) };
    },
  };
  const outcome = await runChatSession({ runtime, client, sessionId: 1, claimId: 1, repo: 'org/repo',
    githubTokenExpiresAt: new Date(Date.now() + 60000).toISOString(), commandPollMs: 5,
    handoff: async onAccepted => {
      const { prepareChatHandoff } = await import('../../src/chat-handoff.js');
      return prepareChatHandoff({ runtime, workspace: prepared, bridge, onAccepted });
    } });
  expect(acks[0]).toMatchObject({ id: 1, status: 'acked', result: {
    digest: { goal: 'Build the agreed feature', acceptanceCriteria: ['Feature works'] },
    branch: `ff/task-${taskId}`, headSha: await git(prepared.path, 'rev-parse', 'HEAD'),
  } });
  expect(acks.find(ack => ack.id === 2).status).toBe('acked');
  expect(outcome).toEqual({ status: 'cancelled', end_reason: 'user' });
});

it('starts task work on a new branch and gives the next claim the published spec from a fresh checkout', async () => {
  const { remote, git } = await workspace();
  const workDir = join(dirname(remote), 'unattended');
  const base = join(workDir, '.fluent-flow', 'repos', 'org', 'repo');
  await mkdir(dirname(base), { recursive: true });
  await git(dirname(base), 'clone', remote, base);
  await git(base, 'config', `url.${remote}.insteadOf`, 'https://github.com/org/repo.git');
  const branch = 'ff/task-22222222-2222-4222-8222-222222222222';
  const spec = await prepareWorktree({ workDir, repo: 'org/repo', branch, claimId: 99, createBranch: true });
  cleanups.push(() => spec.cleanup());
  expect(await git(spec.worktreePath, 'branch', '--show-current')).toBe(branch);
  await writeFile(join(spec.worktreePath, 'accepted-spec.md'), 'Accepted requirements');
  await git(spec.worktreePath, 'add', '.');
  await git(spec.worktreePath, 'commit', '-m', 'accepted spec');
  await git(spec.worktreePath, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  await spec.cleanup();
  const build = await prepareWorktree({ workDir, repo: 'org/repo', branch, claimId: 100, createBranch: true });
  cleanups.push(() => build.cleanup());
  expect(await readFile(join(build.worktreePath, 'accepted-spec.md'), 'utf8')).toBe('Accepted requirements');
});
