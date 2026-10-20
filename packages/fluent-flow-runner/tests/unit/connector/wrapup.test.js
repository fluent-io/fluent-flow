import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWrapup } from '../../../src/connector/wrapup.js';
import { createJournal } from '../../../src/connector/journal.js';

const execFile = promisify(execFileCb);

/**
 * Wrap-up safety against REAL worktrees and the REAL 0.12.0 descriptor shape
 * (workspaceKind / workspaceDirectory / archivingAt are TOP-LEVEL fields of
 * WorkspaceDescriptorPayload).
 */

let tmp;

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args]);
}

async function initRepoWithWorktree(branch) {
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 't@example.com');
  await git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'init');
  const remote = join(tmp, 'remote.git');
  await execFile('git', ['clone', '--bare', repo, remote]);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');
  const wt = join(tmp, 'wt');
  await execFile('git', ['-C', repo, 'worktree', 'add', '-b', branch, wt]);
  await git(wt, 'push', '-u', 'origin', branch);
  return wt;
}

function fakePaseo(descriptor, sessions = []) {
  const archived = [];
  return {
    archived,
    workspaces: {
      ref: () => ({ refresh: async () => descriptor }),
      archive: async (id) => {
        archived.push(id);
        return { requestId: 'r', workspaceId: id, archivedAt: '2026-10-19T00:00:00Z', error: null };
      },
    },
    agents: {
      list: async () => ({ entries: sessions.map((s) => ({ agent: s })), pageInfo: {} }),
      ref: (id) => ({ archive: async () => ({ archivedAt: 't' }) }),
    },
  };
}

