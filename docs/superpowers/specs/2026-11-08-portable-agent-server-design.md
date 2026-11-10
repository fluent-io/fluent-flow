# Portable Fluent Flow Agent Server Design

**Status:** Implemented on branch `feat/portable-agent-server`, not released. Statements were reconciled with the shipped code on 2026-11-08. Items marked "Open deviation" need an explicit ruling. See [Acceptance status](#acceptance-status).
**Date:** 2026-11-08

## Audience and outcome

This document is for the engineer implementing Fluent Flow execution. After reading it, they should be able to build one agent-server package and image that runs concurrent claims locally, on a self-hosted VM, or in a Fluent Flow-managed environment without changing claim semantics between deployments.

## Intent

Fluent Flow currently has a capable long-lived ACP runner, but each process registers one session and executes one claim at a time. The runner already owns ACP v2 streaming, permission and elicitation requests, follow-up commands, recovery, verification, worktrees, heartbeat, and result reporting. If no runner is active, pending claims and their GitHub checks wait indefinitely; increasing capacity requires starting and managing more processes manually.

Replace the single-runner executable with a Fluent Flow-owned agent server that reuses the existing runner as its slot implementation. One server creates bounded independent runner instances, each with one control-plane session and at most one active claim. Users may run the server on their workstation, deploy the prebuilt image on a VM, or use an instance operated by Fluent Flow.

## Goals

- One codebase and one execution model in local, self-hosted, and hosted environments.
- Run several independent claims concurrently up to an explicit capacity.
- Preserve the control plane as the durable owner of claims, retries, pipeline transitions, and GitHub checks.
- Preserve the current ACP v2 runtime so Claude Code, Codex, and custom ACP agents retain streaming and interactive claim behavior.
- Reuse subscription authentication already available to provider CLIs.
- Keep all work connections outbound from the agent server so local and VM deployments need no public port.
- Keep one isolated Git worktree and one ACP subprocess per active claim.
- Publish a prebuilt GHCR image and an npm package.
- Expose cheap health and status endpoints for deployment probes and diagnosis.
- Preserve current claim retry, heartbeat, result, and repository-scope behavior.

## Non-goals

- Building a general container scheduler.
- Starting a disposable container for every claim.
- Sharing one agent-server process across organizations.
- Automatically provisioning one hosted container per organization. That is hosting-platform orchestration and consumes the image contract defined here.
- Persisting or rendering full ACP transcripts in Fluent Flow.
- Rewriting or downgrading the existing ACP runtime.
- Falling back from subscription authentication to paid API credentials.
- Replacing the deterministic pipeline state machine with agent decisions.

## Anti-goals

- A separate runner process for every concurrent slot.
- Inbound control-plane calls to developer machines.
- Provider-specific execution loops in Fluent Flow.
- Provider credentials in logs, claim payload persistence, image layers, or generated commands.
- A compatibility shim that leaves both runner and agent-server packages or API paths active.

## Current system

The control plane stores logical agents, tokens, ephemeral sessions, and claims. A token identifies one agent in one organization. Pending claims are claimed atomically with `FOR UPDATE SKIP LOCKED`; the winning session becomes busy. Heartbeats extend both session and claim expiry. Results are idempotent by claim ID, and transient failures create a new attempt.

The current runner already contains the execution behavior the server needs:

- outbound registration, long polling, heartbeat, and result reporting;
- ACP v2 process/session lifecycle, streaming, permission and elicitation requests, follow-up commands, and recovery;
- bounded retry and shutdown handling;
- repository cloning and per-claim Git worktrees;
- prompt selection and deterministic verification by claim type;
- structured redacted event handling and logging;
- dashboard-created org-scoped tokens.

Its limiting assumption is one mutable `sessionId`, `activeWork`, and ACP runtime per process. Those fields are closure-local, so one server can create multiple existing runner instances without introducing a second scheduler or executor.

## Approaches considered

### 1. Capacity slots over the existing pull protocol

One agent-server process creates `capacity` existing runner instances. Each runner is one slot: it registers its own control-plane session, claims at most one job, runs one ACP subprocess through the current runtime, reports the result, and returns to polling.

Benefits:

- preserves the proven atomic claim query and TTL recovery;
- requires no new scheduling tables or push channel;
- works behind NAT and firewalls;
- gives every active claim an unambiguous session owner;
- can be shipped incrementally from the existing runner.

Tradeoff: control-plane sessions represent execution slots rather than the whole server process. Shared `instance_id` metadata lets the UI and operators group them.

### 2. New push channel and dedicated server/execution tables

The control plane would register an agent server, track capacity centrally, create execution rows, and push assignments over WebSocket.

Benefits: a cleaner server-level domain model and immediate control messages.

Rejected for the first implementation. It duplicates claim durability, adds reconnect and delivery semantics, requires new migrations, and makes local deployment harder without improving claim correctness.

### 3. Disposable container for every claim

The server would launch a fresh container for each assignment.

Benefits: a stronger boundary for mutually untrusted tenants and repositories.

Rejected as the default. Local users would need a container runtime and privileged orchestration; self-hosted users would need a Docker socket; workspace and subscription state become harder to manage. Hosted deployments instead run one organization-scoped agent server inside a container. Per-claim containers can be added later only if the hosted threat model requires isolation inside one organization.

## Decision

Use capacity slots over the existing outbound pull protocol, implemented as multiple existing runner instances in one process. Run one organization and one logical agent profile per agent-server instance. Default capacity is `2`; valid capacity is `1` through `16`.

The deployment boundary provides tenant isolation:

- local: one process under the user's account;
- self-hosted: one container or process controlled by the organization;
- hosted: one Fluent Flow-managed container per organization and agent profile.

## Architecture

```text
Fluent Flow control plane
  claims, retries, pipeline state, GitHub checks
                 |
                 | outbound HTTPS long poll
                 v
Fluent Flow agent server
  instance_id, provider, capacity
     |              |
     v              v
  slot 0          slot 1
  session A       session B
     |              |
     v              v
  worktree A      worktree B
  ACP child A     ACP child B
```

The agent server is the supervisor. There is no second runner supervisor and no daemon inside the daemon.

## Control-plane contract

The product cuts over from `/api/runner/*` to `/api/agent-server/*` and removes the old path. The transport remains `long_poll` because that names the delivery mechanism, not the executable.

### Enroll an instance

`POST /api/agent-server/enroll`

The dashboard creates an existing `agent_tokens` row with a 15-minute expiry, an `enrollment:<agent id>` label and the prefix `enroll_`, in the same transaction that creates the agent. The generated one-line command contains this short-lived token. On first startup, the agent server sends it as a Bearer credential with its `instance_id` (a UUID). One database transaction locks the matching token, verifies the label and the expiry against the database clock, revokes it, creates a durable `ff_` token labelled `instance:<instance id>` with a one-year expiry, and returns the durable token once.

A consumed, expired, revoked, unknown or non-enrollment token all get the same `401`. The originally specified `409 enrollment_consumed` and `410 enrollment_expired` responses were not built, because distinct answers would tell a caller whether a token exists. The route bounds attempts at 10 per minute per socket peer and answers `429` beyond that. The agent server stores the durable token in its private state directory (mode `0700`, file mode `0600`), drops the enrollment value after the exchange, and never passes either control-plane token to a child environment. The enrollment token reaches the process as a command-line argument, so it is visible in shell history, process listings and `docker inspect` until it is used or expires. Containers persist the state directory in a named volume. Losing the directory requires a new enrollment command; the used command cannot recreate credentials.

Hosted infrastructure may skip enrollment and mount a durable org-scoped token from its secret store.

### Register slot

`POST /api/agent-server/register`

Auth: existing `Authorization: Bearer ff_...` agent token.

Request:

```json
{
  "meta": {
    "runtime": "agent-server",
    "instance_id": "7b1c4f56-2a0e-4c8b-9d3a-5e4f1a2b3c4d",
    "slot_id": 0,
    "capacity": 2,
    "version": "0.2.0",
    "provider": "claude-code",
    "deployment": "local",
    "hostname": "agent-host",
    "os": "linux"
  }
}
```

Response `200`:

```json
{
  "ok": true,
  "session_id": 42,
  "status": "online"
}
```

The route validates `meta` with a schema and answers `400 { "error": "Invalid session metadata" }` for anything else: `meta` must be an object (an absent `meta` is empty); `runtime`, `instance_id`, `hostname`, `os`, `version`, `provider` and `deployment` are strings of at most 256 characters; `slot_id` is an integer from 0 to 1023; `capacity` an integer from 1 to 16; `supported_claim_types` an array of at most 32 strings of at most 64 characters; the legacy `cwd` a string of at most 1024 characters. Other keys are accepted only while the whole serialized `meta` stays within 4096 bytes.

A response lost after insertion may leave an unpolled session until its five-minute TTL expires. This bounded ghost is acceptable and avoids a new registration-idempotency table.

### Poll

`POST /api/agent-server/poll`

Request and response retain the current `session_id` and `work` shapes. Each slot has one outstanding poll and cannot poll again until its active claim ends. The delivered `work` takes `repo`, `claim_id`, `claim_type` (and its `claimType` alias), `attempt`, `pr_number` (and `prNumber`), `agentType` and `githubToken` from the claim row and the server's own token resolution. The claim `payload` is spread first, so no payload key can override those fields or supply a token.

### Heartbeat and cancellation

`POST /api/agent-server/heartbeat`

A heartbeat for an owned claim returns:

```json
{
  "ok": true,
  "claim": { "id": 123 }
}
```

If the claim was cancelled, expired, completed elsewhere, or is no longer owned by the slot, the endpoint returns `200` with `claim: null`. The slot MUST cancel the ACP request, terminate the adapter after the grace period, clean its worktree, and return to polling. It MUST NOT submit a second terminal result for a claim it no longer owns.

An expired slot session returns `410` with code `session_expired`; the slot re-registers before polling again.

### Result

`POST /api/agent-server/claim`

Result reporting retains claim-ID idempotency and the existing completed, terminal-failure, and transient-failure behavior. Claim ID is required after the cutover; the natural-key compatibility path is removed.

### Errors

Responses keep the existing top-level `error` string:

```json
{
  "error": "Session expired or offline — re-register"
}
```

Open deviation: the stable `code` and `request_id` fields in the original design are not implemented. Clients match on HTTP status. Enrollment returns the generic `401 { "error": "Invalid enrollment credential" }` or `429 { "error": "Too many requests" }`.

User-visible errors stay generic. Internal configuration, credentials, paths, and provider output appear only in server-side structured logs after redaction.

### Versioning

The API is same-repository internal surface. Additive changes stay under `/api/agent-server`. A future breaking protocol uses `/api/agent-server/v2`; no alias is kept for `/api/runner`.

## Agent-server lifecycle

Startup:

1. Parse and validate options: HTTPS server URL (HTTP only for `localhost`, `127.0.0.1` and `[::1]`, with no credentials in the URL), provider (`claude-code` or `codex`), deployment (`local`, `self_hosted` or `hosted`, where the last two require a provider secret file), capacity, paths and health bind address. Read the provider secret file when one is given.
2. Probe `git`, `gh` and the selected ACP adapter executable on the child `PATH`. Provider authentication is not probed. Open deviation: local mode reuses the CLI login and cannot be verified without a billed call, so a missing login surfaces only when a claim runs, as a transient claim failure. Container and hosted modes validate that the secret file exists, is under 64 KiB and has the right shape, but not that the provider accepts it. This needs an explicit ruling.
3. Remove stale worktrees: delete leftover `claim-*` directories under `<work dir>/.fluent-flow/repos/*/*/.worktrees/` and run `git worktree prune` in each base clone, under the same per-repository lock the claims use, and log the counts. A failing repository is logged with a redacted reason and skipped. Startup fails only when the repository root of the work directory cannot be read.
4. Load or create private state, then resolve the durable token: token file, then stored token, then one enrollment exchange stored before any slot exists. The enrollment credential is dropped only after a successful exchange, so a transport failure leaves it usable if `start` is called again before any slot exists.
5. Create `capacity` independent existing runner instances with one shared immutable configuration, including the configured provider.
6. Start the local health server.
7. Start one supervision loop per slot, which registers the slot's session and begins polling.

Execution:

1. A runner slot claims work through the existing database-authoritative poll path.
2. The existing worktree helper acquires the repository lock.
3. It clones or fetches the persistent base repository.
4. It creates a worktree named by claim ID.
5. It releases the repository lock.
6. The existing runner starts the selected ACP adapter over stdio.
7. The existing ACP v2 runtime initializes, creates a worktree-scoped session, and sends the resolved claim prompt.
8. Existing event, permission, elicitation, and follow-up-command bridges remain active while the slot heartbeats.
9. Ownership loss cancels the current runtime; normal completion uses the existing stop-reason, verification, and review-marker mapping.
10. The runner closes ACP, removes the worktree, and reports through the existing result path.

Shutdown:

1. Stop accepting new claims.
2. Abort every active ACP session.
3. Close each child with bounded waits (5 seconds each for idle, exit and kill).
4. Report still-owned active claims as transient failures.
5. Stop slot polls and the health server.

Shutdown is idempotent.

A second signal does not force an exit. It only marks the exit code 1 while the drain continues.

Restart supervision: a slot whose loop rejects (registration failure, a fatal poll circuit) restarts after 2 seconds, doubling per consecutive failure to a cap of 60 seconds. A restarted slot that reports a new session resets the delay. Shutdown cancels pending waits and never restarts a slot. The process itself is not supervised: startup failures (options, tools, state, enrollment, a busy health port) log a redacted error and exit with code 1, and the operator's restart policy (Docker, systemd, Kubernetes) brings it back.

## ACP execution

Preserve the repository's existing ACP v2 implementation under `packages/fluent-flow-agent-server/src/acp/`, using `@agentclientprotocol/sdk` `2.4.0`. The current runtime already owns stdio transport, capability checks, event normalization, permission and elicitation requests, follow-up prompts, cancellation, liveness probes, bounded restart, resume, and graceful-to-forced child termination.

Built-in adapters remain explicit local executables in native mode and are preinstalled in the container image. Custom agents remain an explicit executable plus argument array. Shell command strings are not accepted.

Each claim gets a fresh adapter process and ACP session through the existing runner. Conversation continuation between claims is not required because pipeline continuity belongs to durable claims, not provider process state.

Unattended policy and browser-mediated permission or elicitation behavior remain exactly as implemented by the current claim command/event bridge. The worktree or deployment container is the execution boundary. Local native mode therefore has the same host access as running the provider CLI directly and must state that clearly.

Full transcript persistence remains excluded. Existing bounded, redacted event and final-text handling is preserved; logs record event types, sizes, and state transitions, never raw ACP message or tool content.

## Workspace concurrency

The persistent base clone is shared by slots in one server instance. Repository clone, fetch, worktree add, and worktree prune operations use a keyed in-process lock per `owner/repo`. The lock is released before ACP starts, so different worktrees execute concurrently.

Worktree paths use `claim-{claim_id}`. Claim ID avoids collisions between claim types, nullable PR numbers, and retry attempts.
Repository names MUST match `owner/repo` before they reach filesystem or Git operations. Claim IDs MUST be positive integers. Collected result text is capped at 5 MiB. The resolved prompt MUST NOT exceed 131072 bytes (128 KiB, UTF-8), and the same cap applies to verification authoring prompts, which fail terminally before the verification worktree is created. An oversized prompt fails the claim before any worktree or ACP runtime exists, with one `failed` report whose `failure_kind` is `terminal` (redispatch cannot shrink the prompt), and a generic log event without prompt content. Every claim's ACP execution has a time limit of one hour by default, set with `--execution-timeout-minutes` (integer 1 to 1440) and the server option `executionTimeoutMs`. At the deadline the server cancels the ACP runtime, ends the child through the normal close path, removes the worktree and reports one `failed` result with `failure_kind: transient`, and it logs `Claim execution timed out`. Ownership loss and shutdown clear the deadline and never produce a second report. A verification claim has one deadline for the whole claim: at the deadline the server aborts its running verification commands and any authoring turn and reports one transient failure. Verification phases also keep their own command timeouts. The `verification` settings in a claim are clamped, not trusted: `timeouts_min.red` and `timeouts_min.green` to 1..1440 minutes, `authoring.retries` to 0..10, `authoring.max_requirements` to 1..100, `authoring.red_reproductions` to 1..10 and `flake.retries` to 0..10, with non-numbers falling back to the defaults. With the built-in adapter (no `--acp-command`), a claim whose agent type does not map to the same adapter as `--provider` fails once as `terminal` before any worktree or runtime exists. With a custom command the agent type is not checked.

Git remotes never contain credentials. Clone, fetch, and push use the GitHub App token through an HTTPS extra header that `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` supply in the claim's child environment, and `gh` receives it as `GH_TOKEN`. No credential helper is configured and nothing token-related is written to Git configuration. Host global and system Git configuration is disabled. The claim environment is built fresh per claim, so the token does not outlive it.

Cleanup always runs after ACP success, failure, timeout, cancellation, or shutdown. A cleanup failure is logged and marks health degraded, but the original claim result is still reported if known.

## Platform support

The agent server (everything under `packages/fluent-flow-agent-server`) is cross-platform: Linux, macOS and Windows. The control plane (`packages/fluent-flow`) and the container image are Linux only.

Platform-dependent code takes the platform as a parameter that defaults to `process.platform`, so tests exercise the Windows path on any host. On `win32`:

- `state.js` skips directory open, directory chmod, directory fsync and the `0600` mode check, because Windows cannot open a directory with `fs.open` and reports 0666-style modes. It keeps every other protection: it rejects a symlinked state directory and state file, a non-regular file, oversized, malformed or wrongly typed state; it writes a temporary file and renames it over `state.json`; and it publishes the first state exclusively with a hard link. The rename is retried up to 5 attempts (10, 20, 40, 80 ms) on `EPERM`, `EBUSY` or `EACCES`, then the last error is thrown. POSIX behavior (0700 directory, 0600 file, directory fsync, mode enforcement, no retry) is unchanged.
- The child environment matches the allowlist case-insensitively and emits one spelling per variable. Claim Git runs use `GIT_CONFIG_GLOBAL=NUL` and `core.longpaths=true`.
- `SIGBREAK` shuts down gracefully next to `SIGINT` and `SIGTERM`. The direct-run guard compares canonical native real paths.
- The executable probe applies `PATHEXT`. ACP `.cmd` and `.bat` wrappers are rejected; the known adapters resolve through their npm shim to `node <entry>`.

Not verified, and not supported where stated: no Windows host was available, so the Windows paths are verified only through injected-platform tests on Linux and the Windows leg of the `acp-agent-server` CI job, which had not run when this was written. Deterministic verification claims cannot start `npm`, `pnpm`, `yarn`, `vitest` or `jest` without a shell and are not supported on Windows. Prompt snippets assume a POSIX shell. The environment allowlist does not pass `APPDATA` or `LOCALAPPDATA`. Hard-link publication needs NTFS. This replaces the earlier open ruling that Windows is unsupported.

## Authentication and secrets

### Enrollment and control-plane token

Dashboard setup passes a short-lived token through `--enrollment-token`. The agent server exchanges it once through `/api/agent-server/enroll`, stores the returned durable token in its private state directory with mode `0600`, and uses that token for slot registration, polling, heartbeat, and results. The durable token comes from the first source that exists: the `FLUENT_FLOW_TOKEN_FILE` file, then the stored token, then enrollment. An enrollment token given next to either of the others is never sent.

Noninteractive deployments may instead mount a durable token through `FLUENT_FLOW_TOKEN_FILE`. A plaintext `--token` flag and `FLUENT_FLOW_TOKEN` environment variable are not supported (startup fails if `FLUENT_FLOW_TOKEN` is present), because they remain useful in shell history or process metadata.

### Provider subscription credentials

- Local native mode reuses the provider CLI login already available to the user's account.
- Container and hosted modes mount one read-only provider secret file, readable by UID 1000 in the image, and pass its path through `--provider-secret-file`.
- For Claude Code, the file contains the Pro or Max `CLAUDE_CODE_OAUTH_TOKEN` value.
- For Codex, the file contains the `CODEX_AUTH_JSON` document.
- The server reads only the selected provider's format, caps the file at 64 KiB, and never copies it into state or work directories.
- The server does not silently fall back to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### Hosted mode

Fluent Flow's hosting platform runs one agent-server container per organization and agent profile. The platform mounts the org-scoped Fluent Flow token and selected provider credential as read-only secret files. The agent-server code does not implement a cloud scheduler or store hosted credentials in PostgreSQL.

Secrets are never written to the base repository, worktree, logs, audit records, health responses, image layers, or claim result payloads.

### Child process environment

ACP adapters receive an allowlisted environment rather than a copy of `process.env`. The allowlist contains `PATH`, `HOME`, temp-directory, locale and terminal basics, the selected provider credential, and the claim-scoped GitHub credential. It excludes Fluent Flow enrollment and durable tokens, credentials for unselected providers, deployment secrets, host Git configuration, SSH agent variables, and unrelated host environment variables.

Open deviation: ACP children run as the same operating-system user as the server, so they can read the durable token file and `state.json` from disk even though neither is in their environment. Acceptance criterion 13 therefore holds for the environment and not for the filesystem. The tokens are organization-scoped and revocable. Closing the gap needs a separate UID or a mount the child cannot reach, and needs a ruling.

Custom ACP commands are local agent server configuration (`--acp-command` and repeatable `--acp-arg`). They are validated as one executable without whitespace or shell text and spawned with `shell: false`. The control plane neither stores nor sends them.

## Health and observability

The agent server binds its status listener to `127.0.0.1:3860` by default (`--health-host`, `--health-port`). Containers may bind it to `0.0.0.0` on a private network. The image health check calls `/healthz` on `127.0.0.1:3860` only, so a different host or port needs its own check.

`GET /healthz` and `GET /status` return the same six fields:

```json
{
  "status": "healthy",
  "instance_id": "7b1c4f56-2a0e-4c8b-9d3a-5e4f1a2b3c4d",
  "provider": "claude-code",
  "capacity": 2,
  "active": 1,
  "online_slots": 2
}
```

A slot is online when it has a session, has not failed and has no consecutive poll failures. Status values:

- `healthy`: every slot is online and no slot reports a failed worktree cleanup;
- `degraded`: at least one slot is online but not all, or every slot is online and a cleanup failed;
- `unhealthy`: no slot is online.

`/healthz` answers 503 only when the status is `unhealthy`. `/status` always answers 200. Other paths answer 404, other methods 405 and a malformed request target 400. Open deviation: the original design also made `unhealthy` depend on a provider authentication failure and `healthy` on a passing provider probe. There is no provider probe, so health never reflects the provider login.

Logs are pino JSON lines on standard output (string `level`, `msg`, ISO `time` and event fields). Each slot logs through a child logger that adds `instanceId` and `slotId`. They include claim IDs, repositories, attempts and decision reasons where applicable, and never prompts, provider credentials, GitHub tokens, raw ACP frames, or full provider output. `LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error` or `fatal`, default `info`) sets the minimum level; an invalid value fails startup. Fields named `token`, `githubToken` and `authorization` are redacted at the top level and one object down, and error text passes through a redaction for `ff_` and `enroll_` tokens, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and `Authorization: Basic` headers. Failure logs carry the claim ID and a redacted `reason`. Decision events carry an `event` field: server startup with the validated capacity, provider and deployment (`Agent server started`), slot registration and re-registration, claim accepted and claim reported with the final status (`Claim accepted`, `Claim reported`), report failure, execution timeout, oversized prompt, slot restart with attempt and delay, worktree cleanup and cleanup failure, poll failure and circuit opening, and `Agent server shutdown complete`. Open deviation: the ACP runtime exposes no timeout or forced-kill event, so `ACP runtime timeout` and `ACP runtime forced kill` are not logged, and provider health transitions are not logged because no provider probe exists.

