import { createGitReader } from './workpad.js';
import { nativeWorkspaceId } from './uuid-v5.js';

const NATIVE_BACKENDS = new Set(['claude-code', 'codex']);
export const NATIVE_BLOCKED_NOTE = 'Worktree cleanup is blocked. Review the outstanding work.';

/**
 * @param {{ supervisor: { request: (method: string, params?: object) => Promise<any> }, journal: any, log?: (obj: object) => void }} opts
 */
export function createNativeWrapup({ supervisor, journal, log = () => {} }) {
  function nativeRun(runId) {
    const binding = journal.bindingForRun(runId);
    return binding && NATIVE_BACKENDS.has(binding.backend) && binding.workspaceRef && binding.repositoryKey ? binding : null;
  }

  function shaped(runId, workspaceRef, check) {
    return {
      runId,
      workspaceId: workspaceRef,
      owned: check.owned === true,
      workspace: { id: workspaceRef, kind: 'worktree', archiving: false, directoryKnown: check.directoryKnown === true },
      sessions: check.sessions ?? [],
      git: check.git ?? { ok: false, failCode: 'git_unreadable' },
      blockers: check.blockers ?? [],
      checkedAt: new Date().toISOString(),
    };
  }

  function receiptPreflight(runId, receipt) {
    return shaped(runId, receipt.workspaceRef, { owned: true, directoryKnown: false, sessions: [], blockers: [],
      git: { ok: true, branch: receipt.branch, headCommit: receipt.headCommit, upstream: receipt.upstream, uncommitted: 0, untracked: 0, unpushed: 0 } });
  }

  const blocked = (preflight, blockers) => ({ ok: false, phase: 'archive', ...(preflight ? { preflight } : {}), blockers, note: NATIVE_BLOCKED_NOTE });

  async function preflight({ runId }) {
    const binding = nativeRun(runId);
    if (!binding) return shaped(runId, null, { owned: false, blockers: [{ code: 'ownership_unverified' }] });
    const check = await supervisor.request('wrapupPreflight', { runId, repositoryKey: binding.repositoryKey, workspaceRef: binding.workspaceRef });
    return check.archived ? receiptPreflight(runId, check.archived) : shaped(runId, binding.workspaceRef, check);
  }

  return {
    preflight,

    async archive({ runId, mode }) {
      if (!['archive_sessions', 'archive_owned_workspace'].includes(mode)) return { ok: false, phase: 'archive', blockers: [{ code: 'unknown_mode' }] };
      const binding = nativeRun(runId);
      if (!binding) return blocked(null, [{ code: 'ownership_unverified' }]);
      if (mode === 'archive_sessions') {
        const closed = await supervisor.request('wrapupCloseSessions', { runId });
        if (!closed.ok) {
          log({ msg: 'native wrap-up closure blocked', runId, blockers: closed.blockers });
          return { ...blocked(null, closed.blockers), archivedSessions: closed.closedSessions ?? 0 };
        }
        return { ok: true, phase: 'archive', archivedSessions: closed.closedSessions, archivedWorkspace: false, note: `${closed.closedSessions} session(s) closed; worktree kept.` };
      }
      const prior = journal.workspaceArchive(runId, binding.workspaceRef);
      const done = await supervisor.request('wrapupArchive', { runId, repositoryKey: binding.repositoryKey, workspaceRef: binding.workspaceRef });
      if (!done.ok) {
        log({ msg: 'native wrap-up blocked', runId, blockers: done.blockers });
        return blocked(done.preflight ? shaped(runId, binding.workspaceRef, done.preflight) : null, done.blockers);
      }
      const archivedAt = done.receipt.at;
      const result = {
        ok: true,
        phase: 'archive',
        preflight: done.repeated ? receiptPreflight(runId, done.receipt) : shaped(runId, binding.workspaceRef, done.preflight),
        archivedSessions: 0,
        archivedWorkspace: true,
        archivedAt,
        note: 'Owned worktree archived; the branch and history are kept.',
      };
      if (!prior) await journal.append({ type: 'workspace_archived', runId, workspaceId: binding.workspaceRef, result, at: archivedAt });
      return result;
    },
  };
}

/**
 * @param {object} opts
 * @param {import('@getpaseo/client').PaseoClient} opts.paseo
 * @param {object} [opts.git] - createGitReader() result
 * @param {object} opts.journal - for owned session identity
 * @param {(obj: object, msg?: string) => void} [opts.log]
 */
