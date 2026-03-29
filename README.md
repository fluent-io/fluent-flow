# Fluent Flow

Monorepo for the Fluent Flow platform — a config-driven GitHub workflow orchestrator.

## Packages

| Package | Description |
|---|---|
| [packages/fluent-flow](packages/fluent-flow/) | Server — webhook handler, state machine, review pipeline, agent work queue |

## Getting Started

```bash
npm install        # install root + all packages
npm test           # run all tests via Turborepo
```

### Server

```bash
cd packages/fluent-flow
npm run dev
```

### Docker

```bash
docker compose up -d --build
```

## Architecture

See [packages/fluent-flow/README.md](packages/fluent-flow/README.md) for server documentation.
