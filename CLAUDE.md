# Fluent Flow

Turborepo monorepo with four packages: server (`packages/fluent-flow/`), agent server (`packages/fluent-flow-agent-server/`), dashboard (`packages/dashboard/`), and shared db (`packages/db/`). The agent server runs claims on a machine you control and also ships the separate `fluent-flow-connector` executable for Paseo execution.

Read [packages/fluent-flow/README.md](packages/fluent-flow/README.md) for architecture overview, quick start, API reference, and config system.

## Key docs by area

- [packages/dashboard/README.md](packages/dashboard/README.md) — Admin dashboard: agent management, pipeline status, auth, setup
- [packages/db/README.md](packages/db/README.md) — Shared data access: pg pool, Zod schemas, org-scoped queries
- [packages/fluent-flow-agent-server/README.md](packages/fluent-flow-agent-server/README.md) — Agent server: local, self-hosted and hosted setup, enrollment, capacity, health, security model, operations
- [packages/fluent-flow-agent-server/docker/README.md](packages/fluent-flow-agent-server/docker/README.md) — Image contents, Compose files, pinned ACP adapter lockfile
- [packages/fluent-flow/config/README.md](packages/fluent-flow/config/README.md) — Config system: defaults, agent registry, per-repo overrides, validation
- [packages/fluent-flow/src/engine/README.md](packages/fluent-flow/src/engine/README.md) — State machine, review pipeline, pause/resume logic
- [packages/fluent-flow/src/mcp/README.md](packages/fluent-flow/src/mcp/README.md) — MCP server: tools, connection, auth
- [packages/fluent-flow/src/notifications/README.md](packages/fluent-flow/src/notifications/README.md) — Agent notification dispatcher, transports, multi-agent routing
- [packages/fluent-flow/src/agents/README.md](packages/fluent-flow/src/agents/README.md) — Agent registry, tokens, sessions, claims
- [docs/superpowers/specs/2026-11-08-portable-agent-server-design.md](docs/superpowers/specs/2026-11-08-portable-agent-server-design.md) — Agent server design, acceptance status, open deviations
- [docs/specs/](docs/specs/) — Design specs (agent-agnostic routing, worktree task pipeline, dashboard, pipeline status)
- [docs/plans/](docs/plans/) — Implementation plans

## Code conventions

- ESM imports (`import`/`export`), not CommonJS
- Raw `pg` queries, no ORM
- Zod for all validation
- Structured JSON logging via pino: `import logger from './logger.js'; logger.info({ msg: '...' })`
- `LOG_LEVEL` env var controls log verbosity (default: `info`)
- Fire-and-forget audit: `audit('event_type', { repo, actor, data })`
- Tests: Vitest, mocks in `tests/helpers/mocks.js`, run with `npm test`
- Do not, under any circumstance, include any indication that code was co-authored by Claude Code.
- Fail fast: never swallow errors. Every catch block must either rethrow or explicitly annotate why it's safe to continue. Silent catch-and-log is a bug. If something can fail, it should fail loudly so it gets fixed.

## Security

**Application secrets and internal config must never leak to users.** That includes:

- **Error messages returned to the browser / API clients.** Generic user-facing messages only ("Configuration error — contact support"); the real detail (env var names, stack traces, DB error codes, file paths, token prefixes) goes to `logger.error(...)` server-side only.
- **UI surfaces.** Dialog/toast copy, form validation errors, and status strings must not name internal env vars, secret keys, service URLs, or DB/table shapes. If a screenshot of the UI could be posted publicly without editing, treat it as such.
- **Logs and audit records.** Never log plaintext tokens, OAuth secrets, signing keys, or DB passwords. Hashes or prefixes (e.g. first 4 chars) are acceptable when they genuinely aid debugging; full values never are.
- **Generated artifacts.** CLI commands, redirect URLs, or config files rendered for end users must not embed secrets that aren't scoped to that user (e.g., don't render server-admin tokens into a user-facing "run this" command).

When in doubt: log the detail, surface a generic message. If a reviewer would flag a string as revealing internals, it doesn't belong in a user-visible response.

## Agent notification routing

Notifications route to the agent that created the PR, not just the repo default:
1. PR body marker: `<!-- fluent-flow-agent: agent-id -->`
2. `config.default_agent` (per-repo)
3. `config.agent_id` (legacy)

## Testing

```bash
cd packages/fluent-flow
npm test          # runs sequentially (--fileParallelism=false)
npm run test:watch
```

Or from root via Turborepo (runs every package, including the agent server and dashboard):
```bash
npm test
```

Agent server checks beyond the unit suite (see [its README](packages/fluent-flow-agent-server/README.md#development)):
```bash
npm run typecheck --workspace packages/fluent-flow-agent-server
npm run smoke --workspace packages/fluent-flow-agent-server
```

Suites that need a real PostgreSQL database read `COLLAB_DB_TEST_DATABASE_URL`, `COLLAB_ROUTES_TEST_DATABASE_URL` or `COLLAB_CONNECTOR_TEST_DATABASE_URL`; without them those files fail at load. Use a disposable loopback `ff_*` database.

TDD workflow: Red → Green → Refactor → breaking change verification → revert.
