# ACP claim runner architecture

**Status:** Approved for PR #127

## Purpose

Fluent Flow needs interactive agent execution without making the service or runner depend on one model vendor, one operating system, or host-wide process supervision.

The existing claim state machine remains authoritative. A task phase is an `agent_claims` row. Any compatible runner may claim it, prepare its repository, execute it, and report the result. Claim heartbeat, expiry, transient-failure redispatch, spec-to-build chaining, and later verification phases keep their current responsibilities.

The runner changes only at the agent execution boundary. For one active claim, it launches one local Agent Client Protocol v2 process over standard input and output, creates one ACP session, forwards the task prompt, streams normalized updates to Fluent Flow, handles user requests and controls, closes the session, and reaps the direct child.

## Scope

PR #127 delivers:

- ACP v2 execution for the existing claim runner.
- One active claim and one direct ACP child per runner.
- Named local adapters for Claude, Codex, and OpenCode, plus an explicit local command override.
- Live messages, reasoning, plans, tool calls, terminals, notices, usage, permissions, and elicitations in the web application.
- Bounded local recovery for ACP process failures.
- Claim-scoped event, request, and command persistence.
- Claim-backed collaboration execution controls and history.
- Cross-platform tests on Linux, macOS, and Windows.

## Non-goals

- Replacing or extending the claim scheduler.
- Pinning a phase to the runner that executed an earlier phase.
- Starting more than one claim in a runner.
- Managing descendants of the ACP child.
- Process groups, cgroups, `/proc`, host-wide process scans, capacity scheduling, detached supervisors, or private supervisor IPC.
- Direct Claude stream-json, Codex app-server, or other vendor protocols.
- Sending executable paths or shell commands from the service to a runner.
- Removing Paseo. Paseo removal is a separate PR. This PR does not add Paseo compatibility behavior and keeps its ACP surface isolated from the existing Paseo implementation.

## Existing claim lifecycle

The scheduling model does not change:

1. Fluent Flow creates a pending claim for a phase.
2. An eligible runner atomically claims it through the existing poll route.
3. The runner refreshes its session and claim heartbeat while work is active.
4. The runner reports completion or failure with its session identity.
5. A completed `spec` claim may create the existing `build` follow-on claim.
6. A transient failure or expired heartbeat creates the existing next-attempt claim, subject to the current retry cap.
7. Any eligible runner may execute the follow-on claim.

A runner process failure is not an ACP recovery mechanism. The runner's claim heartbeat expires and the existing service redispatches the claim.

## Runner process model

The runner is a Node.js process that runs on any supported Node platform. It owns only the child returned by `child_process.spawn` for the active claim.

The runner:

- uses `shell: false`;
- inherits the runner environment without accepting process configuration from the server;
- connects the child's stdout and stdin to the official ACP SDK;
- captures bounded stderr as diagnostic output;
- never enumerates or signals descendants;
- sends cancel and close through ACP before closing stdin;
- waits for the direct child to exit;
- signals only that direct child after the shutdown deadline;
- always awaits the child's exit before finishing claim cleanup.

The repository worktree remains claim-local. A later phase or retry may run on another host and prepares its own checkout from the repository, pull request, branch, and claim payload.

## Local adapter selection

Adapter selection is local runner configuration.

| Runner agent type | Local command |
| --- | --- |
| `claude-code` or `claude-agent-acp` | `claude-agent-acp` |
| `codex` or `codex-acp` | `codex-acp` |
| `opencode` | `opencode acp` |
| other | explicit `--acp-command` and repeated `--acp-arg` values |

On Windows, the runner resolves a native executable directly. For the known npm adapters, it may resolve the adjacent installed package's declared JavaScript `bin` entry and invoke it with `process.execPath`. It does not execute `.cmd` wrappers or use `cmd.exe`. A custom `.cmd` path is rejected; the operator supplies `process.execPath` and the adapter's JavaScript entry point explicitly.

The service sends the logical agent type and claim payload. It never sends an executable, argument vector, shell fragment, or environment variable.

## ACP compatibility contract

The runner pins `@agentclientprotocol/sdk` to `2.4.0` and imports `@agentclientprotocol/sdk/experimental/v2`.

Startup must complete ACP initialization before session setup. The runner requires the pinned protocol version and a non-null ACP session capability. ACP v2 defines `session/list`, `session/resume`, and `session/close` as baseline methods for an agent with session capability rather than independently advertised flags. The runner probes `session/list` after session creation and treats `-32601` or an invalid response as incompatibility. A missing or invalid `session/resume` response during recovery is a recovery failure; it is never replaced with prompt replay.

The compatibility gate reports a generic claim failure to the service and detailed diagnostics only in runner logs.

Each claim uses:

1. `initialize`;
2. `session/new` with the absolute worktree path and no server-supplied MCP configuration;
3. `session/prompt` with one non-empty text block;
4. `session/update` until an idle state ends foreground work;
5. `session/close` during cleanup.

