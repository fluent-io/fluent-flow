# Dashboard-Driven Agent Registration — Design

**Status:** Draft
**Date:** 2026-04-18
**Related plan:** [../plans/2026-04-18-dashboard-agent-registration.md](../plans/2026-04-18-dashboard-agent-registration.md)

## Problem

An org admin who has just installed the Fluent Flow GitHub App on their org has no way to register a runner agent without access to `MCP_AUTH_TOKEN` — a server-wide admin secret. The existing bootstrap flow (`packages/fluent-flow-runner/src/bootstrap.js`) assumes the runner operator is the server administrator.

This breaks multi-tenancy: every new SaaS user would have to be handed the server's admin token, giving them unbounded access to every other org's data.

## Goal

An org admin (session-authenticated in the dashboard) can register an agent in three visible steps in a single modal:

1. **Name.** Choose an agent ID + harness (CLI tool the runner will invoke).
2. **Run.** Copy an `npx @fluent-flow/runner@latest run ...` command and execute it on any machine.
3. **Connect.** Modal auto-detects the runner coming online and confirms before the user closes.

No dashboard user ever sees `MCP_AUTH_TOKEN`. Tokens are created in the caller's org scope and cannot affect any other org.

## Non-goals

- Replacing the existing `MCP_AUTH_TOKEN` flow — it stays as the ops / CI path.
- Single-use / 24h-TTL bootstrap tokens — not adding a separate bootstrap-token concept. The dashboard pre-creates a regular long-lived `agent_tokens` row. If leaked, revoke via the existing `/api/agents/[id]/key` flow.
- Server-side routing by `agent_type` — today any runner can claim any work in its org + repo scope. Adding an `a.agent_type = c.agent_type` join is out of scope; the picker is forward-looking metadata.
- Renaming `agent_type` → `harness` in the schema — UI helper text clarifies the distinction from `claim_type` without a migration.

## Architecture

### No new tables

The existing schema supports this natively:

- **`agents`** — dashboard inserts a row with the user's chosen ID + harness, scoped to their org. Transport `long_poll`, repos `[]` (empty — user adds later from the detail page).
- **`agent_tokens`** — dashboard inserts a row with a freshly-generated `ff_...` token, 1-year expiry, label `dashboard-<timestamp>`. Hash stored via SHA-256. Plaintext returned to the browser exactly once.

Both inserts happen in one DB transaction inside the dashboard's session-authed route. Runner uses the token to authenticate via the existing `/api/runner/register` + poll endpoints — no new server-side endpoints required.

### Split of responsibilities

```
┌──────────────────┐   session auth    ┌────────────────────┐
│   Dashboard UI   │ ─── cookie ────▶  │ Dashboard          │
│  (browser SPA)   │                   │ /api/agents POST   │
└──────────────────┘                   └─────────┬──────────┘
                                                 │ @fluent-flow/db
                                                 │ (createAgent +
                                                 │  createToken)
                                                 ▼
                                        ┌────────────────────┐
                                        │   Postgres         │
                                        └────────▲───────────┘
                                                 │
┌──────────────────┐   agent token     ┌─────────┴──────────┐
│ @fluent-flow/    │ ─── Bearer ──────▶│ Fluent-flow server │
│ runner           │                   │ /api/runner/*      │
│ (user's box)     │                   │ (existing)         │
└──────────────────┘                   └────────────────────┘
```

The dashboard writes the agent + token directly via `@fluent-flow/db`. The fluent-flow server isn't touched for this feature — it already accepts any valid `agent_tokens` row as runner authentication.

### Required refactor

Today `createAgent` and `createToken` live in `packages/fluent-flow/src/agents/` and use the Drizzle `db` client from `@fluent-flow/db`. They're only callable from the fluent-flow server process. We move their pure DB-write logic into `packages/db/src/queries/agents.ts` and `packages/db/src/queries/tokens.ts` so the dashboard can call them directly. Thin re-exports stay in the fluent-flow package so existing callers (HTTP handlers) keep working unchanged.

This also addresses a latent issue: the dashboard reads agents via `@fluent-flow/db.listAgents`, but any write path requires proxying through fluent-flow server's admin endpoints — an asymmetry we inherit from before the dashboard existed.

### Connected-state polling

The modal's step 3 shows "Connected" when the agent's first `agent_sessions` row appears with `status = 'online'`. Dashboard polls `GET /api/agents/<id>` every ~2s starting when step 2 renders. The existing dashboard detail route returns session data already; just read `active_session != null`.

Timeout: if no connection after 60 seconds, the modal surfaces a "Skip — I'll connect later" link that closes the modal leaving the agent offline. The user can come back to the agent detail page and run the same runner command at any time (token stays valid).

### Security properties

- **Session-authed writes** — only logged-in users can create agents, and only in orgs where they have `admin` role (gated by `hasRole(session, orgId, 'admin')`).
- **Scoped to caller's org** — dashboard route validates `org_id` in the payload matches one in `session.user.orgs` with admin role. Cross-org registration impossible.
- **Tokens are plaintext-once** — shown in step 2 of the modal, never readable again. If the user closes the modal without copying, they delete the agent and create a new one, or regen via the existing agent-detail key rotation.
- **MCP_AUTH_TOKEN untouched** — ops / CI workflows (including the runner bootstrap via env var) keep working exactly as before.

### Removed: silent `claude-code` defaults

The runner currently falls back to `claude-code` in two places:

- `packages/fluent-flow-runner/src/runner.js:121`: `agentType: work.agentType ?? 'claude-code'`
- `packages/fluent-flow-runner/src/bootstrap.js:22`: `agentType || process.env.FLUENT_FLOW_AGENT_TYPE || 'claude-code'`

Both hide server/runner misconfiguration. They're replaced with explicit throws. Only the dashboard dropdown keeps `claude-code` as a user-visible default — that's a conscious UI choice, not a fallback.

### Alternatives considered

**A. One-time-use bootstrap tokens in a new table.** Original design. Rejected after discussion — over-engineered for current needs. The modal shows the token exactly once; if leaked, revocation via `agent_tokens.revoked_at` already exists. Adding a single-use + short-TTL layer doesn't meaningfully reduce risk and adds schema complexity.

**B. Dashboard proxies to fluent-flow server's admin API.** Rejected — requires either sharing `MCP_AUTH_TOKEN` between dashboard and server (leaks) or adding a session-aware auth mode to fluent-flow (more surface area). Dashboard-writes-direct matches the established pattern for reads.

**C. Auto-generate agent ID from user's GitHub login.** Rejected — users need to distinguish multiple runners (laptop, server, CI). Asking for an ID is one field and removes ambiguity.

### Migration path

- No schema changes.
- `@fluent-flow/db` gains `createAgent` and `createToken` exports. Existing `packages/fluent-flow/src/agents/agent-manager.js` and `token-manager.js` functions delegate to them (preserve auditing + logging, thin pass-through).
- Runner CLI gains no new flags. User still runs `fluent-flow-runner run --token ff_...` — the token is just pre-created by the dashboard instead of by MCP-admin.
