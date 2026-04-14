# GitHub App & Provider Integration Layer

**Date:** 2026-04-13
**Status:** Design approved, pending implementation plan

## Context

Fluent Flow today authenticates to GitHub via per-user PATs and per-repo webhook secrets, with `.fluent-flow/config.yaml` on each repo's default branch as the source of truth. The model is fragile (PATs rot silently, bot users need collaborator seats, per-repo secrets don't scale), blocks first-class PR status (comment-only, no check runs), requires manual onboarding, and hard-codes GitHub into every layer of the server.

This slice replaces GitHub-specific plumbing with a provider abstraction whose first implementation is a GitHub App, ships GitHub Check Runs as the primary review surface, and moves onboarding + repo config into the dashboard so new orgs can self-serve end-to-end.

## Goals

- Single provider-agnostic interface (`ProviderClient`) consumed by engine, notifications, routes, MCP tools.
- GitHub App is the only GitHub auth path — hard cutover from PATs.
- Reviews publish as GitHub Check Runs (queued → in_progress → completed).
- Dashboard supports: GitHub OAuth sign-in → org provisioning → App install → per-repo config — no manual server-side steps.
- DB is the source of truth for repo config; `.fluent-flow/config.yaml` is retired (importer provided for existing repos).

## Non-Goals

- GitLab, Bitbucket, or any non-GitHub provider implementation.
- Per-agent GitHub Apps (one App identity, attribution via comment header).
- Branch-protection or required-check automation (users wire that themselves).
- User-visible coexistence of PAT and App auth (internal flag-gated rollout only; see Migration).

## Architecture

### Provider abstraction

New directory `packages/fluent-flow/src/providers/`:

- `ProviderClient` interface (JSDoc + Zod on inputs/outputs):
  - `listOpenPRs(repo)`, `getPR(repo, number)`, `getDiff(repo, number)`
  - `postComment(repo, prNumber, body)`, `postReview(repo, prNumber, review)`
  - `createCheckRun(repo, input)`, `updateCheckRun(repo, checkRunId, input)`
  - `verifyWebhook(headers, rawBody)`, `parseWebhookEvent(headers, body)`
- `providers/github/` — only implementation in v1. Owns App JWT signing (RS256, 10-min lifetime), installation-token exchange + caching (~50-min TTL), REST/GraphQL clients, webhook HMAC verify, event parser.
- `providers/index.js` — `getProvider(repo) → ProviderClient`. Always returns the GitHub App client in v1. Future providers register here keyed by `repo.provider`.

Engine, notifications, routes, and MCP tools stop importing `src/github/*` directly and consume `getProvider(repo)` only.

### Disposition of existing `src/github/`

| File | Destination |
| --- | --- |
| `rest.js` | `providers/github/rest.js` (installation-token auth instead of PAT) |
| `graphql.js` | `providers/github/graphql.js` |
| `webhook-verify.js` | `providers/github/webhook-verify.js` (App-level HMAC only; per-repo path deleted) |
| `check-run-handler.js` | split: GitHub-specific calls → `providers/github/check-run.js`; claim-lifecycle hooks → `engine/check-run.js` |
| `test-parser.js` | `engine/test-parser.js` (provider-agnostic; stays out of `providers/`) |

### Agent posting model

Agents remain unchanged: they call MCP tools / server endpoints. The server is the sole voice on GitHub. Attribution preserved via a structured comment header the dashboard can render richly:

```
> **getonit** — review
>
> <body>
```

Every outbound write flows through a durable queue so server-posts don't become a silent SPOF.

## Schema package

Zod schemas for repo/org config move out of `packages/fluent-flow/config/` into a **new pg-free package `packages/schemas/`**, consumed by `packages/fluent-flow`, `packages/fluent-flow-runner`, `packages/dashboard`, and `packages/db`. `packages/db` imports schemas but does not re-export them (avoiding a Postgres dep for the runner and dashboard, which never touch `pg` directly). `packages/fluent-flow/config/` keeps defaults/overrides logic and re-exports schemas from `packages/schemas/` during a transition deprecation window, then is simplified.

## Data model

New tables in `packages/db/`:

- `provider_installations`
  - `id`, `org_id`, `provider` (`'github'`), `external_installation_id`, `account_login`, `account_type`, `installed_at`, `suspended_at` (nullable), `permissions` (jsonb), `events` (jsonb)