`session/prompt` acceptance is the returned `messageId`. It is not completion. Completion comes from an idle `state_update`. Repeated state snapshots are applied idempotently.

## Normalized event model

The runner preserves the raw ACP update in a bounded payload and adds stable fields used by the application:

- `user_message`
- `agent_message`
- `agent_thought`
- `state`
- `tool_call`
- `tool_output`
- `terminal`
- `terminal_output`
- `plan`
- `commands`
- `config`
- `session_info`
- `usage`
- `notice`
- `compaction`
- `unknown`

Entity identity is `(claim, ACP entity type, ACP entity ID)`. Chunks may arrive before full updates and must create the entity in receive order. Later updates patch the entity without moving it. Unknown extensions are stored and rendered generically. Live notices are not treated as durable conversation history after replay.

Per-event and per-claim byte limits are enforced before persistence. Secret-looking values and internal exception details are not placed in public event payloads. The dashboard renders text, structured fields, and bounded terminal output without raw HTML or automatic remote resource loading.

## Interaction persistence

Four additive tables are introduced. Existing `agent_claims` columns and scheduling queries do not change.

### `agent_claim_events`

Ordered, immutable events emitted by the active runner:

- `org_id`
- `claim_id`
- `seq`
- `kind`
- `payload`
- `created_at`

`(org_id, claim_id, seq)` is unique. A retried batch is idempotent.

### `agent_claim_requests`

Open and resolved ACP permission or elicitation requests:

- `org_id`
- `claim_id`
- `request_key`
- `kind`
- `payload`
- `status`
- `response`
- `created_at`
- `resolved_at`

`(org_id, claim_id, request_key)` is unique. A cancelled ACP request is terminal and cannot accept a later answer.

### `agent_claim_commands`

Dashboard controls delivered to the active runner:

- `org_id`
- `claim_id`
- `idempotency_key`
- `kind`
- `payload`
- `status`
- `result`
- `created_at`
- `delivered_at`
- `acked_at`

`(org_id, claim_id, idempotency_key)` is unique. Statuses are `pending`, `delivered`, `acked`, `failed`, `uncertain`, and `cancelled`. Reusing an idempotency key with a different command body is a conflict.

Only `pending` commands are leased. A delivered command is never delivered a second time. If its acknowledgement deadline expires, it becomes `uncertain`; the user may issue a new explicit intent, but the service never silently replays the old prompt or answer.

Queueing a permission or elicitation answer atomically reserves the corresponding open request. A second answer cannot be queued with another idempotency key. Successful acknowledgement resolves the request, definite pre-application failure reopens it, and uncertain delivery makes it terminally uncertain.

A claim's terminal transition cancels its unresolved requests and undelivered commands in the same database transaction. Redispatch creates a new claim and never carries interactive commands into the new attempt.

### `collab_claim_executions`

The collaboration-owned, unambiguous task link:

- `task_id`
- `project_id`
- `claim_id`
- `root_claim_id`
- `created_by_principal_id`
- `created_at`

`claim_id` is unique. Follow-on phases and retries point to the original `root_claim_id` while receiving their own rows.

## Runner API

All runner interaction endpoints use the existing agent bearer token. Every request includes `session_id`. Authorization requires that:

- the token organization owns the claim;
- the session belongs to the token's agent;
- the claim is `claimed` by that session;
- the claim has not reached a terminal state.

Foreign and missing claims return a generic 404. Stale ownership returns 409. Internal identifiers and authorization detail are logged server-side only.

Endpoints:

- `POST /api/runner/claims/:claimId/events`
- `POST /api/runner/claims/:claimId/requests`
- `POST /api/runner/claims/:claimId/commands/poll`
- `POST /api/runner/claims/:claimId/commands/:commandId/ack`

Event writes are batched and sequence-idempotent. Command polling leases pending commands. A runner acknowledges each command as accepted, failed, or uncertain. An uncertain prompt is never redelivered within the same claim.

The existing claim result request gains `session_id`; completion by claim ID requires current ownership. This is a clean runner cutover, not a compatibility shim.

## Dashboard API

Claim execution uses collaboration authorization and a dedicated `collab_claim_executions` link whose `claim_id` is unique. The existing manual `collab_delivery_links` resource remains unchanged for the separate Paseo-removal work.

- `POST /collab/v1/tasks/:taskId/claim-executions`
- `GET /collab/v1/tasks/:taskId/claim-executions`
- `GET /collab/v1/claim-executions/:claimId`
- `GET /collab/v1/claim-executions/:claimId/events`
- `GET /collab/v1/claim-executions/:claimId/requests`
- `POST /collab/v1/claim-executions/:claimId/commands`

Starting execution requires `run.start`, an `Idempotency-Key`, the expected task version, a repository in the task's legacy organization, and an explicit `spec` or `build` phase. The repository check does not require a Paseo host mapping. The transaction verifies the idempotency request hash, allocates the next unused attempt for the repository, pull request, and claim type, then creates the claim and execution link atomically. Concurrent claim creators use the same allocation helper.

