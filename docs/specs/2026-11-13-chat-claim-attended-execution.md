# Attended execution as chat claims

**Status:** Draft v2 — revised after cross-provider review (Claude Code + Codex, 2026-11-13). v1's idle-expiry, redispatch, teardown, uniqueness, and removal designs were wrong or incomplete; this version incorporates the corrections. Reviewer findings are cited inline as (C#) for Claude Code and (X#) for Codex.

## Purpose

Today Fluent Flow runs AI work through two unrelated execution stacks:

1. **The claim pipeline** (agents, agent servers, `agent_claims`): distributed runner slots pull claims, spawn one ACP v2 child per claim over stdio, stream events, and report results. Delivered by #127 and #132; portable self-hosting by #141. No Paseo involvement.
2. **The Paseo connector tier** (`fluent-flow-connector`, execution hosts, repository mappings, host catalogs): attended, user-triggered task runs on a user-enrolled machine through an externally installed Paseo daemon, with held-poll transport to Fluent Flow and WebSocket to the daemon. Introduced 2026-10-19 from the Kaneo/Flowly consolidation.

The connector tier exists only because, in October, attended execution needed a place to run that was not the claim pipeline. The claim pipeline now covers everything the connector tier provides — ACP sessions, live events, permission requests, steering commands, worktrees, verification — without Paseo and without the host's credential custody. Running two stacks doubles the settings surface, doubles the failure modes, and keeps a hard integration on an external daemon for the only path that uses it.

This spec collapses the two stacks. **Attended execution becomes a new claim type, `chat`.** Starting work on a task creates a `chat` claim; the assigned agent-server slot holds it as a sticky, interactive session; the dashboard exchanges prompts, permission answers, and steering with it through the claim-scoped tables #127 delivered. When the session ends — explicitly, or by inactivity expiry — the claim terminates and the slot and child process are released, and the workspace is torn down only when it is safe to do so.

Session history is display data rendered from persisted claim events; it survives anything. The model's in-context state dies with the child process; the UI says so honestly instead of fabricating continuity.

## Scope

In scope:

- A `chat` claim type with sticky-session lease semantics: no auto-completion on turn end, explicit end, **activity-based** inactivity expiry (distinct from runner-liveness heartbeat).
- **No automatic redispatch for chat claims** on expiry, failure, or shutdown — the three paths that redispatch work claims.
- Chat claim creation from the task page with a nullable repository, task-scoped identity and uniqueness, and a pending (queue) TTL.
- A dedicated runner chat loop: session opened without an initial prompt, command service alive while idle, exempt from the per-claim execution timeout.
- An `end_session` command kind distinct from `cancel`; chat claims end as `cancelled` with an `end_reason`.
- Interactive command cadence (1 s poll, unchanged from the existing default) and an end-to-end latency target that includes the dashboard's read side.
- Capacity admission control: per-agent `max_chat_slots` (default `capacity − 1`), pending TTL, visible chat/work slot split.
- Project settings collapse: `collab_projects.default_agent_id`, a profile catalog advertised by runners in session metadata, and removal of repository mapping from execution defaults.
- **A re-key stage before any destructive migration**: evidence, artifacts, workpad, summaries, usage samples, and scoped tokens re-keyed from `collab_runs` to claims.
- Deprecation and removal of execution hosts, the connector, repository mappings, and all downstream readers.
- Security/threat-model section for interactive execution on operator infrastructure.

Out of scope:

- Push transport to agent servers (held/short polling is sufficient) and to the browser (SSE to the dashboard is *allowed* by this scope if needed for latency; only agent-server push is excluded).
- Session replay into a fresh ACP session. Context continuity is never reconstructed.
- Multi-participant real-time collaboration on one session (one steered session at a time; capabilities gate who may steer).
- Changes to work-claim lifecycle (`review_fix`, `spec`, `build`) or the verification machine.

## What already exists (verified)