- `provider_installation_repos`
  - `installation_id` (FK), `repo_external_id` (primary identity), `repo_full_name` (denormalized for display; updated on rename/transfer), `added_at`, `removed_at` (nullable)
- `provider_outbound_queue`
  - `id`, `installation_id`, `kind` (`'comment' | 'review' | 'check_run.create' | 'check_run.update'`), `payload` (jsonb), `client_ref` (unique, for idempotency), `attempts`, `rate_limited_attempts`, `next_attempt_at`, `last_error`, `succeeded_at`, `parked_at` (nullable, for suspended installs)
- `repo_configs`
  - `repo_id` (PK), `default_agent`, `claim_types` (jsonb), `review_model`, `paused`, `updated_by`, `updated_at`
- `repo_config_history`
  - `repo_id`, `patch` (jsonb, JSON Patch / RFC 6902), `actor`, `at`
- `org_config` (required row per org, empty defaults; resolver precedence: `repo_configs` → `org_config` → built-in defaults)

Add `installation_id` on `repos`, nullable during migration; set NOT NULL after cutover. `repos` keyed by `(provider, repo_external_id)` so renames/transfers update `repo_full_name` without breaking identity.

Retire (dropped after cutover migration): per-repo webhook secret column, any PAT columns on agents/repos.

## Webhook flow

Single endpoint `POST /webhooks/github-app`. Verified against one App-level secret.

Event dispatch:

- `installation` (`created` / `deleted` / `suspend` / `unsuspend`) → upsert/soft-delete `provider_installations`; on `suspend`/`deleted` cancel all in-flight claims for that installation (see Installation lifecycle below).
- `installation_repositories` (`added` / `removed`) → upsert `provider_installation_repos` by `repo_external_id`. On `added` where a repo with the same `repo_external_id` exists under a different installation (cross-org transfer), re-link `repos.installation_id` to the new installation in the same transaction. Unknown repos get shell rows so onboarding can complete async.
- `pull_request`, `pull_request_review`, `issue_comment`, `check_run` → existing engine handlers, keyed by `installation_id` instead of per-repo secret.

Token minting: `getInstallationToken(installation_id)` → App JWT → exchange for installation token → TTL-cached.

The legacy `/webhooks/*` route returns HTTP 410 Gone after the cutover migration. During the internal rollout window it returns 503 when the `FF_GITHUB_APP_ENABLED` flag is on.

## Installation lifecycle (revocation mid-claim)

On `installation.suspend` or `installation.deleted`:

1. Mark every in-flight claim tied to this installation as `cancelled` with reason `installation_suspended`.
2. For each such claim with a published check run, call `updateCheckRun` with `conclusion: 'cancelled'` (best-effort; skipped if the token is already invalid).
3. Set `parked_at` on every un-succeeded `provider_outbound_queue` row for the installation; worker skips parked rows.
4. On `installation.unsuspend` or re-install with the same `external_installation_id`, un-park queue rows newer than N hours (configurable; default 24). Older rows stay parked and are surfaced on the dashboard for manual drop.

## Check runs

Lifecycle tied to claims:

- Claim dispatched → `createCheckRun({ name: 'Fluent Flow — <claim_type>', head_sha, status: 'queued' })`; store `external_id` on the claim row.
- Agent picks up → `updateCheckRun({ status: 'in_progress', started_at })`.
- Claim resolves → `updateCheckRun({ status: 'completed', conclusion: 'success' | 'failure' | 'neutral' | 'action_required' | 'cancelled', output: { title, summary, text } })`.
  - `output.text` includes the review body, per-finding list, **and the effective config snapshot** (agent, claim types, model) so policy is discoverable from the PR.
- GitHub check-run conclusion is immutable once completed; `output` fields can be amended. Re-dispatch creates a new check run. Dashboard shows all runs per claim.

## Outbound queue

Every `ProviderClient` write goes through `enqueueProviderAction(...)` which returns immediately.

**Runtime:** the worker runs **in-process** with the server (single Node entry, no separate deployment). Multi-replica safety uses Postgres row locking: `SELECT ... FROM provider_outbound_queue WHERE next_attempt_at <= now() AND parked_at IS NULL AND succeeded_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 1`. No leader election needed — any replica can drain. Single server process today remains fine.

**Idempotency:** `client_ref` is a unique caller-provided key (e.g. `<claim_id>:<kind>`); duplicate enqueues collapse to the existing row. Protects against restart-time double enqueue and multi-replica double enqueue.