## Deployment modes

### Local

```bash
npx @fluent-flow/agent-server@latest \
  --server https://flow.fluentflow.tech \
  --provider claude-code \
  --capacity 2 \
  --enrollment-token enroll_...
```

The provider CLI login is reused from the local account. The package declares three bins: `fluent-flow-agent-server`, `agent-server` (an alias to the same file) and `fluent-flow-connector`. The alias is what lets `npx @fluent-flow/agent-server@latest` run, because npx picks the bin named like the unscoped package name when a package has several bins.

### Self-hosted VM

```bash
docker run -d \
  --name fluent-flow-agent-server \
  --restart unless-stopped \
  --init \
  -v /etc/fluent-flow/provider-auth:/run/secrets/provider-auth:ro \
  -v fluent-flow-state:/home/node/.fluent-flow \
  -v fluent-flow-work:/work \
  ghcr.io/fluent-io/fluent-flow-agent-server:latest \
  --server https://flow.fluentflow.tech \
  --provider claude-code \
  --capacity 2 \
  --deployment self_hosted \
  --enrollment-token enroll_... \
  --provider-secret-file /run/secrets/provider-auth
```

The prebuilt image contains Git, GitHub CLI, the ACP client, and the pinned Claude and Codex adapters, and runs as UID 1000. The only host prerequisite is a provider secret file containing the selected subscription credential, readable by UID 1000 (for example `chown 1000:1000` with mode `0400`). The package Compose files add a read-only root filesystem, dropped capabilities and file-based secrets.

