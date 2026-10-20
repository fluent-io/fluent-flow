# Collaboration collab

[Parent documentation](<../../../README.md>)

- [attention-view.tsx](<attention-view.tsx>) — Scoped paginated attention, duplicate/cursor guards, bounded Load more and current read cursors.
- [board-view.tsx](<board-view.tsx>) — Authorized project board, persisted ordering and bounded live refresh.
- [create-task-dialog.tsx](<create-task-dialog.tsx>) — Backlog capture without repository or execution prerequisites.
- [execution-badge.tsx](<execution-badge.tsx>) — Client-safe execution and host reachability projection.
- [settings-view.tsx](<settings-view.tsx>) — Capability-scoped client/project membership and invitations, workspace-defined roles, catalog-backed execution choices and usage coverage. Membership-only administration does not fetch execution mappings or hosts. Work and summary profiles/models remain separate, including disabled summaries and known offline configurations.
- [task-detail.tsx](<task-detail.tsx>) — Task metadata, criteria, client/internal discussion and versioned editing; transient refresh failures preserve the open view and drafts.
- [task-execution-tab.tsx](<task-execution-tab.tsx>) — Run/session selection, explicit execution, current questions, summaries and command reconciliation; unavailable reads preserve observed output and drafts while revoked access clears private data.
- [task-ideas-tab.tsx](<task-ideas-tab.tsx>) — Source-linked ideas and explicit task or session conversion.
- [task-workpad-tab.tsx](<task-workpad-tab.tsx>) — Plans, open questions, check history, safe artifacts, delivery review, immutable human decision history and guarded wrap-up. Decision history shows the saved review commit/worktree state, note and acknowledgment count; missing captures stay unknown. Optional decision notes are separate from delivery notes and clear after success or lost access.
