# ACP claim runner implementation plan

**Design:** [ACP claim runner architecture](../specs/2026-11-06-acp-claim-runner.md)

**Goal:** Replace the runner's one-shot vendor command boundary with one owned ACP v2 child per existing claim, persist live ACP interactions, and expose a claim-backed execution panel without changing claim scheduling or adding Paseo behavior.

**Architecture:** Keep `agent_claims`, polling, heartbeat, expiry, redispatch, and phase chaining. Add claim-scoped ACP event/request/command tables and owner-checked APIs. The runner uses the exact-pinned official ACP v2 SDK, a local adapter command, and bounded setup/resume recovery. Collaboration APIs create and list linked claims; the dashboard renders their streamed interactions.

**Runtime:** Node.js ESM, `@agentclientprotocol/sdk@2.4.0`, Zod, raw PostgreSQL/Drizzle conventions already in the repository, Express, React/Next.js, Vitest, Playwright browser fixtures.

## Global constraints

- PR #127 is ACP-only. Do not remove, modify, extend, or document Paseo behavior except for the one task-page integration point needed to mount the ACP claim panel.
- Preserve the existing `agent_claims` scheduling model and all phase transitions.
- One runner executes one active claim and owns one direct ACP child.
- No process scanning, descendants, cgroups, `/proc`, process groups, detached supervisor, host capacity scheduler, or Linux-only API.
- No direct vendor protocol.
- The service never sends an executable, shell fragment, argument vector, or environment value to a runner.
- Use `spawn` with `shell: false`; accept custom adapter commands only from local runner CLI configuration.
- Pin the ACP SDK exactly to `2.4.0`; reject incompatible v2 capabilities instead of downgrading to v1.
- Keep all user-facing errors generic. Log internal detail without secrets.
- Do not add code comments.
- Follow Red → Green → Refactor for every behavioral slice. The orchestrator runs each failing and passing check; editing agents do not run tests, builds, linters, or formatters.
- After each green phase, review the diff and commit that phase before starting a dependent phase.
- New directories require a README.

## Phase 1: persistence and protocol contracts

### Task 1: Add claim interaction persistence

**Files:**
- Create: `packages/db/src/migrations/0022_agent_claim_acp.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/agents.ts`
- Create: `packages/db/src/queries/claim-interactions.ts`
- Modify: `packages/db/src/queries/index.ts`
- Create: `packages/db/tests/migrations/0022-agent-claim-acp.test.ts`
- Create: `packages/db/tests/queries/claim-interactions.test.ts`

**Contract:**

Add `agent_claim_events`, `agent_claim_requests`, `agent_claim_commands`, and the dead-until-used `collab_claim_executions` link exactly as specified in the design. Expose these query functions:

```ts
appendClaimEvents(input: {
  orgId: string;
  claimId: number;
  events: Array<{ seq: number; kind: string; payload: unknown }>;
}, executor?: QueryExecutor): Promise<{ inserted: number; lastSeq: number | null }>

upsertClaimRequest(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
}, executor?: QueryExecutor): Promise<ClaimRequest>

resolveClaimRequest(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  response: unknown;
}, executor?: QueryExecutor): Promise<ClaimRequest | null>

reserveClaimRequestAnswer(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  idempotencyKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
}, executor?: QueryExecutor): Promise<{ command: ClaimCommand; created: boolean } | null>

enqueueClaimCommand(input: {
  orgId: string;
  claimId: number;
  idempotencyKey: string;
  kind: 'prompt' | 'cancel' | 'permission' | 'elicitation';
  payload: unknown;
}, executor?: QueryExecutor): Promise<{ command: ClaimCommand; created: boolean }>

leaseClaimCommands(input: {
  orgId: string;
  claimId: number;
  limit: number;
}, executor?: QueryExecutor): Promise<ClaimCommand[]>

ackClaimCommand(input: {
  orgId: string;
  claimId: number;
  commandId: number;
  status: 'acked' | 'failed' | 'uncertain';
  result: unknown;
}, executor?: QueryExecutor): Promise<ClaimCommand | null>

cancelOpenClaimInteractions(input: {
  orgId: string;
  claimId: number;
}, executor?: QueryExecutor): Promise<void>
```

