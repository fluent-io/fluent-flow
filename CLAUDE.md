# Fluent Flow

Read [README.md](README.md) for architecture overview, quick start, API reference, and config system.

## Key docs by area

- [config/README.md](config/README.md) — Config system: defaults, agent registry, per-repo overrides, validation
- [src/engine/README.md](src/engine/README.md) — State machine, review pipeline, pause/resume logic
- [src/mcp/README.md](src/mcp/README.md) — MCP server: tools, connection, auth
- [src/notifications/README.md](src/notifications/README.md) — Agent notification dispatcher, transports, multi-agent routing
- [DESIGN.md](DESIGN.md) — Build instructions, DB schema, Docker setup

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
npm test          # 218 tests, runs sequentially (--fileParallelism=false)
npm run test:watch
```

TDD workflow: Red → Green → Refactor → breaking change verification → revert.
