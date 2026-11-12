# Fluent Flow Documentation

[Project README](../README.md) · [Roadmap](../ROADMAP.md)

This directory contains product decisions, architecture specifications, implementation plans, and historical project-state material for Fluent Flow.

## Product direction

- [Collaborative Kanban with Paseo execution](plans/2026-10-19-collaborative-spec.md): approved task-first product expansion, retaining GitHub delivery controls and Flowly execution features. [Implementation and contracts](plans/README.md) define the coding boundaries; [acceptance ledger](plans/2026-10-19-collaborative-status.md) records verification separately from approval.

- [Product positioning and competitive landscape](product-positioning-and-competitive-landscape.md) — current collaborative direction, with the earlier verification strategy and dated competitive research retained for context.
- [Project state summary](PROJECT_STATE_SUMMARY.md) — archival implementation snapshot. Use the roadmap for current status.

## Architecture specifications

- [Specifications](specs/) — approved and draft architecture documents covering agent routing, runner worktrees, the dashboard, GitHub integration, loop-engine exploration, and deterministic verification.
- [Object graph and provisioning model](specs/2026-11-12-object-graph-and-provisioning.md) — what entities exist (orgs/repos/agents vs. workspaces/projects/tasks), how the two layers connect, and why a repo can exist with zero projects.

## Implementation plans

- [Plans index](plans/README.md) — current collaborative implementation plan, shared contracts, acceptance status and historical plans.

## Supporting material

- [Superpowers](superpowers/) — imported supporting specifications retained for project history.