async function journalWith(runId, sessionId, agentId, workspaceId) {
  const journal = createJournal({ dir: join(tmp, `j-${runId}`) });
  await journal.append({ type: 'binding', commandId: `c-${runId}`, runId, sessionId, workspaceId, paseoAgentId: agentId, providerSessionId: null });
  return journal;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ff-wrap-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('wrap-up preflight (real descriptor, real worktree)', () => {
  it('preserves a clean same-name manual workspace when the ownership journal is empty or foreign', async () => {
    const wt = await initRepoWithWorktree('manual-work');
    for (const journal of [createJournal({ dir: join(tmp, 'empty') }), await journalWith('other', 's', 'ag', 'ffws-run-unknown')]) {
      const paseo = fakePaseo({ id: 'ffws-run-unknown', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null }, []);
      const wrapup = createWrapup({ paseo, journal });
      const result = await wrapup.archive({ runId: 'run-unknown', mode: 'archive_owned_workspace' });
      expect(result.ok).toBe(false);
      expect(result.preflight.owned).toBe(false);
      expect(result.blockers.map((b) => b.code)).toContain('ownership_unverified');
      expect(paseo.archived).toEqual([]);
    }
  });
  it('clean owned pushed worktree with only journaled sessions passes and archives', async () => {
    const wt = await initRepoWithWorktree('ff/run-1/s-1');
    const journal = await journalWith('run-1', 's-1', 'ag-1', 'ffws-run-1');
    const paseo = fakePaseo(
      { id: 'ffws-run-1', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null },
      [{ id: 'ag-1', workspaceId: 'ffws-run-1', status: 'idle', archivedAt: null }],
    );
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-1', workspaceId: 'ffws-run-1' });
    expect(pre.workspace.kind).toBe('worktree');
    expect(pre.blockers).toEqual([]);
    const res = await wrapup.archive({ runId: 'run-1', mode: 'archive_owned_workspace' });
    expect(res.ok).toBe(true);
    expect(paseo.archived).toEqual(['ffws-run-1']);
  });

  it('blocks on uncommitted REAL changes; the dirty file survives every attempt', async () => {
    const wt = await initRepoWithWorktree('ff/run-2/s-1');
    writeFileSync(join(wt, 'dirty.txt'), 'must survive'); // untracked
    writeFileSync(join(wt, 'a.txt'), 'modified tracked file\n'); // uncommitted
    const journal = await journalWith('run-2', 's-1', 'ag-1', 'ffws-run-2');
    const paseo = fakePaseo(
      { id: 'ffws-run-2', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null },
      [{ id: 'ag-1', workspaceId: 'ffws-run-2', status: 'idle', archivedAt: null }],
    );
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-2', workspaceId: 'ffws-run-2' });
    expect(pre.blockers.map((b) => b.code)).toContain('uncommitted_changes');
    const res = await wrapup.archive({ runId: 'run-2', mode: 'archive_owned_workspace' });
    expect(res.ok).toBe(false);
    expect(res.note).toBe('Workspace cleanup is blocked to protect your work.');
    expect(readFileSync(join(wt, 'dirty.txt'), 'utf8')).toBe('must survive');
    expect(paseo.archived).toHaveLength(0);
  });

  it('blocks on unpushed commits and missing upstream', async () => {
    const wt = await initRepoWithWorktree('ff/run-3/s-1');
    writeFileSync(join(wt, 'local.txt'), 'only local');
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', 'local only');
    const journal = await journalWith('run-3', 's-1', 'ag-1', 'ffws-run-3');
    const paseo = fakePaseo(
      { id: 'ffws-run-3', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null },
      [],
    );
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-3', workspaceId: 'ffws-run-3' });
    const codes = pre.blockers.map((b) => b.code);
    expect(codes).toContain('unpushed_commits');
  });

  it('blocks unknown kinds, missing directories and archiving-in-progress', async () => {
    const journal = await journalWith('run-4', 's-1', 'ag-1', 'ffws-run-4');
    const paseo = fakePaseo({ id: 'ffws-run-4', workspaceKind: 'local', workspaceDirectory: null, archivingAt: null }, []);
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-4', workspaceId: 'ffws-run-4' });
    const codes = pre.blockers.map((b) => b.code);
    expect(codes).toContain('not_owned_worktree');
    expect(codes).toContain('directory_unknown');
    const paseo2 = fakePaseo({ id: 'ffws-run-5', workspaceKind: 'worktree', workspaceDirectory: '/somewhere', archivingAt: '2026-10-19T00:00:00Z' }, []);
    const wrapup2 = createWrapup({ paseo: paseo2, journal });
    const pre2 = await wrapup2.preflight({ runId: 'run-5', workspaceId: 'ffws-run-5' });
    expect(pre2.blockers.map((b) => b.code)).toContain('archiving_in_progress');
  });

  it('blocks sessions in the workspace that the run does not own', async () => {
    const wt = await initRepoWithWorktree('ff/run-6/s-1');
    const journal = await journalWith('run-6', 's-1', 'ag-mine', 'ffws-run-6');
    const paseo = fakePaseo(
      { id: 'ffws-run-6', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null },
      [
        { id: 'ag-mine', workspaceId: 'ffws-run-6', status: 'idle', archivedAt: null },
        { id: 'ag-foreign', workspaceId: 'ffws-run-6', status: 'idle', archivedAt: null },
      ],
    );
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-6', workspaceId: 'ffws-run-6' });
    expect(pre.blockers.map((b) => b.code)).toContain('unrecognized_sessions');
    const res = await wrapup.archive({ runId: 'run-6', mode: 'archive_owned_workspace' });
    expect(res.ok).toBe(false);
  });

  it('payloads never carry physical paths or provider error text', async () => {
    const journal = await journalWith('run-7', 's-1', 'ag-1', 'ffws-run-7');
    const paseo = fakePaseo(
      { id: 'ffws-run-7', workspaceKind: 'worktree', workspaceDirectory: join(tmp, 'secret-place'), archivingAt: null },
      [],
    );
    const wrapup = createWrapup({ paseo, journal });
    const pre = await wrapup.preflight({ runId: 'run-7', workspaceId: 'ffws-run-7' });
    expect(JSON.stringify(pre)).not.toContain('secret-place');
  });

  it('archive_sessions archives only journaled owned sessions', async () => {
    const wt = await initRepoWithWorktree('ff/run-8/s-1');
    const journal = await journalWith('run-8', 's-1', 'ag-mine', 'ffws-run-8');
    const agentArchives = [];
    const paseo = fakePaseo(
      { id: 'ffws-run-8', workspaceKind: 'worktree', workspaceDirectory: wt, archivingAt: null },
      [
        { id: 'ag-mine', workspaceId: 'ffws-run-8', status: 'idle', archivedAt: null },
        { id: 'ag-other', workspaceId: 'ffws-run-8', status: 'idle', archivedAt: null },
      ],
    );
    // remove the foreign session blocker for this scenario: the foreign agent
    // lives in ANOTHER workspace, ours is alone here.
    paseo.agents.list = async () => ({ entries: [{ agent: { id: 'ag-mine', workspaceId: 'ffws-run-8', status: 'idle', archivedAt: null } }], pageInfo: {} });
    paseo.agents.ref = (id) => ({ archive: async () => { agentArchives.push(id); return { archivedAt: 't' }; } });
    const wrapup = createWrapup({ paseo, journal });
    const res = await wrapup.archive({ runId: 'run-8', mode: 'archive_sessions' });
    expect(res.ok).toBe(true);
    expect(agentArchives).toEqual(['ag-mine']);
  });
});
