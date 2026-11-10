# Superpowers implementation plans

[Documentation index](../../README.md) · [Design specifications](../specs/)

This directory contains executable implementation plans derived from the adjacent Superpowers design specifications. Each plan names exact interfaces, test cycles, verification commands, and commit boundaries for a fresh implementer.

- [2026-11-07-pr-preview-environments.md](2026-11-07-pr-preview-environments.md): per-pull-request preview stacks. Design: [pr-preview-environments](../specs/2026-11-07-pr-preview-environments-design.md).
- [2026-11-08-portable-agent-server.md](2026-11-08-portable-agent-server.md): the cutover from the single-slot runner to the portable agent server (naming, enrollment, concurrent slots, health, dashboard, image and release, documentation). It ends with an execution status table. Design and acceptance status: [portable-agent-server](../specs/2026-11-08-portable-agent-server-design.md). Operator guide: [agent server README](../../../packages/fluent-flow-agent-server/README.md).