### Hosted

The hosting platform runs the same image and configuration contract with `--deployment hosted`. Users do not install or maintain the server. One organization-scoped instance receives only that organization's token, repositories, and provider credential. The platform mounts a durable token file (`FLUENT_FLOW_TOKEN_FILE`, which skips enrollment) and the provider secret file, and uses an HTTPS control-plane URL. The repository root `docker-compose.yml` carries the same service behind an optional `hosted-agent` profile with no network shared with Postgres and no `depends_on`, so the default `docker compose up` is unchanged.

## Dashboard behavior

The existing New Agent flow becomes New Agent Server:

1. Choose organization, server name, provider, and capacity.
2. Choose local npm or self-hosted Docker deployment.
3. Copy the command containing a 15-minute, single-use enrollment token.
4. Connection completes when at least one slot is online.

Agent list and detail views show `active slots / capacity`, provider, last seen, and deployment mode, taken from the live slot sessions and falling back to the `provider`, `capacity` and `deployment` that the dashboard stored in `agents.transport_meta` at creation. They do not display provider credential names or values.

Hosted infrastructure provisions the same agent row, token, image, and metadata through its deployment system. The dashboard displays hosted instances but does not offer an unbacked Hosted button before that deployment integration exists.

## Data model

No schema migration is required for the core server.