Every query function accepts an optional `QueryExecutor` compatible with `Pool` or `PoolClient`; omission uses `getPool()`. Terminal claim updates, request-answer reservation, command insertion, and interaction cancellation pass one transaction client.

`appendClaimEvents` ignores exact sequence retries and rejects a sequence reused with different content. Command idempotency compares kind and payload and rejects a reused key with different content. `leaseClaimCommands` uses `FOR UPDATE SKIP LOCKED`, leases only `pending` rows, and marks an expired `delivered` row `uncertain` instead of redelivering it. `reserveClaimRequestAnswer` changes one open request to `answer_queued` and inserts its answer command in the same transaction. A second key returns no reservation. A successful command acknowledgement resolves the request, a definite pre-application failure reopens it, and uncertain delivery marks the request uncertain. Terminal cancellation never changes already acknowledged commands or resolved requests.

**Test-first steps:**

1. Add migration structure and journal tests plus database behavior tests for sequence idempotency, conflicting replay, request replay, atomic answer reservation, same-key body conflicts, pending-only leasing, delivered lease expiry to uncertain without redelivery, acknowledgement, terminal cancellation, and external transaction rollback.
2. Run:

```bash
npm test -w @fluent-flow/db -- tests/migrations/0022-agent-claim-acp.test.ts tests/queries/claim-interactions.test.ts
```

Expected RED: missing migration, schema, exports, and query module.
3. Add the migration, schema, query implementation, and exports.
4. Run the same command. Expected GREEN.
5. Run `bash scripts/check-migrations.sh`.

### Task 2: Add local ACP command and process primitives

**Files:**
- Modify: `packages/fluent-flow-runner/package.json`
- Modify: `package-lock.json`
- Create: `packages/fluent-flow-runner/src/acp/README.md`
- Create: `packages/fluent-flow-runner/src/acp/command.js`
- Create: `packages/fluent-flow-runner/src/acp/process.js`
- Create: `packages/fluent-flow-runner/src/acp/normalize.js`
- Create: `packages/fluent-flow-runner/tests/unit/acp-command.test.js`
- Create: `packages/fluent-flow-runner/tests/unit/acp-process.test.js`
- Create: `packages/fluent-flow-runner/tests/unit/acp-normalize.test.js`
- Create: `packages/fluent-flow-runner/tests/unit/fake-acp-agent.js`

**Contract:**

```js
resolveAcpCommand({ agentType, command, args })
// => { bin, args }

spawnAcpProcess({ bin, args, cwd, env, spawnImpl, stderrLimitBytes })
// => { input, output, stderr, exited, closeInput(), kill(), pid }

normalizeAcpUpdate({ claimId, sessionId, seq, update })
// => { seq, kind, payload }
```

Named mappings are `claude-agent-acp`, `codex-acp`, and `opencode acp`. Unsupported agent types require an explicit local command. No prompt or server value is interpolated into the command. On Windows, direct `.exe` or extensionless executables are used as-is. A known npm `.cmd` shim is resolved through the adjacent installed package's declared `bin` entry and invoked with `process.execPath`; arbitrary `.cmd` wrappers are rejected. `process.js` converts Node streams to Web streams for `acp.ndJsonStream`, caps stderr, reports EOF/error/exit once, closes stdin idempotently, signals only the direct child, and always exposes an awaited exit promise.

Normalization preserves bounded raw data, maps every standard v2 update, retains unknown variants, keys entities by type plus ID, and refuses payloads beyond configured event limits. Before persistence it redacts known bearer/token/key assignments and secret environment-value patterns.

**Test-first steps:**

1. Add exact mapping, custom argument, shell rejection, Windows known-package shim resolution, arbitrary `.cmd` rejection, cross-platform spawn options, bounded stderr, exit, close, direct kill, standard update, chunk-before-full, repeated state, unknown update, secret redaction, and size-limit tests. The Windows test builds a temporary PATH entry with a `.cmd` shim and adjacent package metadata, then proves the resolved command is `process.execPath` plus the package `bin` script.
2. Run:

