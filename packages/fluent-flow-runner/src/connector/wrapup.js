import { createGitReader } from './workpad.js';
import { nativeWorkspaceId } from './uuid-v5.js';

/**
 * Wrap-up preflight and strictly-owned archival (C4).
 *
 * STRONGER than the Flowly upstream wrap-up: uncommitted/untracked/unpushed
 * work, missing upstream and unknown workspace state are BLOCKERS, never
 * acknowledgable warnings — an operator can never acknowledge away the
 * destruction of unpushed code. Only the workspace this connector created for
 * the run is archivable, and only sessions JOURNALED as bound
 * to this run's commands are archival candidates; unrecognized manual/foreign
 * sessions inside the owned workspace block workspace archival. No force flags
 * exist on any path; Paseo's archive keeps branches.
 *
 * Public payloads carry STRUCTURED CODES + counts only — physical paths,
 * provider errors and config stay in private logs.
 *
 * Descriptor note: the real 0.12.0 WorkspaceDescriptorPayload carries
 * workspaceKind, workspaceDirectory and archivingAt as TOP-LEVEL fields on
 * the refresh result.
 *
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
      const ws = await handle.refresh(); // resolves the descriptor itself (0.12.0)
      if (ws?.id !== workspaceId) blockers.push({ code: 'workspace_identity_mismatch' });
      // Top-level descriptor fields only — verified against the installed
      // 0.12.0 types (no `status.kind` fallback: status is a string union).
      const kind = ws?.workspaceKind ?? 'unknown';
      const directory = ws?.workspaceDirectory ?? null;
      const archiving = Boolean(ws?.archivingAt);
      workspace = { id: workspaceId, kind, archiving, directoryKnown: Boolean(directory) };
      if (archiving) blockers.push({ code: 'archiving_in_progress' });
      if (kind !== 'worktree') blockers.push({ code: 'not_owned_worktree' });
      // A missing directory must never silently skip the git safety check.
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
      // Fresh recheck immediately before any destructive step — a stale
      // preflight never authorizes cleanup.
      const check = await this.preflight({ runId, workspaceId: owned });
      if (check.blockers.length) {
        log({ msg: 'wrap-up blocked', runId, blockers: check.blockers });
        return { ok: false, phase: 'archive', preflight: check, blockers: check.blockers, note: 'Workspace cleanup is blocked to protect your work.' };
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
        // Persist before returning to the executor: Git sampling must not
        // reinterpret expected worktree removal as loss of evidence.
        await journal.append({ type: 'workspace_archived', runId, workspaceId: owned, result, at: archivedAt });
      }
      return result;
    },
  };
}
