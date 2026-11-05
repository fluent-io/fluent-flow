# Collaboration services

[Shared database package](../../README.md) · [Contract](../../../../docs/plans/2026-10-19-collaborative-contracts.md) · [Database regressions](../../tests/collaboration/README.md)

These server-only raw PostgreSQL services own the canonical client/project/task
model. Never import them into a browser bundle. `index.ts` exports the supported
surface; `identity.ts` preserves the shared import facade.

- `principals.ts`, `passwords.ts`, `auth.ts`, `rate-limit.ts`: additive identities,
  password login, short-lived dashboard assertions and throttling.
- `workspaces.ts`, `memberships.ts`, `invitations.ts`, `authorize.ts`,
  `capabilities.ts`: current scoped roles, invitations, assignment choices and
  administrative controls. No implicit empty-scope administrator access.
- `project-overviews.ts`: member-readable project overview (name, description,
  run and test instructions) and project.admin edits. Rows live in
  `collab_project_overviews` (migration 0021); a missing row reads as empty.
  Edits lock the project row and share `collab_projects.version` with
  execution defaults.
- `tasks.ts`, `comments.ts`, `events.ts`, `schemas.ts`: independent backlog,
  versioned edits/moves, client/internal discussion, safe execution cards,
  current attention and monotonic read cursors. Event cursors preserve database
  timestamp precision for resumable live delivery.
- `execution.ts`: native execution ownership for host catalogs with
  `formatVersion: 2`. Exact profile selection (a missing, duplicated or
  malformed id is `execution_settings_changed`, never a first match), readiness
  and required-capability gates for Start, the `collab_run_execution` /
  `collab_session_execution` side rows (migration `0022`, no foreign keys) and
  the claim-time check that fails a v2 command whose entry changed backend,
  revision or capabilities. Policy is reduced to known per-backend fields
  before storage or display. Catalogs without `formatVersion` keep the legacy
  path unchanged. v2 `capacity` is canonical per backend:
  `{ limit, available, observedAt }`, where `available` (0..limit) and its
  `observedAt` are both known or both null; a limit-only integer is stored as
  `{ limit, available: null, observedAt: null }` (Task 7 capacity ruling).
- `hosts.ts`, `runs.ts`, `connector.ts`: explicit run requests, frozen execution
  context, task-level continuation reservation, host leases, same-command
  redelivery, accepted grants and truthful uncertainty/failure projections.
  Native observations and trusted evidence projections share one transaction.
  Native binding (Task 7): a `session_bound` naming `backend` (`claude-code` or
  `codex`), `nativeSessionId` and `generation` updates only the session's
  `collab_session_execution` row for that frozen backend and only to a higher
  `binding_generation`; it never writes `paseo_agent_id` or
  `provider_session_id`. A native `workspace_bound` sets
  `collab_run_execution.workspace_ref` (and the run's `workspace_id`, queued to
  launching) for the run's own backend. A native observation too large for one
  batch arrives as fragments (`<eventId>#f<index>/<count>`, payload
  `{ fragmentOf, index, count, encoding: 'base64', data }`); fragments are stored,
  never projected, and once all are present the original observation is rebuilt
  from their exact bytes and projected under its own id (an undecodable result is
  stored as an explicit unavailable record). The rebuilt original is processed at
  its final fragment's position, before anything later in the same request.
  Observation rows get a strictly increasing per-run/session append key in
  `created_at`: `GREATEST(clock_timestamp(), predecessor + 1 µs)`, serialized by
  the run's task-row lock, so `(created_at, id)` history pages keep processing
  order even when the wall clock ties or moves backward. `observed_at` keeps the
  reported time. Session history and summary sources exclude fragment rows. The 1 MiB
  batch cap is unchanged.
  A supervisor `worker_lost` spool (`state: reconciling`, `errorCode: reconciling`,
  `reason: worker_lost`, trusted `stop`, source naming the session's frozen native
  backend and its current `binding_generation`) is the one exception to the
  terminal-event drop guard: over an `idle` session it projects `reconciling`.
  Failed, cancelled, foreign-backend, stale-generation and unshaped spools stay
  retained-only.
  `pollConnectorCommands` is a long-poll: with no deliverable work it rechecks
  every 500 ms until work arrives, `waitMs` (0–25000, default 25000) expires or
  the optional internal `signal` aborts. `waitMs: 0` is one non-blocking
  attempt. Each recheck is its own short fenced transaction (token, session
  and epoch re-checked), so no connection, transaction or lock is held while
  waiting and a revoked or superseded host fails on the next recheck.
