# Fluent Flow

Automated code review orchestrator for AI coding agents. Manages the review-fix loop so agents focus on writing code — not deciding what to do next.

## How It Works

1. An AI agent opens a PR
2. Fluent Flow runs an automated review
3. If the review fails, the agent is notified with specific feedback
4. The agent pushes a fix, triggering a re-review
5. On pass, the PR is auto-merged. On repeated failure, a human is escalated

## Packages

| Package | Description |
|---------|-------------|
| [fluent-flow](packages/fluent-flow/) | Server — review engine, agent registry, MCP server, webhook handler |
| [fluent-flow-runner](packages/fluent-flow-runner/) | CLI runner — connects to the server, picks up work, spawns agents locally |

## Getting Started

### Server

```bash
cd packages/fluent-flow
cp .env.example .env   # configure DATABASE_URL, GITHUB_TOKEN, MCP_AUTH_TOKEN
npm install
npm run dev
```

See [server docs](packages/fluent-flow/README.md) for full setup, concepts, and configuration.

### Runner

```bash
# 1. Register an agent and generate a token (see runner docs)
# 2. Run
fluent-flow-runner --token ff_<token> --server http://localhost:3847 --verbose
```

See [runner docs](packages/fluent-flow-runner/README.md) for step-by-step setup.

### Docker

```bash
docker compose up -d --build
```

## Documentation

- [Design specs](docs/specs/) — Architecture and design decisions
- [Implementation plans](docs/plans/) — Step-by-step build plans

## Development

This is a [Turborepo](https://turbo.build/) monorepo.

```bash
npm install         # install all dependencies
npm test            # run all tests
npm run build       # build all packages
```

## License

MIT