```bash
npm test -w @fluent-flow/runner -- tests/unit/acp-command.test.js tests/unit/acp-process.test.js tests/unit/acp-normalize.test.js
```

Expected RED: modules and pinned SDK dependency absent.
3. Install the exact dependency with `npm install --save-exact @agentclientprotocol/sdk@2.4.0 -w @fluent-flow/runner`.
4. Implement the modules without a shell or platform-specific process APIs.
5. Run the same command. Expected GREEN.

## Phase 2: ACP session lifecycle

### Task 3: Implement one ACP v2 session with bounded recovery

**Files:**
- Create: `packages/fluent-flow-runner/src/acp/runtime.js`
- Create: `packages/fluent-flow-runner/tests/unit/acp-runtime.test.js`
- Modify: `packages/fluent-flow-runner/tests/unit/fake-acp-agent.js`

**Contract:**

```js
createAcpRuntime({
  command,
  cwd,
  env,
  onEvent,
  onRequest,
  log,
  spawnProcess,
  now,
  timers,
  limits,
})
// => {
//   runInitialPrompt(text),
//   prompt(text),
//   cancel(),
//   answerRequest(requestKey, answer),
//   close(),
//   exited,
// }
```

Use `@agentclientprotocol/sdk/experimental/v2` for JSON-RPC parsing, validation, request handling, and NDJSON transport. Initialization requires the pinned v2 protocol and a non-null session capability. After `session/new`, probe baseline `session/list`; `-32601`, timeout, or an invalid response is incompatibility. Session completion is the next valid transition to idle after foreground work starts, not the prompt response.

Recovery state is explicit:

- setup failed before `session/prompt`: one fresh child and setup retry;
- prompt invoked without `messageId`: uncertain, no replay;
- prompt accepted: remember `messageId` and ACP session ID;
- accepted session loses child: flush buffered events, start one fresh child, and call `session/resume` without replay, never replaying the prompt;
- resumed `running` or `requires_action`: continue live updates;
- resumed `idle` before this connection observes a new running-to-idle transition, resume error, or missing baseline method: transient runtime failure;
- silence threshold: `session/list` liveness request before recovery;
- rolling restart budget: stop spawn loops across claims.

Permission and elicitation handlers persist a request through `onRequest` and hold the ACP response promise until a matching answer, ACP cancellation, claim cancellation, or shutdown. Late and duplicate answers are rejected.

Normal close sends cancel when foreground is active, waits boundedly for idle, sends `session/close`, closes the connection and stdin, waits for the direct child, then signals only that child after the deadline.

**Test-first steps:**

1. Add fake-agent scenarios for initialize, missing session capability, missing `session/list`, new session, ordered updates, permission, elicitation, prompt acceptance, idle completion, cancel, close, clean child exit, hung child, pre-prompt restart, ambiguous prompt, post-acceptance resume without replay, resumed running, resumed idle uncertainty, failed resume, silence liveness, and restart budget.
2. Run:

```bash
npm test -w @fluent-flow/runner -- tests/unit/acp-runtime.test.js
```

Expected RED: runtime absent.
3. Implement the runtime using the official SDK.
4. Run the same command. Expected GREEN.
5. Run Task 2 and Task 3 tests together to catch transport regressions.

### Task 4: Cut the runner over to ACP

**Files:**
- Modify: `packages/fluent-flow-runner/src/client.js`
- Modify: `packages/fluent-flow-runner/src/runner.js`
- Delete: `packages/fluent-flow-runner/src/commands.js`
- Modify: `packages/fluent-flow-runner/src/parse-args.js`
- Modify: `packages/fluent-flow-runner/bin/fluent-flow-runner.js`
- Modify: `packages/fluent-flow-runner/tests/unit/client.test.js`
- Modify: `packages/fluent-flow-runner/tests/unit/cli.test.js`
- Modify: `packages/fluent-flow-runner/tests/unit/runner.test.js`
- Modify: `packages/fluent-flow-runner/tests/unit/reliability.test.js`
- Delete: `packages/fluent-flow-runner/tests/unit/commands.test.js`