- Capacity admission (Task 10, `connector.ts`, `runs.ts`, `execution.ts`): a poll may report `availableSlots` (`{ 'claude-code'?, codex? }`, each 0..64; absent means 0). Slot-requiring commands (`slotBackendSql`: still `pending` v2 native `launch`, `create_session`, `summarize`, and `prompt` to a session not `running` or `needs_input`) are candidates only within their backend's free slots in `created_at, id` order, decided before the batch limit, so a capacity backlog never hides a control, a legacy or Paseo command or the other backend. Waiting commands stay `pending` with no lease, redelivery or TTL; a claimed or accepted redelivery needs no new slot. A delivered slot-requiring command carries `slotGranted: true`. Each claim writes `catalog.capacity[backend] = { limit, available, observedAt }` for the backends it was told about (DML on the existing column; the limit stays as registered). A `cancel` for a session whose launch-like command is still `pending` takes the host's connector lock first (the order a claim takes), cancels that command (`cancelled_before_delivery`) and, for a launch, the run, and stores the cancel as `applied` with `{ dispatched: false }`; it is never delivered. `getCollabRun` adds `queue: { queuedAt, reason: 'capacity' | 'host_offline' | null } | null` from the run's oldest waiting command only. A failed native state carrying `account_limited` sets the run's `error_code` to `account_limited`. Concern pass: once per poll, before admission, every waiting slot-requiring command is rechecked against the frozen settings, authorization and v1 fence (failed `execution_settings_changed` or cancelled `authorization_withdrawn`, undelivered), so invalid work never waits for a slot and valid work is untouched. A redelivery of a lapsed `claimed` native slot command carries `slotHeld: true` (it uses the grant of the poll that claimed it). Every poll answer carries `heldClaims: { 'claude-code', codex }`, this host's claimed, unacknowledged native slot commands not in that answer, the host's positive evidence for returning a grant. A payload-less command of a native run carries `nativeBackend` (the run's frozen backend) so the host routes a Cancel without a binding to its supervisor. Concern pass 2: a poll may state `notAfter` (ISO, server clock); every claim attempt reads the database clock after the host's connector lock, claims no slot work once that clock is past the poll's `notAfter`, and returns it as `serverTime` (registration returns `serverTime` too). Under that lock every attempt is ordered against every answer, so an answer whose `serverTime` is past a lost poll's deadline proves that poll can never claim again. A queued Cancel is inline (never delivered) only for a launch-like command that was never delivered: still `pending` with no `error_code`, `claimed_at`, `lease_epoch` or `acked_at`. One re-queued by an operator redelivery (`reconciliation_redelivery`) gets an ordinary Cancel control that its native owner settles, and (fix round 1) its requeue is withdrawn in the same transaction: back to `ambiguous` with `redelivery_withdrawn_by_cancel` (session and a queued run back to `reconciling`), so no claim can admit it ahead of the Cancel. Clock authority (fix rounds 1 and 2): each claim attempt's `serverTime` is `GREATEST(clock_timestamp(), catalog.pollAuthority)`, read under the host's connector lock and written back as the host's `pollAuthority`, a server-private catalog key: never parsed from a client (registration strips unknown catalog keys), kept across registration refreshes and replacement registrations, and not part of any host, mapping or run read. So a backwards database clock reading cannot reopen a poll whose `notAfter` an earlier answer passed. `last_heartbeat_at` is separate and stays the actual last contact (`now()` at each registration, heartbeat and claim), so after a clock correction a real contact is fresh again, and a disconnected host ages to stale and offline, and frees its registration hold, under the existing 45 s and 120 s rules.
- Explicit continuation (Task 11 concern pass, `runs.ts`): a `prompt` to a `reconciling` session of a standalone native run (`collab_run_execution.backend` `claude-code` or `codex`) is accepted under the existing `internal.read` + `run.steer`, with the session's frozen execution; the run and session go back to `queued`. Everything else about prompts is unchanged; Paseo and legacy reconciling sessions still refuse (409). The host decides whether the exact session can be reopened.
- Safe execution projection (Task 12 seam, `hosts.ts`): `ProjectMappingProfile` adds `backend` (`claude-code`, `codex`, `paseo` or null), `readiness` (`{ state }` from a formatVersion 2 entry, else null, never invented) and `policy` (`sanitizePolicy` fields only, else null). A v1 entry is `paseo` with null readiness and policy; a missing, duplicated or malformed v2 entry has all three null. `ProjectMappingRead.capacity` holds the canonical `capacityEntrySchema` entry for each native backend among the mapping's allowlisted profiles, or null. `getExecutionHostCatalog({ actor, hostId })` (enrolling principal or genuine superadmin, else 404) returns `{ hostId, repositories: [{ key }], profiles, capacity }` with the same projection for every catalog entry. Neither read returns `pollAuthority`, revisions, harness, capabilities, limits, auth expectations or tokens.
- Operator closure (Task 11, `runs.ts`): `submitSessionCommand` also accepts a `cancel` for a run in `reconciling` when the run has standalone native execution ownership (`collab_run_execution.backend` is `claude-code` or `codex`), under the existing `internal.read` + `run.cancel` capabilities and the same locks and idempotency. Any other command on such a run, and a Cancel on a reconciling Paseo or legacy run, is still 409 `run_not_active` ("This run is no longer active."). The host settles it from its own evidence; a proven closure arrives as an ordinary `state: cancelled` observation (`closure: 'operator'`), which projects the session and run `cancelled` without changing task status and leaves the task free for a new explicit Start. No schema change.
- Pending requests (Task 9, `runs.ts`): `getSessionPendingRequests(actor, sessionId, { cursor, limit })` lists every outstanding request oldest first (limit default and maximum 50, opaque cursor). A native request is outstanding only for the session's backend and current binding generation; its `requestId` is the first 32 hex of `sha256(sessionId|backend|generation|nativeRequestId)`. `getSessionPendingRequest` is the compatibility wrapper: the most recent outstanding request, today's DTO and `{ id, label }` choices. `submitSessionCommand` checks a `permission` answer inside the run's command lock before storing anything: the request must be pending with the same fingerprint and generation (else 409 `request_unavailable`), have no earlier answer that has not failed or been cancelled, and the choice must be offered with that behavior; a host-only allow is 409 `answer_on_host` (deny accepted); native questions need `selections` that fit the questions, and `answers` or misfitting selections are 400 `invalid_response`. Native HTTP wire (fix 1): each native question option in the plural DTO has `id` `o<index>` (its position in that exact request's offered order; no label or answer bytes), and native web selections are `{ [questionId]: { optionIds: string[], other?: string } }`. Raw-label (`selected`) and mixed label/id entries are refused with `invalid_response`; a displayed label may be a scrubbed local value (`[local answer]`) and several can look alike. Direct backend and host-local (`localAnswer`) selections keep label arrays (`selected`); Paseo keeps `answers`; permission choice ids are unchanged. Paseo choices without a behavior keep today's handling and Paseo keeps `answers`. A native payload adds the `nativeRequestId` the supervisor answers.
- `tokens.ts`: hashed human project tokens and session-bound agent context;
  reporting credentials never grant membership, Start or acceptance powers.