export function createWrapup({ paseo, git = createGitReader(), journal, log = () => {} }) {
  function workspaceForRun(runId) {
    for (const commandId of journal?.boundCommandIds?.() ?? []) {
      const binding = journal.byCommand(commandId)?.binding;
      if (binding?.runId === runId && binding.workspaceId) return binding.workspaceId;
    }
    return nativeWorkspaceId(runId);
  }
  function ownedSessionIds(runId, workspaceId = workspaceForRun(runId)) {
    if (!journal?.boundCommandIds) return [];
    const ids = [];
    for (const commandId of journal.boundCommandIds()) {
      const rec = journal.byCommand(commandId);
      if (rec?.binding?.runId === runId && rec.binding.workspaceId === workspaceId && rec.binding?.paseoAgentId) {
        ids.push(rec.binding.paseoAgentId);
      }
    }
    return ids;
  }

  async function workspaceSessions(workspaceId) {
    const sessions = [];
    let cursor;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
      for (const entry of page.entries ?? []) {
        const agent = entry.agent ?? entry;
        if (agent.workspaceId === workspaceId && !agent.archivedAt) {
          sessions.push({ id: agent.id, status: agent.status });
        }
      }
      cursor = page.pageInfo?.nextCursor ?? undefined;
    } while (cursor);
    return sessions;
  }

  async function preflight({ runId, workspaceId }) {
    const blockers = [];
    const owned = workspaceId === workspaceForRun(runId) && ownedSessionIds(runId, workspaceId).length > 0;
    if (!owned) blockers.push({ code: 'ownership_unverified' });
    let workspace = null;
    let sessions = [];
    let gitState = null;

    try {
      const handle = paseo.workspaces.ref(workspaceId);
      const ws = await handle.refresh();
      if (ws?.id !== workspaceId) blockers.push({ code: 'workspace_identity_mismatch' });
      const kind = ws?.workspaceKind ?? 'unknown';
      const directory = ws?.workspaceDirectory ?? null;
      const archiving = Boolean(ws?.archivingAt);
      workspace = { id: workspaceId, kind, archiving, directoryKnown: Boolean(directory) };
      if (archiving) blockers.push({ code: 'archiving_in_progress' });
      if (kind !== 'worktree') blockers.push({ code: 'not_owned_worktree' });
      if (!directory) blockers.push({ code: 'directory_unknown' });
      log({ msg: 'wrapup preflight directory', runId, directory: directory ?? null });
      if (kind === 'worktree' && directory) {
        gitState = await git.state(directory);
        if (!gitState.ok) {
          blockers.push({ code: 'git_unreadable' });
        } else {
          if (gitState.uncommitted > 0) blockers.push({ code: 'uncommitted_changes', count: gitState.uncommitted });
          if (gitState.untracked > 0) blockers.push({ code: 'untracked_files', count: gitState.untracked });
          if (gitState.unpushed > 0) blockers.push({ code: 'unpushed_commits', count: gitState.unpushed });
          if (gitState.upstream === null) blockers.push({ code: 'no_upstream' });
        }
      }
    } catch {
      blockers.push({ code: 'workspace_inspection_failed' });
      workspace = { id: workspaceId, kind: 'unknown', archiving: false, directoryKnown: false };
    }

    let ownedIds = [];
    try {
      sessions = await workspaceSessions(workspaceId);
      ownedIds = ownedSessionIds(runId);
      const ownedSet = new Set(ownedIds);
      const unrecognized = sessions.filter((s) => !ownedSet.has(s.id));
      if (unrecognized.length) blockers.push({ code: 'unrecognized_sessions', count: unrecognized.length });
      const active = sessions.filter((s) => ['running', 'initializing', 'pending'].includes(s.status));
      if (active.length) blockers.push({ code: 'sessions_running', count: active.length });
    } catch {
      blockers.push({ code: 'session_listing_failed' });
    }

    return {
      runId,
      workspaceId,
      owned,
      workspace,
      sessions: sessions.map((s) => ({ id: s.id, status: s.status, owned: ownedIds.includes(s.id) })),
      git: gitState?.ok
        ? { ok: true, branch: gitState.branch, headCommit: gitState.headCommit, upstream: gitState.upstream, uncommitted: gitState.uncommitted, untracked: gitState.untracked, unpushed: gitState.unpushed }
        : { ok: false, failCode: 'git_unreadable' },
      blockers,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    preflight,

    async archive({ runId, mode }) {
      const owned = workspaceForRun(runId);
      if (!['archive_sessions', 'archive_owned_workspace'].includes(mode)) {
        return { ok: false, phase: 'archive', blockers: [{ code: 'unknown_mode' }] };
      }
      const check = await this.preflight({ runId, workspaceId: owned });
      const sessionOnlyBlockers = new Set(['not_owned_worktree', 'directory_unknown', 'git_unreadable', 'uncommitted_changes', 'untracked_files', 'unpushed_commits', 'no_upstream', 'sessions_running']);
      const blockers = mode === 'archive_sessions' ? check.blockers.filter((blocker) => !sessionOnlyBlockers.has(blocker.code)) : check.blockers;
      if (blockers.length) {
        log({ msg: 'wrap-up blocked', runId, blockers });
        return { ok: false, phase: 'archive', preflight: check, blockers, note: 'Workspace cleanup is blocked to protect your work.' };
      }
      const failures = [];
      let archivedSessions = 0;
      let archivedAt = null;
      const ownedIds = new Set(ownedSessionIds(runId));
      if (mode === 'archive_owned_workspace') {
        const result = await paseo.workspaces.archive(owned).catch(() => ({ archivedAt: null }));
        if (!result.archivedAt) failures.push({ code: 'workspace_archive_failed' });
        else { archivedSessions = check.sessions.length; archivedAt = result.archivedAt; }
      } else {
        for (const session of check.sessions) {
          if (!ownedIds.has(session.id)) {
            failures.push({ code: 'unrecognized_session_skipped' });
            continue;
          }
          try {
            await paseo.agents.ref(session.id).archive();
            archivedSessions += 1;
          } catch {
            failures.push({ code: 'session_archive_failed' });
          }
        }
      }
      if (failures.length) {
        log({ msg: 'wrap-up incomplete', runId, failures });
        return { ok: false, phase: 'archive', preflight: check, failures, archivedSessions, partial: true };
      }
      const result = {
        ok: true,
        phase: 'archive',
        preflight: check,
        archivedSessions,
        archivedWorkspace: mode === 'archive_owned_workspace',
        ...(archivedAt ? { archivedAt } : {}),
        note: mode === 'archive_owned_workspace'
          ? 'Owned worktree archived; the branch and history are kept.'
          : `${archivedSessions} session(s) archived; workspace kept.`,
      };
      if (result.archivedWorkspace) {
        await journal.append({ type: 'workspace_archived', runId, workspaceId: owned, result, at: archivedAt });
      }
      return result;
    },
  };
}