**Contract:**

Remove one-shot prompt command execution from the claim path. Keep worktree preparation, claim heartbeat, verdict extraction, result reporting, retry backoff, and shutdown entrypoints.

`createClient` gains:

```js
postClaimEvents(sessionId, claimId, events)
postClaimRequest(sessionId, claimId, request)
pollClaimCommands(sessionId, claimId)
ackClaimCommand(sessionId, claimId, commandId, status, result)
reportClaim({ ..., session_id })
```

`createRunner` injects `createAcpRuntime`, starts one runtime after worktree setup, batches normalized events, services dashboard commands concurrently, and reports the claim only after ACP idle or a classified failure. A completed review claim still derives its verdict from bounded agent text.

| Outcome | Claim result |
| --- | --- |
| `end_turn` | completed |
| user-issued `cancelled` | cancelled, no redispatch |
| `error`, `refusal`, model/token/turn limit | failed terminal |
| local setup, transport, liveness, or resume failure | failed transient |
| process shutdown before completion | failed transient |

CLI changes:

- remove `--command` and reject it with a migration error;
- add `--acp-command` and repeatable `--acp-arg`;
- reject unknown or missing-value flags;
- never accept a server-provided transport command.

**Test-first steps:**

1. Replace direct-spawn assertions with injected ACP runtime assertions. Add event batching, request upload, command polling/acknowledgement, session-owned result, heartbeat, shutdown, review verdict, and every row of the stop-reason table.
2. Add client request contract, `--command` rejection, ACP flag, and CLI validation tests.
3. Run:

```bash
npm test -w @fluent-flow/runner -- tests/unit/client.test.js tests/unit/cli.test.js tests/unit/runner.test.js tests/unit/reliability.test.js
```

Expected RED: ACP methods and flags absent; old direct execution still active.
4. Implement the cutover and delete obsolete prompt-template execution code and tests.
5. Run the same command. Expected GREEN.
6. Run the complete runner unit suite.

## Phase 3: service ownership and claim interactions

### Task 5: Add owner-checked runner interaction routes

**Files:**
- Modify: `packages/fluent-flow/src/agents/claim-manager.js`
- Modify: `packages/fluent-flow/src/routes/runner.js`
- Modify: `packages/fluent-flow/src/notifications/dispatcher.js`
- Create: `packages/fluent-flow/tests/routes/runner-claim-interactions.test.js`
- Modify: `packages/fluent-flow/tests/routes/runner-claim-result.test.js`
- Modify: `packages/fluent-flow/tests/workers/claim-expiry.test.js`
- Modify: `packages/fluent-flow/tests/agents/claim-manager-id-ops.test.js`
- Modify: `packages/fluent-flow/tests/unit/dispatcher.test.js`

**Contract:**

Add `assertClaimOwner({ orgId, agentId, sessionId, claimId })`. It checks token organization, session agent, claimed session, and active claim status. All four new runner endpoints call it before reading or mutating interactions.

Extend claim result validation with required `session_id` and add `cancelled` as a terminal result that does not redispatch. Finalization by ID requires current ownership and cancels open interactions in the same database transaction. Claim expiry cancels open interactions before redispatch. Remove `transportCommand` from long-poll dispatcher payloads and delete its assertion; the service must not send any executable configuration.

Route bodies have Zod size/count limits. Runner-facing errors expose only generic 404, 409, 413, or validation messages.

**Test-first steps:**

1. Add route tests for current ownership, foreign org, another runner session, stale claim, event replay, request replay, command lease/ack, uncertain prompt, body limits, and generic errors.
2. Change claim-result tests to require the current `session_id`, reject cross-session finalization, and preserve user cancellation without redispatch.
3. Add expiry and terminal interaction cancellation tests plus a dispatcher assertion that no executable configuration is sent.
4. Run:

```bash
npm test -w fluent-flow -- tests/routes/runner-claim-interactions.test.js tests/routes/runner-claim-result.test.js tests/workers/claim-expiry.test.js tests/agents/claim-manager-id-ops.test.js
```