- `agents` remains the logical provider profile and repository scope.
- `agent_tokens` remains organization-scoped authentication. Existing expiry and revocation fields support single-use enrollment without a migration.
- `agent_sessions` represents capacity slots. `session_meta` carries `runtime`, `instance_id`, `slot_id`, `capacity`, `version`, `provider`, `deployment`, `hostname` and `os`.
- `agent_claims.session_id` remains the active slot owner.

Dashboard queries aggregate live slot sessions by agent and instance. Historical session rows continue expiring under the existing TTL worker. `agents.transport_meta` holds `{ provider, capacity, deployment }` written when the dashboard creates the agent. The aggregate uses those values only when no live slot reports its own.

## Failure behavior

- Control plane unavailable: poll failures back off exponentially. After a sustained run of failures the poll circuit opens, the slot's loop rejects and the supervision loop restarts it with backoff. Active ACP work continues while heartbeat ownership is uncertain, but completion reporting remains bounded and loud.
- Session expired: the idle slot re-registers; an active claim is allowed to expire and be redispatched if ownership cannot be restored.
- Provider unauthenticated: open deviation. Container and hosted modes fail startup only for a missing, oversized or malformed secret file. A credential the provider rejects, and a missing local login, show up as a transient claim failure. No slot is refused registration and health does not change.
- ACP adapter crashes: report terminal failure unless the failure is infrastructure-related before a prompt begins, in which case report transient failure.
- Claim ownership lost: cancel ACP and do not report a second result.
- Worktree preparation fails: report transient failure.
- Claim agent type does not match the configured provider (no custom ACP command): report terminal failure before any worktree or runtime exists.
- Agent timeout: the default one-hour execution limit cancels the ACP runtime, cleans up the worktree and reports one transient failure, so a stuck agent that still heartbeats is stopped and the claim is redispatched. Dashboard cancellation and ownership loss also stop it.
- One slot crashes: other slots continue; health is degraded; the failed slot restarts after its backoff delay.
- Server process crashes: claim and session TTLs recover through the existing expiry and redispatch workers.

