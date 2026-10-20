# Collaboration HTTP and MCP

[Server package](../../README.md) · [Shared services](../../../db/src/collaboration/README.md) · [Contract](../../../../docs/plans/2026-10-19-collaborative-contracts.md)

`routes.js` mounts authenticated `/api/collab/v1` services. `http.js` checks the
signed dashboard assertion and supplies request IDs and safe errors; every
service reloads current identity and scope. `routes-public.js` exposes only
rate-limited secret invitation redemption.

- `routes-identity.js`: bootstrap, projects, roles, membership, invitation
  list/revocation, assignment choices and private project-token management.
  `GET /workspaces/:id/projects` returns only projects visible to the actor.
  Role definitions live at workspace scope. A project membership administrator
  may use `GET /workspaces/:id/roles?projectId=:projectId` for that workspace's
  verified project; it returns only roles they can grant at that project.
  Role creation remains workspace-only. Project-only member lists exclude
  inherited workspace people unless the actor also has workspace-scope
  membership administration.
- `routes-tasks.js`: independent backlog, versioned ordering and legacy delivery links.
- `routes-runs.js`: explicit Start, session controls, timeline, reconciliation,
  wrap-up and scoped live `/events`. SSE stays open, resumes by cursor and
  checks current permissions on every delivery; revocation closes a filtered
  stream with `access_revoked`. `/attention` shares the current safe DTO;
  reading an update does not resolve a pending approval or error.
- `routes-hosts.js`: owner-scoped host enrollment and allowlisted mappings.
  `POST /hosts` returns the one-time `{id,name,token}` enrollment DTO.
  `GET /hosts` returns token-free summaries with nullable `lastHeartbeatAt`;
  consumers must not substitute a different timestamp field or creation DTO.
- `routes-connector.js`: outbound host lease/command/observation protocol.
- `routes-evidence.js`: retained workpad/artifact/idea/summary/usage/delivery APIs.
- `mcp.js`: separate `/mcp/collab` Streamable HTTP endpoint, twelve canonical
  task tools plus bound plan/progress/summary reporting. Human tokens scope
  current user permissions to one project. Delivered agent credentials scope
  reports to one run/session; summary sessions can report summaries only.
  Existing `/mcp` and old delivery execution retain their original contracts.

Successful JSON responses use `{data,nextCursor?}`. Errors carry a stable code,
generic message and request ID on the REST surface. Start and commands require
an `Idempotency-Key`; stale edits return 409. Raw prompts, provider transcripts,
file references and command results remain internal.

Timeline pagination returns `nextCursor` while more history exists, plus `cursor`
for the last returned row (retained on an empty response). Use the latter to
resume live catch-up after the final page. Newer provider snapshots determine
current state, plan and usage; late rows remain inspectable history.

Human artifact creation accepts supplied text and HTTPS references. Host file
references come from bound agent/connector reporting, remain internal until a
human publishes them, and are retrieved only by their opaque artifact ID.
Browser file references return `403 file_reference_forbidden`; retained human
file rows cannot queue or deliver a host read. Delivery submission requires
`task.write` and `internal.read` plus the current `expectedVersion`; stale
confirmation returns `409 version_conflict` without recording a delivery.
Start users without `internal.read` receive only safe run identity/state;
configured defaults remain server-side and frozen in the queued launch.

`/me`, `/workspaces` and the project list redact execution defaults unless the
actor has `internal.read`. Mapping reads require `internal.read` together with
`project.admin` or `run.start`. Defaults writes require `project.admin` and
`internal.read`, the current project version, a same-project nonrevoked host
mapping, and catalog-allowlisted work/summary profiles and model selections.
Known cached catalogs remain configurable while the host is offline. Invalid
selection returns422; stale configuration writes return409. Summary generation
can be disabled without discarding its configured profile/model.

Operator UAT: create a backlog task with the host offline, confirm Ready creates
no command, explicitly Start, reconnect the intended host, then verify progress,
attention and reporting on the same run. Exercise an ambiguous command through
its run-scoped request list: redeliver the same request for reconciliation or
close delivery while preserving unconfirmed remote state. Complete delivery
review independently of turn completion and inspect the saved history.

`GET /tasks/:id/decisions` reads stored human decision history for scoped
internal readers and delivery reviewers. It returns the human note, actor ID,
date, task version, acknowledged item IDs and captured acceptance review;
raw connector payloads are excluded. `limit` defaults to 50 (maximum 100), and
`nextCursor` is supplied while older rows remain. Pass it as `cursor` for the
next page. Accepted review fields come from the server's validated snapshot,
so later Git changes cannot alter what was accepted. A null snapshot means
capture was unavailable for an older decision or the decision was cancel/reopen.
UAT: accept a current review, change the current run's Git state, then confirm
history still shows the accepted revision. Reopen or cancel and confirm those
new rows do not claim an accepted review.

New error cases include invalid update/timeline cursors (`invalid_cursor`,
refresh required), follow-up on a closed task (`task_closed`, reopen first),
missing/stale wrap-up preflight (`preflight_required`), and withdrawn profile
or model grants (`profile_not_allowed`/`model_not_allowed`). Foreign scopes
remain indistinguishable from missing resources; generated evidence keeps its
agent provenance and cannot accept delivery.

Native cancellation preserves the task's delivery status. Terminal session
observations remain authoritative when delayed cancellation-intent updates
arrive. An authorized follow-up may resume a cancelled native session with the
same IDs; it reserves the session and run together and refuses another active
or uncertain attempt. Failed, reconciling or cancelling sessions reject a
follow-up with `session_not_active`. Connector command-derived observations may
include `commandId`, allowing superseded cancellation intent to remain history
without replacing a newer prompt reservation.