Expected RED: routes and ownership checks absent.
5. Implement the ownership helper, routes, finalization transaction, and poll payload cleanup.
6. Run the same command. Expected GREEN.

### Task 6: Create task-linked claims and preserve links across phases

**Files:**
- Create: `packages/db/src/collaboration/claim-executions.ts`
- Modify: `packages/db/src/collaboration/index.ts`
- Modify: `packages/db/src/queries/claims.ts`
- Create: `packages/db/tests/collaboration/claim-executions.test.ts`
- Modify: `packages/fluent-flow/src/agents/claim-manager.js`
- Modify: `packages/fluent-flow/tests/routes/runner-auto-chain-head-sha.test.js`
- Modify: `packages/fluent-flow/tests/workers/claim-expiry.test.js`

**Contract:**

```ts
startCollabClaimExecution(input: {
  actor: CollabActor;
  taskId: string;
  expectedVersion: number;
  idempotencyKey: string;
  repo: string;
  prNumber?: number | null;
  branch?: string | null;
  claimType: 'spec' | 'build';
  instructions?: string;
}): Promise<{ claim: ClaimExecution; created: boolean }>

listCollabClaimExecutions(input: {
  actor: CollabActor;
  taskId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ claims: ClaimExecutionBadge[]; nextCursor: string | null }>

getCollabClaimExecution(input: {
  actor: CollabActor;
  claimId: number;
}): Promise<ClaimExecution>
```

The start transaction checks `collab_idempotency_records` with a canonical request hash; a reused key with different input returns 409. It then locks the task version, validates `run.start`, validates the repository against the task's legacy organization without a host mapping, allocates the next attempt, inserts a pending `agent_claims` row, and inserts its unique `collab_claim_executions` row. It returns the prior claim on exact idempotent replay.

Move pending-claim insertion into `packages/db/src/queries/claims.ts` as `insertPendingClaim(input, executor?)`. Its attempt-allocation mode serializes concurrent creators for `(org, repo, prNumber, claimType)`, selects `max(attempt) + 1`, and retries a no-op conflict before returning. Existing callers that supply an explicit attempt preserve current conflict behavior.

Add an internal transactional follow-on helper in `claim-manager.js`: creating a spec-to-build or retry claim calls `insertPendingClaim` and copies the parent `collab_claim_executions` row to the child in the same transaction. Existing unlinked claims behave unchanged. `claim_id` is an integer and unique, so claim detail routes resolve one task.

Safe badges exclude payload and runner internals. Full detail requires `internal.read`.

**Test-first steps:**

1. Add DB tests for authorization, task version conflict, foreign repo, no host mapping, exact idempotent replay, mismatched-key conflict, concurrent and repeated attempt allocation, atomic execution-link creation, pagination, safe/full projections, and task isolation.
2. Add claim-manager tests that spec-to-build and expiry/transient retry copy the execution link exactly once and roll back both inserts when link creation fails.
3. Run:

```bash
npm test -w @fluent-flow/db -- tests/collaboration/claim-executions.test.ts
npm test -w fluent-flow -- tests/routes/runner-auto-chain-head-sha.test.js tests/workers/claim-expiry.test.js
```

Expected RED: claim execution service and link inheritance absent.
4. Implement the collaboration service and transactional follow-on helper.
5. Run the same commands. Expected GREEN.

### Task 7: Expose collaboration claim execution APIs

**Files:**
- Create: `packages/fluent-flow/src/collab/routes-claim-executions.js`
- Modify: the collaboration route registrar that mounts `registerTaskRoutes` and `registerRunRoutes`
- Create: `packages/fluent-flow/tests/routes/collab-claim-executions.test.js`
- Modify: `packages/fluent-flow/tests/routes/README.md`

**Contract:**

Implement the six collaboration endpoints in the design. Use existing actor middleware and capability checks. Event and request readers join through `collab_claim_executions` and apply current capability projection on every call. Command POST accepts:

```json
{
  "kind": "prompt | cancel | permission | elicitation",
  "payload": {},
  "requestKey": "optional request key"
}
```