## Cutover

- Rename `packages/fluent-flow-runner` to `packages/fluent-flow-agent-server`.
- Publish `@fluent-flow/agent-server` and `ghcr.io/fluent-io/fluent-flow-agent-server`.
- Rename the executable to `fluent-flow-agent-server`.
- Replace `/api/runner/*` with `/api/agent-server/*` and migrate every in-repository caller in the same change.
- Remove unrestricted `process.env` inheritance, shared `gh auth` mutation, and credential-bearing Git remotes while preserving the current ACP and interaction implementation.

## Release policy

A GitHub release tagged `agent-server-v<version>` must match the version in `packages/fluent-flow-agent-server/package.json`. The release workflow publishes nothing until all of these pass: tests (excluding the database-backed connector test), typecheck, the in-process smoke, a tarball content check and an amd64 image smoke.

npm: a prerelease version (one with a hyphen suffix) publishes under the `next` dist-tag. A stable version at least as high as both the current `latest` tag and the highest stable version already published publishes as `latest`. The rule lives in `scripts/release-policy.mjs` (a pure `computeReleasePolicy` function and a CLI the workflow calls), is pinned with the exact `semver` dependency and is tested by `npm run test:release` in CI and in the release workflow. A lower stable version, such as a backport, publishes as `legacy`. Publishing is idempotent and uses provenance.

