# Implementation plans

[Documentation](../README.md) | [Project](../../README.md) | [Architecture specifications](../specs/)

## Collaborative Kanban and Paseo execution

The approved task-first expansion retains Fluent Flow delivery controls and Flowly execution features. Implementers start with the shared contracts and their ownership slice.

- [Specification](2026-10-19-collaborative-spec.md): approved scope, topology, complete feature retention, pinned upstream sources/licenses and existing-data findings.
- [Shared contracts](2026-10-19-collaborative-contracts.md): identity exports, authorization, canonical resources, HTTP/MCP and connector boundaries.
- [Implementation plan](2026-10-19-collaborative-implementation.md): A/B/C ownership, test-first slices, prerequisite and integration order.
- [Status and acceptance](2026-10-19-collaborative-status.md): all nine UAT scenarios, Flowly retention checklist, evidence log and user-facing errors.

## Earlier plans

- [Connector idle polling fix](2026-11-04-connector-polling-fix.md): honor bounded idle waits, cancel disconnected polls and prevent rapid empty-response loops.
- [Projects overview and shared selection](2026-11-03-projects-spec.md): approved Projects navigation, editable context and header selection; [implementation](2026-11-03-projects-implementation.md).
- [One-command local runner](2026-11-03-local-runner.md): prepares the disposable demo repository, durable local connector and Project A1 execution settings for browser testing.

Dated files in this directory retain previous implementation decisions for agent routing, runner worktrees, dashboard and GitHub integration, onboarding, claim reliability and loop-engine exploration. Their completion claims and product direction must be checked against current source and the approved specification above; they are not current verification evidence.
