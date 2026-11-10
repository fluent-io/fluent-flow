# Agent server tests

[Agent server README](../README.md) · [Scripts and smoke tests](../scripts/README.md) · [Connector tests](unit/connector/README.md)

Vitest suites run with `npm test --workspace packages/fluent-flow-agent-server`. Everything in `unit/` runs without a database except `unit/connector/real-app.test.js`, which needs a disposable PostgreSQL database in `COLLAB_CONNECTOR_TEST_DATABASE_URL`. The release workflow excludes that file.

## Agent server

- `unit/config.test.js`: option parsing and validation (defaults, capacity 1 to 16, HTTPS-or-loopback server URL, deployment and provider values, ACP command and arguments, health port, rejected `FLUENT_FLOW_TOKEN`) and provider secret loading (Claude token, Codex JSON, size and shape limits).
- `unit/environment.test.js`: the child environment allowlist, reserved provider keys, and the claim-scoped GitHub environment (extra header, `GH_TOKEN`, disabled host Git configuration, fixed author identity).
- `unit/state.test.js`: private state directory and file (modes, atomic replacement, concurrent first start, malformed and symlinked files refused).
- `unit/server.test.js`: capacity slots, durable token source order, enrollment exactly once (the credential is dropped only after a successful exchange and a setup that built nothing can be retried), the provider passed to every runner, startup tool probe, stale worktree cleanup before any runner, aggregate health status, slot restart backoff, idempotent shutdown.
- `unit/health-server.test.js`: `/healthz` and `/status` responses, status codes, method and path handling, start and stop.
- `unit/probe.test.js`: executable lookup on the child `PATH`.
- `unit/safe-error.test.js`: redaction of tokens (`ff_`, `enroll_`, GitHub tokens, Basic authorization) and provider assignments from error text.
- `unit/agent-server-cli.test.js`: signal shutdown, the entry check (`isDirectRun`) and launch through a package-manager symlink.
- `unit/agent-server-main.test.js`: `main` passes every parsed config field to the server, builds the logger from `LOG_LEVEL`, and fails the process and runs shutdown when startup rejects.
- `unit/package-manifest.test.js`: the package bins, including the `agent-server` alias that lets `npx` resolve.
- `unit/logger.test.js`: pino JSON line shape, child loggers, `LOG_LEVEL` levels and secret-key redaction.
- `unit/execution-timeout-verify.test.js`: the claim-wide execution deadline on verify claims (deterministic and ACP authoring).
- `unit/verify-bounds.test.js`: clamping of claim-supplied verification settings and the authoring prompt cap before a worktree.

## Runner slot and execution

- `unit/runner.test.js` and `unit/reliability.test.js`: one slot's poll, claim, heartbeat, event streaming, permission and elicitation requests, follow-up commands, ownership loss, the execution timeout, the prompt size cap (including verify claims), provider and adapter agreement, decision events, redacted failure reasons in logs, transient failures, report retry and poll circuit.
- `unit/worktree.test.js` and `unit/worktree-stale.test.js`: claim-ID worktrees, repository validation, clean HTTPS remotes, per-repository locking (including release after failed clone or fetch), cleanup and removal of stale worktrees at startup.
- `unit/client.test.js`: the control-plane HTTP client, including enrollment.
- `unit/prompts.test.js`: prompt templates per claim type.
- `unit/verify-red.test.js`, `unit/verify-green.test.js`, `unit/adapters.test.js` and `fixtures/reporter/`: deterministic verification and the Jest, Vitest and `node:test` reporter adapters.
- `unit/acp-command.test.js`, `unit/acp-process.test.js`, `unit/acp-normalize.test.js` and `unit/acp-runtime.test.js`: the ACP layer described in [src/acp/README.md](../src/acp/README.md).
- `unit/fake-acp-agent.js`: a scripted ACP v2 agent. Scenarios are chosen with `--scenario`, and `--trace` writes a trace file. The ACP tests, both smoke launchers and the browser harnesses use it.

## Connector

`unit/connector/` tests the separate Paseo connector. See [its README](unit/connector/README.md).