It requires `Idempotency-Key`. Permission and elicitation commands reserve the matching open request and insert the answer command in one transaction; a stale or already-reserved request returns 409. Prompt and request bodies have explicit limits. Prompt and answer commands against a pending claim return 409. Cancel against a pending claim atomically marks the claim `cancelled` and cancels open interactions in the same transaction without creating a runner command; cancel against a claimed row creates the ACP command. A replay after capability revocation is denied before returning data.

**Test-first steps:**

1. Add route tests for start, exact replay, mismatched-key conflict, list, detail, event cursor, request cursor, prompt, claimed cancel, pending cancel, pending prompt rejection, permission, elicitation, concurrent answer reservation, stale request, capability revocation, safe projection, generic errors, and limits.
2. Run:

```bash
npm test -w fluent-flow -- tests/routes/collab-claim-executions.test.js
```

Expected RED: route module absent.
3. Implement and mount the routes.
4. Run the same command. Expected GREEN.
5. Run collaboration auth and task route tests to catch route-order or projection regressions.

## Phase 4: dashboard execution surface

### Task 8: Add the claim execution panel

**Files:**
- Create: `packages/dashboard/src/components/collab/task-claim-execution-tab.tsx`
- Modify after the Paseo-removal rebase: `packages/dashboard/src/components/collab/task-detail.tsx`
- Modify: `packages/dashboard/src/lib/collab/types.ts`
- Create: `packages/dashboard/tests/collab/claim-execution.test.tsx`

**Contract:**

Implement the ACP claim panel independently while PR #127 remains based on main. Do not change `task-execution-tab.tsx` or add a runtime compatibility switch. After the separate Paseo-removal branch is available, rebase PR #127 onto it and mount the claim panel from `task-detail.tsx`. PR #127 is not mergeable before that rebase. The panel polls claim lists, selected claim details, event pages, and open requests with `LatestRequest` and `pollResource`.

The start form asks for phase, repository, optional pull request, optional branch, and instructions. It does not expose a host, process, adapter command, profile, or local path.

Render stable entities from event updates. Escape all text, cap terminal rendering, do not render raw HTML, and do not fetch remote content. Controls are shown only when task and current project capabilities agree. Failed submissions retain draft text; successful idempotent acceptance clears it once.

**Test-first steps:**

1. Add component tests for empty, queued, claimed, streaming, idle, failed, paginated, and revoked-access states.
2. Add tests for chunk-before-full, repeated entity updates, unknown events, bounded terminal output, prompt draft retention, idempotent replay, cancel, permission, elicitation, and hidden controls.
3. Run:

```bash
npm test -w @fluent-flow/dashboard -- tests/collab/claim-execution.test.tsx
```

Expected RED: panel and types absent.
4. Implement the types and isolated panel. After the Paseo-removal rebase, switch the task page's execution mount to it.
5. Run the same command. Expected GREEN.
6. Run existing task detail, parity, proxy, and API tests.

### Task 9: Add actual browser and database UAT coverage

**Files:**
- Create: `packages/dashboard/tests/collab/claim-execution-actual.browser.mjs`
- Modify: `packages/dashboard/tests/collab/README.md`
- Reuse: `packages/fluent-flow-runner/tests/unit/fake-acp-agent.js`
- Modify or reuse: collaboration browser fixture helpers already used by `projects-actual.browser.mjs`

**Contract:**

The browser scenario uses a real test database, real dashboard proxy, real service routes, a real runner process, and the deterministic ACP v2 child. It must:

1. create or select a task;
2. start a `spec` claim;
3. observe runner claim pickup and streamed message/tool/plan events;
4. receive a permission or elicitation request;
5. answer it through the UI;
6. send one follow-up prompt;
7. refresh and prove history/request state survives;
8. cancel foreground work;
9. verify database claim, event, request, command, and `collab_claim_executions` rows;
10. capture screenshots for the PR.

The fixture registers agent type `test-acp` and starts the runner with `--acp-command` set to `process.execPath` and one `--acp-arg` pointing to `packages/fluent-flow-runner/tests/unit/fake-acp-agent.js`. No package shim or real model credential is involved in the deterministic scenario.

