# Fluent Flow

Turborepo monorepo. Server code lives in `packages/fluent-flow/`.

Read [packages/fluent-flow/README.md](packages/fluent-flow/README.md) for architecture overview, quick start, API reference, and config system.

## Key docs by area

- [packages/fluent-flow/config/README.md](packages/fluent-flow/config/README.md) — Config system: defaults, agent registry, per-repo overrides, validation
- [packages/fluent-flow/src/engine/README.md](packages/fluent-flow/src/engine/README.md) — State machine, review pipeline, pause/resume logic
- [packages/fluent-flow/src/mcp/README.md](packages/fluent-flow/src/mcp/README.md) — MCP server: tools, connection, auth
- [packages/fluent-flow/src/notifications/README.md](packages/fluent-flow/src/notifications/README.md) — Agent notification dispatcher, transports, multi-agent routing
- [packages/fluent-flow/src/agents/README.md](packages/fluent-flow/src/agents/README.md) — Agent registry, tokens, sessions, claims
- [packages/fluent-flow/DESIGN.md](packages/fluent-flow/DESIGN.md) — Build instructions, DB schema, Docker setup

## Code conventions

- ESM imports (`import`/`export`), not CommonJS
- Raw `pg` queries, no ORM
- Zod for all validation
- Structured JSON logging via pino: `import logger from './logger.js'; logger.info({ msg: '...' })`
- `LOG_LEVEL` env var controls log verbosity (default: `info`)
- Fire-and-forget audit: `audit('event_type', { repo, actor, data })`
- Tests: Vitest, mocks in `tests/helpers/mocks.js`, run with `npm test`
- Do not, under any circumstance, include any indication that code was co-authored by Claude Code.

## Agent notification routing

Notifications route to the agent that created the PR, not just the repo default:
1. PR body marker: `<!-- fluent-flow-agent: agent-id -->`
2. `config.default_agent` (per-repo)
3. `config.agent_id` (legacy)

## Testing

```bash
cd packages/fluent-flow
npm test          # 320 tests, runs sequentially (--fileParallelism=false)
npm run test:watch
```

Or from root via Turborepo:
```bash
npm test
```

TDD workflow: Red → Green → Refactor → breaking change verification → revert.