A follow-on or retry claim inherits the task execution link in the same transaction as claim creation. Each claim belongs to at most one task execution, so claim detail routes are unambiguous. History shows each phase and attempt as a separate claim.

Task readers receive a safe claim badge. Detailed ACP events and requests require `internal.read`. Prompt and request answers require `run.steer` plus `internal.read`. Cancel requires `run.cancel` plus `internal.read`.

Lists use stable cursor pagination. Command creation is idempotent. Public errors are generic and contain no environment names, paths, command lines, tokens, database details, or adapter diagnostics.

## Dashboard behavior

The task page gains an ACP claim execution panel without extending the Paseo run model.

It shows:

- phase, attempt, status, runner state, and timestamps;
- streamed messages and thoughts;
- plans, tool activity, terminal output, notices, and usage;
- open permission and elicitation requests;
- prompt, cancel, approve, deny, and structured-answer controls allowed by current capabilities.

The UI does not advertise provider-specific steering semantics. Sending a prompt means submitting an ACP prompt to the active session. Cancel means ACP `session/cancel` for foreground work. A later claim phase is still selected by the service state machine, not by the runner.

The claim panel replaces the task page's old execution mount only after PR #127 is rebased onto the separate Paseo-removal branch. Until that dependency is available, the new component remains isolated and PR #127 is not mergeable. The removal branch owns deletion of the Paseo component; PR #127 does not add a compatibility switch.

## Fault handling and recovery

### Before prompt submission

Initialization and `session/new` failures definitely occur before prompt insertion. The runner may restart the child and retry setup once. A runner-wide rolling restart budget stops repeated spawn loops across claims.

### Prompt acceptance uncertain

Once the runner invokes `session/prompt`, a connection failure before a valid `messageId` makes insertion ambiguous. The runner does not submit the prompt again in that claim. It records an uncertain event and reports transient claim failure.

### After prompt acceptance

After a valid `messageId`, the runner never replays that prompt. If the child fails, the runner may start one replacement child, initialize it, and call `session/resume` with the existing ACP session ID and no history replay request. Buffered live updates are flushed before recovery. The mandatory current-state snapshot synchronizes liveness but is not a new completion.

If the resumed snapshot is `running` or `requires_action`, the runner continues consuming live updates. If it is `idle` before this connection observes a new running-to-idle completion, the outcome of the accepted prompt is unknown; the runner records recovery uncertainty and reports transient claim failure rather than hanging or inferring success. Any resume error has the same transient result. The service's existing redispatch creates a new claim attempt.

### Liveness

Update silence alone is not failure. After the configured silence interval, the runner calls `session/list`. A valid response proves the connection is responsive. Failure or timeout enters the same bounded recovery path. The runner does not inspect host processes.

### Shutdown

For an active foreground turn, shutdown sends `session/cancel`, waits for the idle cancellation state up to a deadline, calls `session/close`, closes the protocol connection and stdin, waits for the direct child, and then signals only that child if necessary. The claim is reported transiently failed if normal completion did not finish.

## Security boundaries

- Adapter commands are local configuration only.
- Child processes use argument arrays and `shell: false`; known Windows npm shims resolve to their package `bin` entry and run through `process.execPath`.
- Runner tokens and model credentials are never stored in events or logs. Event normalization redacts known secret assignments and token patterns before persistence. Permission and elicitation answers are stored only in the private request/command tables needed to deliver them and are not copied into public events or logs.
- Runner endpoints require token, session, and claim ownership.
- Dashboard endpoints apply current project capabilities on every request and replay.
- Prompt, response, event, and terminal payloads have explicit size limits.
- Rich content is rendered as data, not executable markup.
- Filesystem and network tool behavior remains the ACP agent's local policy. Fluent Flow does not grant additional host access.

## Acceptance criteria

1. Linux, macOS, and Windows package tests prove spawn, streaming, cancel, close, timeout, and direct-child reaping without platform-specific process APIs.
2. A deterministic ACP v2 child completes a claim and produces ordered web-visible events.
3. Permission and elicitation requests survive page refresh, accept one answer, and reject stale answers.
4. Prompt command acceptance returns one `messageId`; retries with one idempotency key do not insert duplicate commands.
5. A pre-prompt child failure restarts once and submits once.
6. An ambiguous prompt failure is not replayed in the same claim.
7. A post-acceptance child failure resumes once and never replays the accepted prompt.
8. A failed resume reports transient failure and existing claim redispatch can be claimed by another runner.
9. Killing the runner lets the existing heartbeat expiry and retry path recover the claim.
10. No ACP code scans processes, uses cgroups or `/proc`, creates process groups, or signals anything except its direct child.
11. The service never sends executable configuration to the runner.
12. Browser UAT starts a claim, observes streaming, answers a request, sends a prompt, cancels foreground work, and verifies resulting database rows.
13. Named Claude, Codex, and OpenCode adapters pass the compatibility gate when installed; unavailable local credentials are reported as an external UAT limit, not hidden by a fake success.
