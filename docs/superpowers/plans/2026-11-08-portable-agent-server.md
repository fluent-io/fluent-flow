# Portable Fluent Flow Agent Server Implementation Plan

> **For agentic workers:** Use subagent-driven development task by task. The current runner and ACP runtime are production code to preserve, not replace.

**Goal:** Replace the single-slot runner executable with one portable agent server that reuses the current ACP claim executor and runs a bounded number of independent claim slots locally, on a self-hosted VM, or in a hosted organization-scoped container.

**Architecture:** Keep the existing durable claim queue, `FOR UPDATE SKIP LOCKED` assignment, ACP v2 runtime, event streaming, permission and elicitation bridge, follow-up command handling, and result semantics. One agent-server process creates `capacity` existing `createRunner()` instances. Each instance registers one existing control-plane session and owns at most one active claim. Add single-use enrollment, safe concurrent Git/worktree behavior, aggregate health, dashboard capacity, and a prebuilt image.

**Tech Stack:** Node.js 20+ ESM, existing `@agentclientprotocol/sdk` 2.4.0 experimental v2 runtime, Express, Zod, PostgreSQL/Drizzle, pino, Vitest, Docker, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-11-08-portable-agent-server-design.md`

## Global constraints

- No comments may be added to code.
- ESM imports and exports only.
- Use Zod for every new HTTP and CLI input shape.
- Reuse `createRunner`, `src/acp/**`, claim event/request/command routes, and current result mapping.
- Do not create a second ACP client, scheduler, executor, slot abstraction, or provider protocol.
- Use pino structured JSON logs; never log prompts, raw ACP content, credentials, enrollment tokens, durable control-plane tokens, or GitHub tokens.
- ACP child processes receive an allowlisted environment, never `process.env` wholesale.
- Custom ACP commands remain executable-plus-argument arrays with `shell: false`.
- Default capacity is `2`; accepted range is `1..16`.
- One agent-server instance is scoped to one organization and one logical agent profile.
- One existing runner instance is one capacity slot, one control-plane session, and at most one active claim.
- Keep the current claim TTL, retry cap, interaction, transient-failure, verification, and claim-ID idempotency semantics.
- No database migration. Enrollment uses existing token columns; capacity uses `agents.transport_meta` and `agent_sessions.session_meta`.
- Clean user-facing cutover: no `@fluent-flow/runner`, `fluent-flow-runner` executable, or `/api/runner` route remains. Preserve the separate `fluent-flow-connector` binary and connector behavior in the renamed package.
- Hosted infrastructure supplies one organization-scoped container and read-only secret files. This package does not implement a cloud scheduler.
- Red-green-refactor. Every behavior change must have a failing behavioral test observed before production code.

## Review focus

1. Capacity `2` starts exactly two claims and leaves a third pending until a slot frees.
2. Current ACP streaming, permission/elicitation requests, follow-up commands, recovery, verification, and result behavior remain intact.
3. Two slots cannot race shared clone/fetch/worktree operations or persist GitHub credentials in remotes/config.
4. `claim: null` from heartbeat cancels the owning ACP runtime, cleans up, and submits no duplicate result.
5. Two exchanges of one enrollment credential create exactly one durable runtime token.
6. Enrollment credentials cannot authenticate directly to normal agent-server routes.
7. Child environments, logs, status, Git remotes, and result payloads exclude control-plane and provider secrets.
8. The existing connector binary and connector tests remain available after package rename.

## File structure

| File | Responsibility |
|---|---|
| `packages/fluent-flow-agent-server/src/runner.js` | Existing one-claim ACP execution slot, hardened for multi-instance use |
| `packages/fluent-flow-agent-server/src/acp/**` | Existing ACP v2 process/session, interaction, recovery, and normalization code |
| `packages/fluent-flow-agent-server/src/worktree.js` | Claim-ID worktrees, keyed repository lock, ephemeral Git authentication |
| `packages/fluent-flow-agent-server/src/environment.js` | Selected-provider secret loading and child environment allowlist |
| `packages/fluent-flow-agent-server/src/state.js` | Stable instance ID and private durable control-plane token |
| `packages/fluent-flow-agent-server/src/config.js` | Zod CLI/environment configuration |
| `packages/fluent-flow-agent-server/src/server.js` | Own N existing runner instances and aggregate lifecycle/status |
| `packages/fluent-flow-agent-server/src/health-server.js` | Private `/healthz` and `/status` endpoints |
| `packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js` | Enrollment, startup, signal handling, and process exit |
| `packages/fluent-flow-agent-server/bin/fluent-flow-connector.js` | Preserved Paseo connector binary |
| `packages/fluent-flow/src/routes/agent-server.js` | Enrollment plus renamed existing claim/session/interaction routes |
| `packages/db/src/queries/tokens.ts` | Atomic enrollment issuance and exchange |
| `packages/db/src/queries/agents.ts` | Capacity/session aggregation |
| `packages/dashboard/src/app/api/agents/route.ts` | Agent creation and one generated enrollment command |

---

### Task 1: Clean package and API naming cutover

**Files:**
- Move `packages/fluent-flow-runner/` to `packages/fluent-flow-agent-server/`.
- Move `packages/fluent-flow/src/routes/runner.js` to `packages/fluent-flow/src/routes/agent-server.js`.
- Move runner route tests to matching agent-server names.
- Move `.github/workflows/release-runner.yml` to `.github/workflows/release-agent-server.yml`.
- Modify `packages/fluent-flow-agent-server/package.json`, `packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js`, `packages/fluent-flow-agent-server/src/client.js`, `packages/fluent-flow/src/app.js`, application Dockerfiles, CI workflow, and `package-lock.json`.

**Contract:**
- Package: `@fluent-flow/agent-server`, version `0.2.0`.
- Primary binary: `fluent-flow-agent-server`.
- Preserve binary: `fluent-flow-connector`.
- Route prefix: `/api/agent-server/*`; no `/api/runner/*` alias.
- Preserve every current claim event, request, command, heartbeat, poll, and result route under the new prefix.

**TDD and implementation:**
1. Change current client tests to expect `/api/agent-server/*`; add an application route test proving the new register route is mounted and the old route is `404`.
2. Run the focused tests and observe failures against old paths.
3. Use Git moves for package, CLI, route, route tests, and release workflow.
4. Rename package metadata, imports, workflow references, workspace paths, and current runtime identity strings. Preserve connector files and bin entry.
5. Regenerate only lockfile workspace metadata.
6. Run the complete renamed package test suite and focused server route suite.

**Verification:**
```bash
npm test --workspace packages/fluent-flow-agent-server
npm test --workspace packages/fluent-flow -- --run tests/routes/agent-server-heartbeat.test.js tests/routes/agent-server-claim-result.test.js tests/routes/agent-server-poll-hint.test.js tests/routes/agent-server-verdict-fallback.test.js tests/routes/agent-server-paths.test.js
npm run typecheck --workspace packages/fluent-flow-agent-server
```

---

### Task 2: Single-use enrollment and private state

**Files:**
- Modify `packages/db/src/queries/tokens.ts`, `packages/db/src/queries/agents.ts`, `packages/db/src/index.ts`, and their tests.
- Modify `packages/fluent-flow/src/agents/token-manager.js` and `packages/fluent-flow/src/routes/agent-server.js`.
- Create `packages/fluent-flow/tests/routes/agent-server-enroll.test.js` and a live transaction integration test.
- Create `packages/fluent-flow-agent-server/src/state.js` and tests; modify client tests.

**Contract:**
- Enrollment plaintext format is distinct from normal `ff_` tokens and cannot pass `validateToken()`.
- `POST /api/agent-server/enroll` accepts only Bearer enrollment credential plus `{instance_id}`.
- One transaction atomically consumes an unexpired `enrollment:` row and inserts one normal durable `ff_` token.
- Concurrent exchange has one winner; the loser gets one generic consumed/invalid response without row-detail leakage.
- Runtime token is returned once, stored atomically with mode `0600`, and never passed to ACP children.
- Dashboard agent plus enrollment issuance is atomic or fails loudly without leaving a partially created agent.

**TDD and implementation:**
1. Add failing DB tests for issuance, valid exchange, concurrent exchange, expired/revoked/non-enrollment credentials, insertion rollback, and enrollment-prefix rejection by normal validation.
2. Observe RED against missing functions.
3. Implement transaction-composable hashing/generation and atomic issue/exchange using existing columns only.
4. Add failing endpoint tests for validation, generic auth failures, success, replay, expiry, and bounded per-peer attempts.
5. Implement enrollment before durable-token middleware. Reuse existing request body limits and a bounded local attempt map; never trust forwarded peer headers.
6. Add failing state tests for stable UUID, missing token, atomic write, mode `0600`, and malformed state fail-fast.
7. Implement state and `client.enroll()`; erase the enrollment value after successful persistence.

**Verification:**
```bash
npm test --workspace packages/db -- --run tests/queries/tokens.test.ts tests/queries/agents.test.ts
npm test --workspace packages/fluent-flow -- --run tests/routes/agent-server-enroll.test.js
npm test --workspace packages/fluent-flow-agent-server -- --run tests/unit/state.test.js tests/unit/client.test.js
```

---

### Task 3: Harden the existing runner for concurrent instances

**Files:**
- Modify `packages/fluent-flow-agent-server/src/runner.js`.
- Modify `packages/fluent-flow-agent-server/src/worktree.js`.
- Create `packages/fluent-flow-agent-server/src/environment.js`.
- Modify `packages/fluent-flow-agent-server/tests/unit/runner.test.js` and `worktree.test.js`.

**Contract:**
- Preserve the current ACP v2 runtime and all interaction/verification behavior.
- `createRunner` rejects fatal errors; it never calls `process.exit`.
- `createRunner` accepts an explicit allowlisted child environment and per-slot metadata.
- Heartbeat `claim: null` cancels the current runtime, drains existing command/event paths, cleans the worktree, and reports no second terminal result.
- Worktrees use claim ID, repository inputs cannot escape the work root, and clone/fetch/add/prune operations are serialized per repo.
- GitHub credentials are claim-scoped environment values; remotes, arguments, config, and logs contain no token.
- The keyed repository lock is released before ACP work.

**TDD and implementation:**
1. Add failing tests for no process exit, explicit environment isolation, ownership-loss cancellation/no-report, claim-ID paths, repo traversal, same-repo serialization, different-repo concurrency, and credential-free remotes.
2. Observe RED against current process exit, heartbeat, worktree, and credential behavior.
3. Add the smallest environment builder and inject it into existing runner/runtime calls.
4. Replace shared `gh auth login` and credential-bearing remote URLs with ephemeral environment-backed Git credentials.
5. Add one keyed promise lock inside `worktree.js`; keep the current execution and cleanup flow.
6. Pass claim ID to the existing worktree function and preserve all current claim types and interaction loops.

**Verification:**
```bash
npm test --workspace packages/fluent-flow-agent-server -- --run tests/unit/runner.test.js tests/unit/worktree.test.js tests/unit/acp-runtime.test.js tests/unit/acp-normalize.test.js
```

---

### Task 4: Capacity server, configuration, health, and smoke

**Files:**
- Create `packages/fluent-flow-agent-server/src/config.js`, `server.js`, and `health-server.js`.
- Rewrite `packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js`.
- Create `packages/fluent-flow-agent-server/tests/unit/server.test.js` and `scripts/smoke.mjs`.

**Contract:**
- `createAgentServer` constructs exactly `capacity` existing runner instances.
- Each slot registers distinct session metadata containing one stable `instance_id`, `slot_id`, capacity, version, provider, and deployment mode.
- Default capacity `2`; bounds `1..16`.
- Startup resolves durable token or exchanges enrollment once before creating slots.
- Shutdown is idempotent, stops new polls, and awaits all runner shutdowns once.
- `/healthz` and `/status` expose only provider, instance ID, capacity, active count, online slots, and `healthy|degraded|unhealthy`.
- One slot failure degrades the server without killing healthy slots. CLI owns process exit and signal handling.

**TDD and implementation:**
1. Add failing Zod config tests for defaults, bounds, URL, token-source precedence, provider secret path, work/state paths, and private health bind.
2. Add failing server tests using barriers: capacity two starts two claims; third stays pending; distinct sessions; one slot failure does not stop the other; shutdown runs once.
3. Add failing health tests for redacted healthy/degraded/unhealthy output.
4. Implement the thin runner factory loop, aggregate getters, config, health server, and CLI. Do not move claim execution out of `runner.js`.
5. Build a fake control plane plus existing fake ACP child smoke: three claims, two overlapping, one ownership cancellation, third starts after release, no duplicate result, distinct sessions/worktrees, no secret in logs/remotes.

**Verification:**
```bash
npm test --workspace packages/fluent-flow-agent-server -- --run tests/unit/server.test.js tests/unit/config.test.js tests/unit/health-server.test.js
npm run smoke --workspace packages/fluent-flow-agent-server
npm test --workspace packages/fluent-flow-agent-server
```

---

### Task 5: Dashboard enrollment and capacity visibility

**Files:**
- Modify `packages/dashboard/src/app/api/agents/route.ts`, `new-agent-dialog.tsx`, `agent-table.tsx`, and API tests.
- Modify `packages/db/src/queries/agents.ts`, schemas, and query tests.

**Contract:**
- Setup accepts provider `claude-code|codex`, capacity `1..16`, and deployment `local|self_hosted`.
- Response remains `201 {agent, command}` plus enrollment expiry if needed; no second plaintext token field.
- Local command uses the npm package. Docker command uses the GHCR image and a read-only provider secret file without embedding provider credentials.
- List/detail DTOs expose `active_slots`, `capacity`, and deployment mode, scoped by organization.
- Status is `busy` if any live slot is busy, `online` if live slots exist, otherwise `offline`.

**TDD and implementation:**
1. Add failing API tests for authorization, input bounds, supported providers, 15-minute enrollment, command shape, no provider secret, and loud rollback failure.
2. Observe RED against the current one-year runtime token command.
3. Implement validated creation using Task 2 atomic issuance.
4. Add failing query/schema tests for org-scoped live slot aggregation and configured-capacity fallback.
5. Implement one bounded lateral aggregate; no migration.
6. Update the dialog and table using existing component patterns. Never display provider credential names or secret-store internals.
7. Verify actual Local and Docker creation flows in a browser.

**Verification:**
```bash
npm test --workspace packages/db -- --run tests/queries/agents.test.ts
npm test --workspace packages/dashboard -- --run tests/api/agents.test.ts tests/api/agent-detail.test.ts
npm run build --workspace packages/dashboard
```

---

### Task 6: Prebuilt image and release pipeline

**Files:**
- Rewrite `packages/fluent-flow-agent-server/Dockerfile` and package Compose example.
- Modify package scripts.
- Rewrite `.github/workflows/release-agent-server.yml`; modify `.github/workflows/ci.yml`.
- Modify root `docker-compose.yml`; create root `.dockerignore`.

**Contract:**
- Publish `@fluent-flow/agent-server` and `ghcr.io/fluent-io/fluent-flow-agent-server`.
- Image contains pinned runtime dependencies and provider adapters; no startup installs.
- Run as non-root UID 1000 with `/work` and private state volumes.
- Provider and durable control-plane credentials are read-only files from deployment secrets.
- No Docker socket, source checkout, external Fluent Flow network, or default secret value.
- Release builds and smokes amd64 before publishing amd64/arm64 manifests.

**TDD and implementation:**
1. Add `smoke:image` by reusing Task 4’s smoke scenario with `AGENT_SERVER_IMAGE`.
2. Rewrite image and Compose examples around the published image and secret files.
3. Run local image smoke and Compose rendering.
4. Implement release workflow with least GitHub permissions and post-publish manifest verification.
5. Add optional root Compose profile for hosted operation using the same image contract.

**Verification:**
```bash
docker build -f packages/fluent-flow-agent-server/Dockerfile -t fluent-flow-agent-server:test .
AGENT_SERVER_IMAGE=fluent-flow-agent-server:test npm run smoke:image --workspace packages/fluent-flow-agent-server
docker compose -f packages/fluent-flow-agent-server/docker-compose.yml config
npm test
```

---

### Task 7: Documentation cutover and final verification

**Files:**
- Rewrite `packages/fluent-flow-agent-server/README.md`.
- Modify root, service, dashboard, agent, roadmap, and directory-index documentation.
- Modify current non-historical documents containing active runner setup instructions.

**Contract:**
- Document one-line local enrollment, self-hosted image setup, provider subscription secret setup, capacity, health, hosted contract, failure recovery, and native local host-access boundary.
- Preserve connector documentation under its preserved binary.
- Remove active references to the old runner package, executable, path, API prefix, source-build image setup, and long-lived token command.
- Historical dated documents remain historical.

**Verification:**
```bash
npm test --workspace packages/fluent-flow-agent-server
npm test --workspace packages/db
npm test --workspace packages/fluent-flow
npm test --workspace packages/dashboard
npm run build
npm run smoke --workspace packages/fluent-flow-agent-server
./scripts/check-migrations.sh
docker compose -f packages/fluent-flow-agent-server/docker-compose.yml config
docker build -f packages/fluent-flow-agent-server/Dockerfile -t fluent-flow-agent-server:verify .
AGENT_SERVER_IMAGE=fluent-flow-agent-server:verify npm run smoke:image --workspace packages/fluent-flow-agent-server
```

Final review must confirm every design acceptance criterion, the eight review-focus boundaries, connector preservation, no migration, no secret leakage, and no obsolete live runner surface.

## Execution status

Updated 2026-11-08. Each task was implemented test first and independently reviewed. The working ledger and per-task reports live in `.superpowers/sdd/2026-11-08-portable-agent-server/` (`progress.md` and the `task-*-report.md` files). That directory is git-ignored, so it exists only in the worktree that ran the plan. The design's [acceptance status](../specs/2026-11-08-portable-agent-server-design.md#acceptance-status) maps every acceptance criterion to its evidence or to an open gap.

| Task | Status | Notes |
|---|---|---|
| 1. Package and API naming cutover | Complete | Package, executable, routes, workflows and dashboard copy renamed. The `fluent-flow-connector` binary is preserved. |
| 2. Single-use enrollment and private state | Complete | Real-database exchange tests pass 25/25 (with the capacity suite) on a scratch PGlite server, not on a real PostgreSQL. |
| 3. Harden the runner for concurrent instances | Complete | Allowlisted child environment, claim-scoped Git credentials, claim-ID worktrees, repository lock, ownership-loss cancellation. |
| 4. Capacity server, configuration, health, smoke | Complete, one gap carried | Local mode cannot verify the provider login at startup. It needs an explicit ruling. |
| 5. Dashboard enrollment and capacity visibility | Complete | Includes the added `agent-server` bin alias so `npx @fluent-flow/agent-server@latest` resolves. |
| 6. Prebuilt image and release pipeline | Complete, unexecuted on GitHub | Image smoke ran under rootless Podman. The release workflow has not run on GitHub, no arm64 image was built, and no Docker daemon was used. |
| 7. Documentation cutover and final verification | Documentation complete. Final verification open | Browser harnesses moved to the new CLI (7a), live documentation and the design reconciled (7b). The full database-backed suites, a Docker daemon image run and the first release dry run remain. |

Deviations recorded in the ledger: before execution the plan was amended to the six implementation tasks above plus documentation, because the current runner already had the ACP runtime and no second ACP client, scheduler or executor was needed. Ownership-loss cancellation landed in the capacity task, and `createRunner` no longer calls `process.exit`.