Every `uses:` in `ci.yml` and `release-agent-server.yml` is pinned to a full commit SHA, and every container image they reference (the PostgreSQL service and the Hadolint image) is pinned to a digest. `scripts/workflow-pins.test.mjs` enforces both and runs in `npm run test:release`. Bump a pin by resolving the new tag's commit and replacing the whole value.

Image: the workflow pushes `ghcr.io/fluent-io/fluent-flow-agent-server:<version>` for linux/amd64 and linux/arm64, resolves the pushed digest, checks the manifest lists both platforms, runs the full smoke on the amd64 digest and checks tool versions on the arm64 digest under QEMU. `:latest` moves to that digest only after those checks pass and only when the version qualifies for the npm `latest` tag. An existing `:<version>` tag is verified and never overwritten.

The workflow has not run on GitHub. The first release dry run on a runner is the real test of the registry, `imagetools`, QEMU and cache steps.

## Acceptance criteria

1. With capacity `2`, two claims execute concurrently and a third remains pending until a slot is free.
2. Two simultaneous slots cannot claim the same claim.
3. Each claim uses a distinct claim-ID worktree and ACP subprocess.
4. Cancelling a claimed job causes the owning ACP session to stop and the slot to become available without submitting a duplicate result.
5. Killing the server causes active claims to recover through transient reporting or TTL redispatch.
6. Local execution reuses an existing Claude or Codex subscription login.
7. The prebuilt image runs with mounted subscription credentials and no source checkout or image build.
8. Health changes to degraded when one slot loses the control plane and unhealthy when provider authentication is unavailable.
9. Logs, API errors, status responses, and claim results contain no provider credential or GitHub token.
10. The old runner package, executable, API path, and dashboard copy are absent after cutover.
11. The same test claim completes through the local npm package and the published container image.
12. A dashboard enrollment command works once, stores a durable token in the server state directory, and cannot be replayed after exchange or expiry.
13. ACP children cannot read enrollment tokens, durable Fluent Flow tokens, credentials for unselected providers, or unrelated host environment variables.
14. Repository input cannot escape the work directory, and Git remotes never contain credential values.
15. Existing ACP event streaming, permission and elicitation requests, follow-up commands, recovery, and deterministic verification still pass after the cutover.