- `evidence.ts`: workpad criteria/checks/plans/questions, artifacts, ideas,
  configured summaries, honest usage and reviewed human delivery decisions.
  Task 8: a native summary freezes the work session's highest supervisor
  cursor (`timeline_epoch` must be `ff-native-v1:<run backend>`; otherwise
  422 `summary_unavailable`, "There is no session history to summarize yet.")
  and its prompt embeds no history (the execution host appends the frozen
  prefix). v1 summaries are unchanged. On a native generated-summary session
  (one with a `collab_session_execution` row), a repeated report with the same
  task, run, session, body and stored visibility returns the recorded row;
  legacy summary sessions keep every report.
  Insights use known cumulative native session snapshots in place of that
  session's turn samples. Unavailable snapshots fall back to turn samples;
  missing metrics stay null. Raw samples and observations remain stored.
  Delivery acknowledgments include current native questions and approvals;
  request changes or resolutions invalidate an older review snapshot.
  Reviewers see generic labels, while internal readers see bounded prompt text.
  Human acceptance stores its validated review snapshot on the decision row;
  later run changes never rewrite it. Older decisions and cancel/reopen have
  no captured acceptance snapshot.
- `delivery-links.ts`: existing claim/PR references require current access in
  both permission domains. Linking never launches old claims or changes merge
  controls, claim state or human delivery acceptance.
- `tx.ts`, `errors.ts`: shared transaction lifecycle and safe typed errors.

All migrations use the new `collab_` schema only and move forward. Tests reset
only dedicated local `ff_*` databases; package ownership prevents parallel
Turbo test suites from resetting each other's databases.