**Retries:**

- **Ordinary failures** → exponential backoff on `attempts`, poison threshold 10.
- **GitHub primary rate limit** (403 with reset) → sleep until `x-ratelimit-reset`, do not increment `attempts`.
- **GitHub secondary rate limit / abuse detection** (403 or 429 with `Retry-After`) → honor `Retry-After`, increment `rate_limited_attempts` (separate counter with a higher threshold, e.g. 50), do not trip the poison threshold.
- Poisoned rows stay in place with `last_error` set; dashboard integrations page flags them.

## Self-service signup

1. Landing → "Sign in with GitHub" (existing NextAuth). OAuth scope includes `read:org`.
2. After login, server reads the user's GitHub orgs. Three cases:
   - **No orgs (personal account only):** create a personal org (`type: 'personal'`) keyed by the user's `login`; user is sole member + admin.
   - **One org:** if already provisioned, add the user as `member` (auto-promoted to `admin` if they're a GitHub org admin); else provision the org and make the user `admin`.
   - **Multiple orgs:** dashboard shows an org chooser. Selection provisions the chosen org as above; user can switch orgs from the dashboard later (multi-org membership supported).
3. New orgs land on `/orgs/<slug>/integrations` with "Install GitHub App" as the only primary CTA → deep-links to `https://github.com/apps/<slug>/installations/new?state=<org_id>`.
4. GitHub callback `/api/integrations/github/callback?installation_id=...&state=<org_id>` validates the `state` against the session, polls for the `installation` webhook (up to 30s with visible progress UI; falls back to a manual refresh link if slow), redirects to the integrations page.
5. Repos populate via `installation_repositories`. Each lands as `connected, unconfigured`.

Collision rules:

- `org_login` already provisioned by another user → join as `member` (or `admin` per GitHub role).
- Same `external_installation_id` re-appearing (reinstall) → update the existing row, do not create a duplicate.
- User revokes org access in GitHub → membership row soft-deletes on next session refresh.

## In-dashboard config

- Per-repo config form: agent picker (from `agents` table), claim-type toggles, review model, pause switch.
- **Write path:** dashboard `PATCH /api/orgs/:org/repos/:repo/config` hits a new server HTTP endpoint (on `packages/fluent-flow`, not direct DB), authenticated via the shared NextAuth session. The server endpoint validates input against the shared Zod schema, writes `repo_configs`, appends a `repo_config_history` row with a **JSON Patch diff**, and fires `audit('repo_config_update', ...)`. Dashboard never writes to `pg` directly.
- "Changes" tab per repo renders `repo_config_history` patches.
- `org_config` is a required row per org with empty-defaults; resolver precedence is `repo_configs` → `org_config` → built-in defaults.
- `.fluent-flow/config.yaml` is ignored by the engine.
- Importer CLI `packages/fluent-flow/scripts/import-repo-config.js <repo>` reads the file via installation token, upserts `repo_configs`, prints a diff. One-shot cutover tool.

## Dashboard UI additions

- `/orgs/[org]/integrations` — lists `provider_installations` for the org (status: active / suspended / missing repos); "Install GitHub App" CTA; panel of recent failed and parked outbound queue items.
- `/orgs/[org]/repos/[repo]/config` — config form + history tab.
- "Manage on GitHub" links out to the install's settings page for repo add/remove.

## Migration plan (hard cutover)

1. Provision GitHub App, generate credentials (app id, private key pem, webhook secret, client id/secret), load into server env.
2. Ship SQL migration creating all new tables; add nullable `installation_id` on `repos`; create `packages/schemas/` and update `packages/db`, `packages/fluent-flow`, `packages/fluent-flow-runner`, `packages/dashboard` imports.
3. Deploy server with `FF_GITHUB_APP_ENABLED` flag (default off). App path and PAT path coexist **inside the single deploy only**; flag is internal and never exposed to users.
4. Install the App on dogfood orgs; verify `installation_repositories` populates every active repo.
5. Run `import-repo-config.js` against each dogfood repo; verify `repo_configs` parity.
6. Flip `FF_GITHUB_APP_ENABLED` on; smoke test end-to-end.
7. Cutover migration: drop PAT columns and per-repo webhook secret column; delete the PAT client, per-repo webhook-verify path, and `.yaml` engine loader; make `repos.installation_id` NOT NULL. Legacy `/webhooks/*` route returns 410 Gone.
8. Remove the env flag in the next release.

## Testing

TDD per the project conventions file: Red → Green → Refactor → breaking-change verification → revert.

- **Unit:** App JWT signing, installation-token caching + expiry, webhook HMAC verify, event parser per event type, queue worker backoff/poison/idempotency/`SKIP LOCKED` concurrency, rate-limit separation (primary vs secondary), config resolver precedence (repo → org → defaults), installation-suspend cancellation path.
- **Integration (engine suite):** a `ProviderClient` test fixture replaces existing direct-GitHub mocks. All 381 engine tests keep passing.
- **DB package:** installation + repo upsert/soft-delete, queue state transitions including `parked_at`, `repo_configs` + history with JSON Patch diffs.
- **Dashboard:** signup org-chooser flow, callback state validation, integrations page rendering, repo config form round-trip through the server endpoint (not direct DB), failed-queue panel.
- **Schema package:** ensure `packages/fluent-flow-runner` builds and its tests pass with the new import path — no accidental `pg` dep.
- Target: ≥ current 410 tests, all green, no suite red.

## Critical files

- `packages/schemas/` (new, pg-free) — Zod schemas for repo/org config
- `packages/fluent-flow/src/providers/` (new) — abstraction + GitHub App impl
- `packages/fluent-flow/src/providers/github/` — App JWT, token cache, REST/GraphQL, webhook verify, event parser, check-run calls
- `packages/fluent-flow/src/engine/check-run.js` (new) — provider-agnostic lifecycle hooks
- `packages/fluent-flow/src/engine/test-parser.js` — relocated from `src/github/`
- `packages/fluent-flow/src/routes/webhook.js` — single App endpoint; legacy path returns 410/503
- `packages/fluent-flow/src/routes/repo-config.js` (new) — `PATCH /api/orgs/:org/repos/:repo/config` with audit logging
- `packages/fluent-flow/src/engine/` — call sites consume `getProvider(repo)`; add claim-transition hooks for check runs
- `packages/fluent-flow/src/notifications/` — route outbound through `enqueueProviderAction`
- `packages/fluent-flow/src/mcp/` — MCP tools consume `ProviderClient`
- `packages/fluent-flow/src/workers/outbound.js` (new) — in-process worker with `SELECT ... FOR UPDATE SKIP LOCKED`
- `packages/fluent-flow/scripts/import-repo-config.js` (new) — one-shot importer
- `packages/db/` — new tables, resolver, queue repo helpers
- `packages/dashboard/` — signup auto-provisioning + org chooser, integrations page, repo config page, history tab; all writes through the server endpoint
- `packages/fluent-flow-runner/` — updated schema import path only
- SQL migrations in `packages/fluent-flow/migrations/` (auto-discovered)

## Verification

- Sign in with a fresh GitHub account that belongs to multiple orgs → chooser appears → pick org → org row created → redirected to `/integrations` with install CTA.
- Sign in with a personal-only GitHub account → personal org created, user is admin.
- Sign in with a GitHub user already a member of a provisioned org → joined as `member` (or `admin` if GitHub org admin).
- Click "Install GitHub App" → complete GitHub flow → callback returns to integrations page → installation + repos visible within the 30s poll window.
- Configure a repo from dashboard → server endpoint receives PATCH → audit entry written → open a PR → check run appears `queued` → agent claims → `in_progress` → resolves → `completed` with correct conclusion and config snapshot in `output.text`.
- Suspend the App from GitHub → `suspended_at` populates, in-flight claims cancel with reason, in-flight check runs update to `cancelled`, outbound queue rows park. Unsuspend → recent rows un-park.
- Transfer a repo between two installed orgs → `repos.installation_id` re-links, `repo_full_name` updates, subsequent posts succeed on the new installation.
- Kill the outbound worker mid-drain, restart → no duplicate posts (verified by unique `client_ref`).
- Saturate GitHub secondary rate limit → worker honors `Retry-After`, `rate_limited_attempts` climbs, `attempts` does not, no poison trip.
- Hit `/webhooks/legacy-path` after cutover → 410 Gone.
- `npm test` from root passes ≥410 tests.
- Breaking-change check: flip `createCheckRun` to return a bad conclusion; confirm the check-run test fails; revert; confirm green.