## Acceptance status

Evidence as recorded in the execution ledger on 2026-11-08. "Smoke" is `npm run smoke` (in-process) and `npm run smoke:image` (inside the built image, run with rootless Podman). Both drive the real server and real ACP child processes against a fake loopback control plane, so they prove agent server behavior and not the control plane with a real database. Test names are in `packages/fluent-flow-agent-server/tests/unit` unless a path says otherwise.

| # | Status | Evidence or gap |
|---|---|---|
| 1 | Met in smoke | Smoke: claims 1 and 2 overlap, observed active ownership never exceeds 2, claim 3 is delivered only after a slot is released. `server.test.js`: "allows both configured slots to be active without constructing a third claim slot". |
| 2 | Covered, not run here | Atomic claim SQL (`FOR UPDATE SKIP LOCKED`) is tested in `packages/fluent-flow/tests/integration/claim-pending-work.test.js` ("only one concurrent session wins a single pending claim"). It needs a real PostgreSQL, which this host lacks. CI runs it. |
| 3 | Met | Smoke: three claims use three ACP sessions and `claim-1`, `claim-2`, `claim-3` worktrees. `worktree.test.js`: "keys the detached worktree only by positive claim ID". |
| 4 | Met in smoke | Smoke: claim 1 stays active until its heartbeat returns `claim: null`, never reports a terminal result, and claim 3 then runs. `runner.test.js`: "waits for an in-flight heartbeat before terminal reporting and honors a late ownership release" and "aborts an active deterministic verification child when ownership is released". Route: `packages/fluent-flow/tests/routes/agent-server-heartbeat.test.js`, "returns 200 with claim:null when the claim is gone or not owned". |
| 5 | Partial | Graceful stop: `reliability.test.js`, "closes the runtime, waits for it, cleans the worktree, and reports one transient failure", and the image smoke requires exit 0 within 15 seconds of SIGTERM. Gap: no test kills the process with SIGKILL and watches TTL redispatch. That path relies on the existing expiry worker. |
| 6 | Open deviation | Not verified. `config.test.js` ("uses local CLI login without reading a provider secret or inheriting host credentials") shows only that no secret file is read and `HOME` is passed. No test or smoke used a real Claude or Codex login. Needs a manual check and a ruling on a startup probe. |
| 7 | Partial | `smoke:image` passes with a read-only root filesystem, `--cap-drop ALL`, UID 1000, a sentinel secret file and no source checkout. It ran under rootless Podman. It has not run against a Docker daemon, and no image has been published. |
| 8 | Partial, open deviation | Degraded on a lost control plane: `server.test.js`, "counts a slot with consecutive poll failures as offline and reports degraded" and "keeps a healthy runner online and reports degraded when a sibling start rejects". Unhealthy with no online slot: "reports unhealthy when no slot can claim work". Not met: health has no provider authentication input, so it does not turn unhealthy when the provider login is unavailable. |
| 9 | Met for the tested surfaces | Smoke scans container or process logs, Git trace, stored remotes, ACP trace, reports and health responses for planted enrollment, durable, provider and GitHub secrets. `safe-error.test.js` (including GitHub tokens and Basic authorization), `logger.test.js` (pino output shape, secret-key redaction and `LOG_LEVEL`), `health-server.test.js` (six public fields only), `environment.test.js`, and route tests for generic error text. |
| 10 | Met | The stale-name `git grep` gate returns only rejection notes and historical records. `packages/fluent-flow/tests/routes/agent-server-paths.test.js`: "mounts agent-server registration and removes runner registration". The dashboard API test asserts the generated command contains no `--token`. |
| 11 | Partial | The same smoke scenario runs against the source (npm package code path) and the built image. Not met: nothing is published, so the published image and the published npm package have not run it. |
| 12 | Met, database gate pending | `server.test.js`: "exchanges enrollment exactly once and stores the durable token before constructing runners". `state.test.js` for private state. `packages/fluent-flow/tests/routes/agent-server-enroll.test.js`: "returns the generic invalid outcome when a successfully exchanged credential is replayed". `packages/db/tests/queries/enrollment-exchange.integration.test.ts` (one of two concurrent exchanges wins, an expired token yields nothing) passes on a scratch PGlite server, not yet on a real PostgreSQL. |
| 13 | Partial, open deviation | Environment: `environment.test.js` ("copies only portable launch basics and explicitly selected provider values") and `runner.test.js` ("passes claim-scoped environment and ownership to worktree preparation and the ACP runtime"). Gap: children share the server's UID and can read the durable token file and `state.json`. |
| 14 | Met | `worktree.test.js`: unsafe repository and purpose names are rejected before any Git work, and "keeps claim credentials in a fresh per-call environment and out of args and persisted remotes". Smoke checks the stored remote is the clean HTTPS URL. |
| 15 | Met by unit tests, browser run pending | `runner.test.js` (streaming normalization, permission and elicitation uploads, prompt and cancel commands, acknowledgement rules), `acp-runtime.test.js`, `verify-green.test.js`, `verify-red.test.js`. The two actual-browser harnesses were moved to the new CLI (`claim-execution-actual.browser.mjs`, `preview-uat-browser.mjs`) and checked only by a spawn-contract script, since this host has no browser stack. |