**Test-first steps:**

1. Add the browser scenario and verify it fails because the complete runtime is not yet wired or a UI state is missing.
2. Run the exact browser command documented in `packages/dashboard/tests/collab/README.md`.
3. Repair only demonstrated integration gaps through their owning earlier task files.
4. Repeat until the browser scenario and database assertions pass.

## Phase 5: release hardening

### Task 10: Document setup and add cross-platform CI

**Files:**
- Modify: `packages/fluent-flow-runner/README.md`
- Modify: `packages/fluent-flow/README.md`
- Modify: `packages/fluent-flow/config/README.md` if it documents server-supplied runner commands
- Modify: root `README.md` only if its runner command is now wrong
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/plans/README.md`

**Contract:**

Document ACP v2, named adapter installation, safe Windows package-bin resolution, local command override, removal of `--command`, Node version, claim lifecycle, web interactions, recovery limits, and generic troubleshooting. Remove documentation that tells a long-poll runner to receive a custom command from server configuration. Keep Paseo docs unchanged because another PR removes them.

Add a package-only CI job for Linux, macOS, and Windows using Node 22. It runs ACP command/process/runtime/runner tests without PostgreSQL services. The existing Linux full-suite job remains.

**Test-first steps:**

1. Add a workflow structure test only if the repository already validates workflows; otherwise validate with the local action parser available in the repo.
2. Run the runner tests selected by the matrix command locally.
3. Update docs and CI.
4. Parse the workflow and run runner typecheck.

### Task 11: Full verification, real adapters, PR evidence, and merge

**No production edits unless a verification failure demonstrates a defect.**

1. Run migration consistency.
2. Run focused DB, runner, service, and dashboard suites from Tasks 1–10.
3. Run all workspace tests from the repository root.
4. Run runner typecheck and every package build used by CI.
5. Run the deterministic end-to-end browser UAT twice from a clean database.
6. Run child-failure UAT:
   - fail before prompt submission;
   - break the connection after prompt submission but before response;
   - break the child after `messageId` and resume;
   - kill the runner and observe claim expiry plus another runner's retry.
7. Inspect the database after each scenario for duplicate events, requests, commands, claims, and `collab_claim_executions` rows.
8. Inspect the host process list only for the runner's known direct child PID during UAT; do not add scanning to product code. Confirm the direct child exits after completion and shutdown.
9. Run installed `claude-agent-acp`, `codex-acp`, and `opencode acp` through initialize/new/prompt/update/close when local credentials and binaries are available. Record unavailable adapters as explicit release limits.
10. Capture the actual task page states: queued, streaming, permission/elicitation, completed, failed/recovered, and refreshed history.
11. Request independent code-quality and security/spec reviews from different model families. Repair every actionable finding through a new test-first task and repeat the affected verification.
12. Update PR #127 title and body with the ACP-only architecture, exact test and UAT commands, screenshots, database evidence, adapter results, limitations, and the separate Paseo-removal dependency.
13. Force-push the rebuilt branch only after all green checks. Wait for GitHub CI. Merge only when required checks pass and the separate Paseo removal/rebase order is resolved.

## Review focus

Reviewers must verify:

- Claim scheduling and cross-runner phase routing are unchanged.
- The runner owns one direct child and never inspects or controls descendants.
- Adapter commands are local only and use no shell.
- ACP v2 version/capability gating is fail-closed.
- Prompt insertion ambiguity never triggers same-claim replay.
- Accepted prompts are resumed, never replayed, after local child failure.
- Restart budgets and liveness checks cannot create spawn loops.
- Shutdown awaits direct-child exit on all supported platforms.
- Runner endpoints require token, session, claim, and active ownership.
- Event and command replay are idempotent and bounded.
- Permission/elicitation responses cannot be answered twice or after cancellation.
- Collaboration projections respect current capabilities on initial and replay paths.
- Agent-authored text cannot execute HTML, scripts, or remote fetches.
- Follow-on claims preserve task links transactionally.
- No Paseo compatibility or removal work leaked into PR #127.