- Claim lease lifecycle: poll → atomic claim → heartbeat (15-minute extension) → result → release; expiry worker and transient-failure redispatch — **which chat claims must be excluded from** (see Lease semantics).
- Claim-scoped interaction tables from #127: `agent_claim_events` (sequence-idempotent, **16 MiB per-claim event budget** — uploads fail beyond it), `agent_claim_requests` (permissions/elicitations), `agent_claim_commands` (idempotency keys, leased delivery, ack/uncertain, terminal cancel in one transaction).
- Runner API: events, requests, command poll (**already polled every 1 s** during a run — `DEFAULT_COMMAND_POLL_MS`), command ack, result with session ownership. Event flush is already 250 ms. The interactive cadence work is therefore "keep the command service alive while the session is idle," not a new cadence.
- Dashboard claim execution panel: streamed messages/thoughts/plans/tool activity/usage, open requests, prompt/cancel/approve/deny controls gated by `run.steer`/`run.cancel`/`internal.read`. Panel currently polls detail/events/requests on a ~3 s cycle.
- ACP runner process model: one direct child, stdio, bounded stderr, no shell, spawn-retry budget, stream redaction of secrets (`createAcpStreamRedactor`).
- Worktree preparation and the deterministic verification machine (#132).
- `collab_claim_executions` task link with `root_claim_id` grouping; start transaction with advisory task lock and idempotency check.

**Does not exist and is new work** (reviews corrected v1 here):

- Project → default-agent routing. `default_agent` is a per-repo notification-routing column; the poll query matches claims to agents by org and repository allowlist only, with no project predicate.
- An agent profile/model catalog. The `agents` table has no profiles; provider and capacity ride in per-session `session_meta`. Profile lists exist only on host mappings (being deleted).
- Repo-less claims. `agent_claims.repo` is `NOT NULL`; attempt allocation, finalize, poll matching, and audit all key on `repo`.
- Prompt-lease rules cited as "#177" in v1: wrong reference. The authoritative rules are the command/lease semantics in the #127 spec (`docs/specs/2026-11-06-acp-claim-runner.md`), which is on `main`.

## Design

### The `chat` claim type

`claim_type` is a text column; `chat` joins `review_fix`, `spec`, and `build`. Two lifecycle rules differ:

1. **No automatic terminal transition.** A work claim completes when its run reports a result. A chat claim stays `claimed` across any number of ACP turns. Each turn ends; the claim does not.
2. **Two clocks, not one** (X1, C2):
   - **`expires_at` + heartbeat** — unchanged; proves the *runner* is alive. A missed heartbeat still expires the claim (crashed host).
   - **`last_activity_at` (new column, new migration)** — updated on prompt queued, command queued/acked, request answered, and streamed event written. The expiry worker ends a chat claim as `cancelled / end_reason: 'idle'` when `last_activity_at < now() − idle_window` (default 15 min, project-configurable). Runner liveness never refreshes it. Whether a running turn suspends the idle window: yes — any streamed event during the turn refreshes it; a turn with zero events for the whole window does not (practically unreachable).

**Chat claims are never redispatched** (X2, C1). All three redispatch paths learn to skip `claim_type = 'chat'`:

- `expireClaimsTick` (expiry worker) — ends the claim instead.
- `handleClaimResult` transient/failed redispatch — a failed chat is terminal; the user starts a new session.
- Runner shutdown reporting `failed`/`transient` — same.

Otherwise an abandoned chat resurrects up to `MAX_RETRY_ATTEMPTS` times, each holding a slot for the idle window. Tests cover each of the three paths.

### Claim creation

The start transaction requires only the task, an Idempotency-Key, and the expected task version, plus:

- **Capabilities:** `run.start` **and** `internal.read` (C16 — transcript visibility requires `internal.read`; start-without-see is a hole).
- **One open chat per task:** inside the same transaction and advisory lock, reject if an open (`pending`/`claimed`) chat exists for the task (C14, X9). Enforced by a partial unique index (below) plus an explicit check for a good error message.

**Identity and uniqueness** (C9, X6 — v1's "via the link table" was not enforceable; no index can span `agent_claims` and `collab_claim_executions`, and `repo` is `NOT NULL`):

- New column `agent_claims.task_id uuid NULL` (migration), set atomically with claim creation for chat claims.
- Partial unique index: `(org_id, task_id) WHERE claim_type = 'chat' AND status IN ('pending', 'claimed')` — mirrors the existing `collab_runs_one_active_per_task` pattern.
- Work-claim uniqueness keeps its existing key; a partial-index audit ensures chat rows are excluded from work-claim constraints and vice versa.
- Attempt allocation and every repo-keyed path are updated for `task_id`-scoped chat rows: the allocator's `repo = $2` lookup, `finalizeClaim`, `resolveGitHubContext`, audit calls. Each changed query is listed in the implementation PR. `pr_number` is already nullable (migration 0004).

**Pending TTL** (C11): a chat claim that sits `pending` longer than 2 minutes (configurable) transitions to `cancelled / end_reason: 'no_capacity'`. The UI shows "waiting for a free slot" with a countdown while pending. Unbounded pending would otherwise be picked up hours later with no user present.

### Runner chat loop

Chat execution is a separate loop in the runner, not a flag on the work loop (C7, X4):

- Opens the ACP session **without** an initial prompt (new `runtime.openSession()`); `prompts.js` gains a `chat` entry in `CLAIM_TYPES`, but chat has no prompt template — the first prompt comes from the user as a command.
- Services commands continuously while the session is open, including when idle (today `serviceCommands` stops once a turn reaches idle with no queued prompts).
- **Exempt from `DEFAULT_EXECUTION_TIMEOUT_MS`** — the 60-minute per-claim execution timeout would kill every long chat. Instead a separate `max_session_duration` cap (default 8 h) ends the claim as `cancelled / end_reason: 'max_duration'`.
- **End vs cancel** (C8, X5): for chat claims, the existing `cancel` command interrupts the current turn only. A new `end_session` command kind (CHECK-constraint migration, Zod union, dashboard control) closes the session. Terminal results use the **existing** statuses — `cancelled` already skips redispatch — with a new `end_reason` field: `'user' | 'idle' | 'no_capacity' | 'max_duration' | 'host_lost'`. No new result status is introduced; result validation, persistence, and client types are updated for the optional field and idempotent repeated ends (including races with expiry).
- Child exit while idle-open is monitored (the runner today only supervises the child during a turn); an idle child exit ends the claim as `failed / end_reason: 'host_lost'` without redispatch.

### Steering latency

- Runner command polling stays at **1 s** (v1's proposed 2 s was a regression against the existing default — C13, X13); event flush stays at 250 ms.
- The target is **end-to-end: user action → first streamed token visible in the panel, p95 ≤ 5 s** (C11, X13 — v1 measured only action→ACP delivery). The dashboard's ~3 s panel polling is inside that budget but is the largest term; if measurements fail the target, the fix is faster polling while a chat panel is open or SSE for dashboard reads — both in scope; agent-server push remains out of scope.
- Distinguish queued receipt from ACP acceptance in the UI (X13), and define busy-turn steering: prompts queue; they apply between turns, acked on ACP acceptance, never silently replayed if uncertain (existing #127 lease semantics).

### Capacity

- **`max_chat_slots` per agent (default `capacity − 1`)**, enforced in `claimPendingWork` (C12, X9): at least one slot always remains available for work claims; review/build never starve behind abandoned chats. Zero disables chats on that agent.
- Slot accounting counts chat claims; the agent page shows `busy: N (chat C / work W)` — new query joining `agent_sessions` to active `agent_claims.claim_type` (C14).
- Resizing while chats are active: capacity shrink never kills live sessions; excess idle chats end at the next idle/`max_duration` boundary (X9).

### Worktrees and safe teardown (X3, C10)

v1's "reuse the worktree for `root_claim_id`" contradicted force-remove teardown. The rule set:

- Chat worktrees are per-claim, on a task branch `ff/task-<task_id>` (checked out; subsequent chat sessions on the same task resume that branch).
- **Release of slot and child process is independent of workspace deletion.** On claim end: reap child, free slot immediately; workspace deletion follows the wrapup safety checks adopted from the connector (`wrapup.js`): clean and pushed → remove; dirty or unpushed → **retain**, record in a task-scoped GC list, and surface in the UI ("unsaved work from session N — push or discard"). Startup cleanup's recursive claim-directory deletion gains the same check.
- Repo-less chats run in a per-claim scratch directory **outside** the shared worktree root (C3), created and GC'd with the claim; contents are never considered safe-by-default and are deleted only on explicit user discard or `max_duration` age.

### Routing

- New column `collab_projects.default_agent_id` and `agent_claims.target_agent_id` (C5, X7); the poll query gains `AND (claims.target_agent_id IS NULL OR claims.target_agent_id = agent.id)`.
- Repo-less eligibility: an agent matches a repo-less chat claim iff `target_agent_id` matches (or is NULL and the agent accepts chats) — repository allowlists do not apply to repo-less rows (X7).
- Offline target agent: the claim stays pending until its TTL expires; **no silent failover** to another agent (X7).
- Execution defaults shrink to: default agent, default profile + model override, default instructions, run summaries. The profile catalog **lives in `session_meta`**, advertised by the runner the same way `supported_claim_types` already is (C6, X8); project default validation checks against the last-advertised catalog, and the model override flows through `agent_claims.payload` into `resolveAcpCommand`. Existing projects' host-mapping defaults are migrated to `default_agent_id` + profile in the re-key stage.

### Security / threat model (C3, X10, X11)

Steering a chat is **code execution on the agent host**. This replaces the connector tier's "credentials and filesystem stay on the user's machine" with operator custody — the trade-off is the point of this spec, but it must be explicit:

- **`run.steer` documentation and capability treatment**: granting `run.steer` to a principal grants the ability to drive an agent holding operator credentials. Client-facing roles do not receive it by default.
- **Per-tenant isolation**: one dedicated agent server per org/client (supported today via #141 self-hosted enrollment) is the isolation boundary. A shared agent server must not serve mutually untrusted orgs: all ACP children run as the same OS user with no per-claim sandbox, and clones share a parent directory. Making shared servers safe (separate OS user/container per claim) is a separate future spec, not assumed here.
- **Repo-less chats get no `githubToken`** in the claim environment.
- **Permission mode**: chat sessions run with the provider's ask/confirm mode; the claim environment's token scope is stated in the agent detail UI.
- **Redaction**: the runner's existing stream redaction covers secrets (C17); only workspace/source path elision is ported from `observation-privacy.js`. Everything else in that module dies with the connector.
- **Delivery-time authorization** (X10): claim commands gain an originator record; leasing revalidates the originator's current capabilities before delivery, including queued prompts and permission answers — the connector tier rechecked authority at delivery and claim commands today check only runner ownership.
- **Credential lifetime** (C12): GitHub installation tokens resolved once at delivery expire (~1 h) while chats run longer. Chat sessions cap at the token TTL unless a token-refresh command is implemented; v1 ships the cap, the refresh command is follow-up.

### Handoff: chat → unattended pipeline

A task in the Ready state keeps its existing **Start** button and behavior: Start goes directly into the unattended pipeline (`spec` → `build` → verification) with no chat involved. Chat is an *optional* front door for work you want to design interactively first; the handoff below covers that path only.

A chat session is a natural place to design work; building it belongs to the unattended flow (`spec` → `build` → verification). Handoff is an explicit, user-driven action with **artifact transfer, not context transfer** — an unattended claim spawns a fresh ACP session, so nothing of the conversation carries over implicitly.

**Trigger.** A "Build this" control on the chat panel (and task page), gated by the same capabilities as starting execution (`run.start`, plus `task.create` on the project when the handoff creates a new task rather than attaching to an existing one). The chat agent may *propose* a handoff as a suggested control; the pipeline is never triggered by the model deciding it should build, and never by free-text intent detection — Ready alone never spends tokens remains the rule.

**What transfers.**

1. **Workspace artifacts.** Chat sessions on repo-linked tasks work on the task branch `ff/task-<task_id>`. Handoff prompts the user to commit pending changes (the safe-teardown checks apply). The unattended `spec`/`build` claims for that task are based on that branch instead of the default branch, so design docs, scaffolding, and edits the chat made are physically present in the build worktree.
2. **A handoff digest.** On handoff, the runner asks the *chat* session (one final ACP prompt) to produce a structured design summary: goal, decisions made, acceptance criteria, open questions, files touched. It lands in the task's description/acceptance criteria and the first `spec` claim payload. This is a fresh summary generated while context is still alive — not a transcript replay into the new session, which stays rejected.
3. **Lineage.** The `root_claim_id` grouping already lets history show chat claim(s) followed by spec/build/verification claims under one task. A `handed_off_from` reference on the first unattended claim records the originating chat claim for audit and UI ("designed in session N").

**Lifecycle.** The chat claim stays open after handoff (the user may keep designing); the new task/claims go through the normal unattended state machine — no special phases, no pinned runner. The build may execute on a different agent server than the chat did; artifacts travel through the git branch and the digest, not session state. If the project has no repository, handoff is unavailable — unattended work claims require a repo; the UI says so rather than creating a repo implicitly.

**Failure semantics.** The unattended claims are ordinary work claims from birth: redispatch, expiry, and retry rules apply in full (unlike chat claims). A failed build does not loop back into the chat automatically; the user may open a new chat session to iterate and hand off again.

### Transcript limits

- The 16 MiB per-claim event budget (X12) becomes a documented session limit: the runner applies backpressure (drops oldest non-terminal verbose events to a stub, keeping prompts, permission requests/answers, and terminal messages) before upload; the UI renders a "transcript truncated" marker. A task-wide view paginates across the chat claims under one `root_claim_id`; event sequences are already claim-scoped.

## Removal of the Paseo tier

Staged; **deletion is gated on the re-key stage, not on one preview cycle** (C15/X15, C16/X14, C4/X9):

1. **Ship chat claims** (additive migrations only: `task_id`, `last_activity_at`, `end_reason`, `end_session` command CHECK, `collab_projects.default_agent_id`, `max_chat_slots`). Task page Start creates a chat claim; the claim panel is the default attended UI. The connector path stays available and is not the opt-out — the opt-in flag is a `collab_projects` column (`execution_mode: 'chat' | 'connector'`, named migration), flipped to `'chat'` for new projects.
2. **Re-key** (separate migration + PR): re-key evidence, artifacts, workpad plans/questions, summaries, usage samples, and scoped tokens from `collab_runs`/`collab_sessions` to `claim_id`/`root_claim_id`; re-bind the collab MCP reporting tools (`report_check`, `add_artifact`, `report_plan`, …) to claim-scoped tokens; migrate or archive historic run transcripts so pre-cutover history survives; migrate project execution defaults.
3. **Freeze**: server-side, `collaboration_start_run`/`collaboration_send_prompt` and the host/mapping write APIs stop accepting new runs/hosts/mappings; existing host executions keep working until drained (active runs complete or are reconciled), connector credentials revoked at drain.
4. **Delete** — gated on: zero active connector runs, re-key migration shipped, historic transcripts archived. The PR removes:
   - `packages/fluent-flow-agent-server/src/connector/*` and the `fluent-flow-connector` bin + `connector.example.json` (C15);
   - `packages/fluent-flow/src/collab/routes-hosts.js`, `packages/db/src/collaboration/hosts.ts`, enrollment/catalog/mapping routes;
   - `collab_sessions`, `collab_connector_commands`, `collab_connector_observations`, and `collab_runs` (after export/backup per the project's destructive-migration policy) (C15);
   - `collaboration_start_run` / `collaboration_send_prompt` MCP tools and the execution-queue path in migration 0013's successors;
   - the execution-hosts section of project settings and the `bootstrap.eligible` host-admin gate;
   - connector tests, fixtures, `redaction-context.js`, and the local-daemon smoke path;
   - run summaries' connector-command implementation, replaced by a claim-command implementation or explicitly cut (X14 — decide in the re-key PR, not silently).
   - `THIRD_PARTY_NOTICES.md` Flowly entries are kept if their adaptations survive in claim-backed UI; dropped if connector-only.

## Failure modes

| Failure | Behavior |
|---|---|
| Agent server crashes mid-chat | Heartbeat expires → claim `cancelled / host_lost` → UI: session ended, transcript preserved, no reconnect, **no redispatch** |
| User abandons session | `last_activity_at` idle window → `cancelled / idle` → slot freed |
| Abandoned while host healthy | Same as above — heartbeat liveness does not keep the claim alive |
| Pending, no slot | Pending TTL (2 min) → `cancelled / no_capacity`, UI offered "retry when free" |
| Provider rate limit / adapter failure | Bounded in-claim recovery; beyond it the claim fails terminally; user starts a new session |
| Uncertain steering command | #127 lease semantics: never silently replayed; user issues a new explicit intent |
| Work claim starvation | `max_chat_slots` reserves ≥ 1 slot for work claims; visible split on the agent page |
| Session exceeds token TTL | Session cap at token lifetime; refresh command is follow-up |
| Long chat exceeds 16 MiB events | Runner backpressure truncates verbose events; UI shows truncation marker |

## Rollout

1. Stage 1 behind the `collab_projects.execution_mode` flag; new projects default `'chat'`.
2. Re-key migration + PR.
3. Freeze; drain; then the delete PR, gated as above. Docs updated at freeze and again at delete.

## Success criteria

- A user can open a task, start a session, exchange prompts/permission answers end-to-end (action → first token visible) in ≤ 5 s p95, and end it; slot released on end; workspace removed only when clean-and-pushed, otherwise retained and surfaced.
- An abandoned chat ends within the idle window on a healthy host and is **never** redispatched (unit tests on all three redispatch paths).
- `max_chat_slots` guarantees ≥ 1 slot for work claims; pending chats expire by TTL.
- Zero Paseo references in `packages/db`, `packages/fluent-flow`, and the dashboard; `src/connector` deleted; every removed collaboration table's dependents re-keyed or archived first.
- Project settings contain no hosts, mappings, or enrollment; profile catalog comes from runner session metadata.
- All existing suites green; new suites cover idle expiry vs. heartbeat, no-redispatch, explicit end idempotency, repo-less chats, capacity admission, pending TTL, and transcript truncation.
