# Task: Implement GitHub App Provider Integration — Phases 1–7

## What You're Building

Replace PAT-based GitHub auth with a GitHub App behind a provider abstraction. This is the foundation for organic self-service installation of Fluent Flow.

**You are implementing Phases 1–7 only.** Phases 8–14 (dashboard UI, migration, docs) will follow later.

## Plan

Read the full implementation plan at: `docs/plans/2026-04-13-github-app-provider-integration.md`

Read the design spec at: `docs/specs/2026-04-13-github-app-provider-integration-design.md`

**Execute phases 1 through 7, following the TDD pattern specified in each task:**
- RED: Write failing test first
- GREEN: Implement minimal code to pass
- REFACTOR: Clean up
- Breaking-change verify on each commit

## Phases Summary

1. **Schemas** — Zod schemas for repo/org config + provider events (server JS + dashboard TS)
2. **Data model** — SQL migrations + DB helpers for all new tables
3. **Provider abstraction** — `ProviderClient` interface, move `src/github/` to `src/providers/github/`
4. **GitHub App auth** — JWT signer, installation-token cache, thread through REST/GraphQL
5. **Webhook endpoint** — App-level HMAC, installation lifecycle, route registration
6. **Outbound queue** — `enqueueProviderAction`, in-process worker with `FOR UPDATE SKIP LOCKED`
7. **Check run lifecycle** — Wire into claim state transitions, config snapshot in output

## Key Conventions

- **Server code** is in `packages/fluent-flow/` — ESM `.js` files, raw `pg`, Zod, pino, Vitest
- **Dashboard/shared** code is in `packages/db/` — TypeScript, Zod
- **TDD strictly**: every task starts with a failing test
- **Commit after each task** with descriptive messages
- **Keep existing 410+ tests green** at all times
- **No new packages** — no `packages/schemas/` extraction (see Plan corrections)
- Migrations start at `010_` (highest existing is `009_dashboard_users.sql`)
- Server DB helpers under `packages/fluent-flow/src/db/`, not `packages/db/`

## Pre-flight

Before writing any code:
1. Read the plan end-to-end
2. Read existing code paths listed in Pre-flight 2
3. Run `npm test` to confirm baseline (expect 410+ passing)
4. Branch is already created: `feat/github-app-provider-integration`

## When Done

When all phases 1–7 are complete with tests passing, run:
```bash
openclaw system event --text "Done: GitHub App provider integration phases 1-7 complete" --mode now
```
