---
name: Structured logging with pino + SigNoz OTel export
description: Pino logger with timestamps, LOG_LEVEL, and OpenTelemetry transport for SigNoz
type: project
---

PR #12 migrated all `console.log/error/warn` to pino structured logging. PR #15 added OTel export.

- `src/logger.js` exports a configured pino instance
- `LOG_LEVEL` env var controls verbosity (default: `info`)
- When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, logs are sent to SigNoz/OTel collector via `pino-opentelemetry-transport` (dual output: OTel + stdout)
- `OTEL_SERVICE_NAME` defaults to `fluent-flow`
- Tests use shared mock at `tests/helpers/mock-logger.js` with `createMockLogger()` factory
- SigNoz is set up on the G10 deployment

**How to apply:** Use `import logger from './logger.js'` for all logging. Set `OTEL_EXPORTER_OTLP_ENDPOINT` on deployed instance to enable SigNoz export.
