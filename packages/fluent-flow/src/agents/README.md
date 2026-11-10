# Agent System

DB-backed agent registry, session management, claim-based work queue, and token authentication.

## Architecture

```
Admin API (/api/agents)          Agent server API (/api/agent-server)
        │                                │
        ▼                                ▼
┌─────────────────┐            ┌──────────────────┐
│  agent-manager   │            │  token-manager    │ ← authenticates agent servers
│  org-manager     │            │  session-manager  │ ← registers/tracks slot sessions
└─────────────────┘            │  claim-manager    │ ← assigns/tracks work
                               └──────────────────┘
```

## Modules

### org-manager.js
- `createOrg(id, name)` — create an organization
- `getOrg(id)` — look up org by ID
- `bootstrapSelfHosted()` — idempotent, creates `self-hosted` org on startup

### agent-manager.js
- `createAgent({ id, orgId, agentType, transport, transportMeta, repos })`
- `getAgent(orgId, agentId)` / `listAgents(orgId)`
- `updateAgent(orgId, agentId, fields)` — partial update, only specified fields
- `deleteAgent(orgId, agentId)` — cascades to tokens and sessions

### token-manager.js
Tokens authenticate agent servers. Format: `ff_` prefix (3 chars) + `randomBytes(32).toString('hex')` (64 chars) = 67 chars total. Stored as SHA-256 hex digest.
- `createToken(orgId, agentId, label)` — returns plaintext (shown once). The database layer defaults the expiry to one year.
- `validateToken(plaintext)` — returns `{ org_id, agent_id }` or null. Enrollment credentials never validate here.
- `revokeToken(orgId, tokenId)` — soft revoke
- `listTokens(orgId, agentId)` — hashes redacted

**Enrollment tokens.** The dashboard creates an agent and a single-use credential together (`createAgentWithEnrollment` in `@fluent-flow/db`). The credential has the prefix `enroll_`, a 15-minute expiry and the label `enrollment:<agent id>`, and is stored only as a SHA-256 hash. `POST /api/agent-server/enroll` is mounted before the durable-token middleware and calls `exchangeEnrollmentToken`. One transaction locks the matching unexpired, unrevoked enrollment row, revokes it and inserts a durable `ff_` token labelled `instance:<instance id>`. Invalid, expired, revoked, replayed and non-enrollment credentials all return the same `401`. The route limits attempts to 10 per minute per socket peer (it ignores forwarded headers) and answers `429` beyond that.

### session-manager.js
Sessions are ephemeral and each one is one capacity slot of an agent server. An agent can have many live sessions, one per slot per server instance. Registration metadata (`runtime`, `instance_id`, `slot_id`, `capacity`, `version`, `provider`, `deployment`, `hostname`, `os`) goes into `session_meta`.
- `registerSession(orgId, agentId, meta)` — 5min default TTL
- `touchSession(orgId, agentId, sessionId)` — extends TTL on poll
- `expireSessions()` — marks expired sessions offline. Scheduled on boot via `workers/session-expiry.js` (60s tick); also re-used internally by `expireClaims`.
- `resolveSession(orgId, agentId, repo, prNumber)` — PR affinity → first available
- `setSessionStatus(orgId, agentId, sessionId, status)` — scoped by org+agent

**Read-time status:** display queries (`listAgents`, `getAgentSessions` in `@fluent-flow/db`) project status through a shared `SESSION_STATUS_AT_READ_TIME` SQL fragment — a slot that died without calling `/offline` (crash, sleep, VPN drop) surfaces as `offline` as soon as its stored TTL lapses, without waiting for the expiry worker tick. Routing queries here already AND `expires_at > NOW()`, so dispatch never picks a zombie session. `listAgents` and `getAgentDetail` aggregate live slots into `active_slots`, `capacity`, `deployment` and one status per agent; see the [database README](../../../db/README.md#agent-aggregates).

### claim-manager.js
Claims track work assignments per review attempt.
- `createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType, headSha })` — always creates as `pending` with `session_id = NULL`. No session pre-assignment — slots claim via `claimPendingWork()`.
- `claimPendingWork(orgId, agentId, sessionId)` — atomically transitions a `pending` claim to `claimed`, assigns the session, sets TTL
- `completeClaim(orgId, repo, prNumber, attempt)` — frees session to online, sets `completedAt`
- `failClaim(orgId, repo, prNumber, attempt)` — frees session to online, sets `completedAt`
- `expireClaims()` — marks expired claims, sets sessions offline, sets `completedAt`. Re-dispatch is handled by the expiry worker (see below).
- `getActiveClaim(orgId, repo, prNumber)` — latest pending/claimed claim

**`archivedAt` semantics:** Only set on explicit dismissal/cancellation (e.g. admin archive). Normal completion (`completed`/`failed`) and expiry use `completedAt` + `status` instead, so terminal claims remain visible in the default pipeline view (which filters `archived_at IS NULL`).

## Claim Lifecycle

```
Review fails
     │
     ▼
create verify:red claim (pending, no session)
     │
     ▼
Agent server slot claims → red artifacts pinned with [skip ci]
     │
     ▼
create review_fix claim → a slot's ACP agent pushes fix
     │
     ▼
CI success creates verify:green claim
     │
     ▼
Agent server slot claims → pinned tests + full suite verified
     │
     ├── PASS → re-review → auto-merge if review passes
     ├── FAIL/TAMPERED → stop for human review
     └── expiry → re-dispatch at attempt + 1 (cap at 10)
```

**Key guarantees:**
- Claims are always created as `pending` — no pre-assignment to sessions
- `claimPendingWork()` is the only way a claim moves to `claimed` — atomic CAS
- Long-poll push is a notification hint only — if lost, slots pick up via `claimPendingWork()` on next poll
- Expired claims are automatically re-dispatched at `attempt + 1` (capped at 10) by the expiry worker
- Parent `head_sha` values survive auto-chain and re-dispatch; post-expiry redispatch creates a queued Check Run on the same commit
- A heartbeat for a claim the slot no longer owns returns `claim: null`; the slot cancels its ACP child and reports nothing for that claim

## Multi-tenancy

All tables include `org_id`. Self-hosted deployments use a single `self-hosted` org bootstrapped on startup. All queries are scoped by org.

## DB Tables

- `orgs` — tenant root (migration 005)
- `agents` — agent identities with transport config (migration 005)
- `agent_tokens` — SHA-256 hashed auth tokens (migration 005)
- `agent_sessions` — ephemeral agent server slots with TTL (migration 006)
- `agent_claims` — per-attempt work assignments with claim_type (migration 007)