Dashboard behavior (New agent server dialog, capacity validation, the exact POST body, the connected transition) is covered by the jsdom component suites and the dashboard API tests, and the two flows were checked once in a real browser against a throwaway harness during the dashboard task. That harness was not kept.

Open deviations needing a ruling, collected from the sections above:

1. Local mode does not verify the provider login at startup, and health has no provider authentication state (criteria 6 and 8).
2. The agent server children can read the durable token file and `state.json` (criterion 13).
3. Responses lack the `code` and `request_id` fields, and enrollment failures share one `401` instead of `409` and `410`.
4. The ACP runtime exposes no timeout or forced-kill event, so those two decision events are not logged, and provider health transitions are not logged (no provider probe).

Not run on real infrastructure: the release workflow on GitHub, an arm64 image, any Docker daemon, any Windows host, the real-PostgreSQL collaboration suites and the two browser harnesses.

## Builder calls

- Default capacity `2`; maximum `16`.
- Preserve the existing ACP v2 runtime and interaction contract.
- One organization and one provider profile per server instance.
- One control-plane session per capacity slot.
- One ACP subprocess per claim.
- Organization-level container isolation in hosted mode; no per-claim containers.
- No database migration for the core server.
- Dashboard setup uses a 15-minute, single-use enrollment token backed by the existing token table.
- Hosted tenant provisioning remains a hosting-platform concern, not an agent-server subsystem.
