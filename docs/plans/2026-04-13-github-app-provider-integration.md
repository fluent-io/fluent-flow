# GitHub App & Provider Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution (no subagents) per project preference.

**Goal:** Replace PAT-based GitHub auth with a GitHub App behind a provider abstraction, add check runs, move repo config into the DB, and enable self-service signup — all shipped as one PR.

**Architecture:** New `packages/schemas/` (pg-free) hosts Zod config schemas. `packages/fluent-flow/src/providers/` introduces a `ProviderClient` interface whose sole v1 implementation is GitHub App. All GitHub I/O flows through a durable pg-backed outbound queue with a worker running in-process on the server, using `FOR UPDATE SKIP LOCKED` for replica safety. Check runs are tied to claim lifecycle. Dashboard auto-provisions orgs on first GitHub OAuth login and writes repo config through a new server HTTP endpoint with audit logging. Hard cutover from PATs gated behind an internal `FF_GITHUB_APP_ENABLED` flag.

**Tech Stack:** Node.js ESM, raw `pg`, Zod, pino, Vitest, Next.js 15, NextAuth, shadcn/ui, Turborepo.

**Spec:** [docs/specs/2026-04-13-github-app-provider-integration-design.md](../specs/2026-04-13-github-app-provider-integration-design.md)

---

## Plan corrections (post pre-flight recon)

Reality check against the codebase surfaced these corrections — they override the spec where they conflict:

1. **No new `packages/schemas/` package.** Server (`packages/fluent-flow`, `.js`) and dashboard (`packages/db` TS + Next.js) already maintain separate Zod schemas today. Server doesn't import `@fluent-flow/db`. Following existing convention: add server-side Zod for write validation in `packages/fluent-flow/src/config/provider-schema.js`; add dashboard-side TS Zod + queries under `packages/db/src/schemas/` and `packages/db/src/queries/`.
2. **Migrations live at `packages/fluent-flow/src/db/migrations/`.** Current highest is `009_dashboard_users.sql`. New migrations start at `010_*`.
3. **Server DB helpers live under `packages/fluent-flow/src/db/`** using the existing `client.js` pool, not `packages/db/`.
4. **Repo-config schema does not currently exist** at `packages/fluent-flow/config/` (that dir only has YAML files). The existing `packages/fluent-flow/src/config/schema.js` defines server config schemas; we add new ones alongside without extracting anything.
5. **Runner does not import schemas from any other package.** The "runner breaks on schema move" blocker was a phantom — no mitigation required.
6. **Phase 1 is replaced with a much smaller task: add new Zod schemas in both places.** See below.

---

## Pre-flight

- [ ] **Pre-flight 1: Read the spec end-to-end.** Open [docs/specs/2026-04-13-github-app-provider-integration-design.md](../specs/2026-04-13-github-app-provider-integration-design.md). Confirm the section-by-section scope matches the phases below.

- [ ] **Pre-flight 2: Read existing GitHub code paths.** Open and skim:
  - `packages/fluent-flow/src/github/rest.js`
  - `packages/fluent-flow/src/github/graphql.js`
  - `packages/fluent-flow/src/github/webhook-verify.js`
  - `packages/fluent-flow/src/github/check-run-handler.js`
  - `packages/fluent-flow/src/github/test-parser.js`
  - `packages/fluent-flow/src/routes/webhook.js`
  - `packages/fluent-flow/config/` (entire directory)
  - `packages/fluent-flow/src/engine/` (top-level files only)
  - `packages/db/src/` (full)
  - `packages/dashboard/app/` (route structure)

  Note existing function signatures, audit usage, logger usage, and test fixtures before writing code in later tasks.

- [ ] **Pre-flight 3: Baseline tests.** Run `npm test` from repo root. Record pass count (expect 410). All subsequent phases must keep this ≥410 and green.

- [ ] **Pre-flight 4: Branch.** `git checkout -b feat/github-app-provider-integration`.

---

## Phase 1 — Add new Zod schemas (server + dashboard)

**Goal:** Add Zod schemas for repo config, org config, and provider webhook events. Server side (`.js`) for write validation; dashboard side (`.ts`) for rendering. No package extraction.

**Files:**
- Create: `packages/fluent-flow/src/config/provider-schema.js` (server-side Zod)
- Create: `packages/fluent-flow/tests/config/provider-schema.test.js`
- Create: `packages/db/src/schemas/repo-config.ts`, `packages/db/src/schemas/org-config.ts`, `packages/db/src/schemas/provider-events.ts` (dashboard-side TS Zod)

### Task 1.1: Server-side schemas + tests

- [ ] **Step 1: Write failing test** at `packages/fluent-flow/tests/config/provider-schema.test.js` covering:
  - `RepoConfigSchema.parse({ default_agent: 'getonit', claim_types: ['review'], review_model: 'claude-opus-4-6', paused: false })` succeeds.
  - Parsing an unknown `claim_types` entry throws.
  - `OrgConfigSchema.parse({})` succeeds (all fields optional).
  - `GitHubWebhookEventSchema` discriminated union accepts `installation.created`, `installation_repositories.added`, `pull_request.opened` payloads; rejects an unknown event name.

- [ ] **Step 2: Run, expect failure** (module not found): `cd packages/fluent-flow && npm test -- --run tests/config/provider-schema.test.js`.

- [ ] **Step 3: Implement `packages/fluent-flow/src/config/provider-schema.js`** exporting `RepoConfigSchema`, `OrgConfigSchema`, and `GitHubWebhookEventSchema`. ESM, no non-zod imports.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify.** Remove `'review'` from the `claim_types` enum → first test fails → revert → passes.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/fluent-flow/src/config/provider-schema.js packages/fluent-flow/tests/config/provider-schema.test.js
  git commit -m "feat(config): add provider + repo/org config schemas"
  ```

### Task 1.2: Dashboard-side TS schemas

- [ ] **Step 1: Write failing test** at `packages/fluent-flow/tests/db/schemas/repo-config.test.ts` using vitest, covering the same three schemas (TS versions).

- [ ] **Step 2: Run, expect failure** (module not found): `cd packages/db && npm test`.

- [ ] **Step 3: Implement** `packages/db/src/schemas/repo-config.ts`, `org-config.ts`, `provider-events.ts` mirroring the JS versions but in TypeScript. Export from `packages/db/src/schemas/index.ts`.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** on one field; revert.

- [ ] **Step 6: Commit** `feat(db): add TS schemas for repo/org config and provider events`.

---

## Phase 2 — Data model

**Goal:** Ship SQL migrations for all new tables and helper functions. Server-side migrations + helpers under `packages/fluent-flow/src/db/`; dashboard-side TS read queries under `packages/db/src/queries/`. No behavioral change yet.

**Files:**
- Create: `packages/fluent-flow/src/db/migrations/010_provider_installations.sql`, `011_provider_installation_repos.sql`, `012_provider_outbound_queue.sql`, `013_repo_configs.sql`, `014_repo_config_history.sql`, `015_org_config.sql`, `016_repos_add_installation_id.sql`
- Create: `packages/fluent-flow/src/db/provider-installations.js`, `outbound-queue.js`, `repo-configs.js`
- Create: `packages/fluent-flow/tests/db/provider-installations.test.js`, `outbound-queue.test.js`, `repo-configs.test.js`
- Create (dashboard read): `packages/db/src/queries/provider-installations.ts`, `outbound-queue.ts`, `repo-configs.ts` + tests

### Task 2.1: Migrations (server)

- [ ] **Step 1: Write `010_provider_installations.sql`** per Data model section of the spec. Include indexes on `org_id`, `external_installation_id UNIQUE`.

- [ ] **Step 2: Write `011_provider_installation_repos.sql`** with FK to `provider_installations(id)`, index on `repo_external_id`, unique `(installation_id, repo_external_id)`.

- [ ] **Step 3: Write `012_provider_outbound_queue.sql`** with columns per spec; index on `(next_attempt_at) WHERE succeeded_at IS NULL AND parked_at IS NULL`; unique on `client_ref`.

- [ ] **Step 4: Write `013_repo_configs.sql`**.

- [ ] **Step 5: Write `014_repo_config_history.sql`** with FK to `repos`, index on `(repo_id, at DESC)`.

- [ ] **Step 6: Write `015_org_config.sql`** — one row per org, seed empty row on org creation (handled in dashboard task).

- [ ] **Step 7: Write `016_repos_add_installation_id.sql`** — `ALTER TABLE repos ADD COLUMN installation_id BIGINT REFERENCES provider_installations(id)` (nullable).

- [ ] **Step 8: Run migrations locally.** `cd packages/fluent-flow && npm run migrate`. Expect all applied, no errors.

- [ ] **Step 9: Verify.** `\dt` in psql shows new tables.

- [ ] **Step 10: Commit** `feat(db): add provider + config tables`.

### Task 2.2: `provider-installations` repo helpers

- [ ] **Step 1: Failing test** in `packages/fluent-flow/tests/db/provider-installations.test.js`:
  ```js
  import { describe, it, expect, beforeEach } from 'vitest';
  import { pool } from '../../src/db/client.js';
  import { upsertInstallation, softDeleteInstallation, addRepoToInstallation, findInstallationByExternalId } from '../../src/db/provider-installations.js';

  describe('provider-installations', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE provider_installation_repos, provider_installations RESTART IDENTITY CASCADE');
    });

    it('upserts by external_installation_id', async () => {
      const a = await upsertInstallation({ org_id: 1, external_installation_id: 999, account_login: 'acme', account_type: 'Organization', permissions: {}, events: [] });
      const b = await upsertInstallation({ org_id: 1, external_installation_id: 999, account_login: 'acme', account_type: 'Organization', permissions: { checks: 'write' }, events: [] });
      expect(a.id).toBe(b.id);
      expect(b.permissions.checks).toBe('write');
    });

    it('soft-deletes on suspend', async () => {
      const i = await upsertInstallation({ org_id: 1, external_installation_id: 1000, account_login: 'x', account_type: 'Organization', permissions: {}, events: [] });
      await softDeleteInstallation(i.id);
      const found = await findInstallationByExternalId(1000);
      expect(found.suspended_at).not.toBeNull();
    });

    it('re-links repo to new installation on cross-org transfer', async () => {
      const a = await upsertInstallation({ org_id: 1, external_installation_id: 1, account_login: 'a', account_type: 'Organization', permissions: {}, events: [] });
      const b = await upsertInstallation({ org_id: 2, external_installation_id: 2, account_login: 'b', account_type: 'Organization', permissions: {}, events: [] });
      await addRepoToInstallation(a.id, { repo_external_id: 42, repo_full_name: 'a/r' });
      await addRepoToInstallation(b.id, { repo_external_id: 42, repo_full_name: 'b/r' });
      const rows = await pool.query('SELECT installation_id, repo_full_name FROM provider_installation_repos WHERE repo_external_id = 42 AND removed_at IS NULL');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].installation_id).toBe(b.id);
      expect(rows.rows[0].repo_full_name).toBe('b/r');
    });
  });
  ```

- [ ] **Step 2: Run, expect failure** (module does not exist).

- [ ] **Step 3: Implement `packages/fluent-flow/src/db/provider-installations.js`** exporting `upsertInstallation`, `softDeleteInstallation`, `unsuspendInstallation`, `findInstallationByExternalId`, `addRepoToInstallation`, `removeRepoFromInstallation`. Use raw `pg` per project convention. Include pino log lines at info level on each mutation.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify.** In `addRepoToInstallation` remove the re-link branch → test fails → revert → passes.

- [ ] **Step 6: Commit** `feat(db): provider installations + repo helpers with cross-org transfer`.

### Task 2.3: Outbound queue helpers

- [ ] **Step 1: Failing test** in `packages/fluent-flow/tests/db/outbound-queue.test.js` covering:
  - `enqueue({ installation_id, kind, payload, client_ref })` inserts; second call with same `client_ref` is a no-op returning existing row.
  - `claimNext()` uses `FOR UPDATE SKIP LOCKED` — two parallel `claimNext()` calls never return the same row (use `Promise.all` with two pool clients in a transaction each).
  - `markSucceeded(id)` sets `succeeded_at`.
  - `markFailed(id, { error, rateLimited })` increments the right counter based on flag, computes backoff.
  - `parkForInstallation(installation_id)` sets `parked_at` on open rows.
  - `unparkForInstallation(installation_id, sinceHours)` clears `parked_at` only on recent rows.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `packages/db/src/outbound-queue.js`.** `claimNext` must wrap in `BEGIN; SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1; UPDATE ... SET attempts = attempts + 1; COMMIT;`. Backoff formula: `next_attempt_at = now() + interval '1 second' * least(300, 2 ^ attempts)`.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify.** Drop `SKIP LOCKED` → concurrency test fails → restore.

- [ ] **Step 6: Commit** `feat(db): outbound queue helpers with SKIP LOCKED`.

### Task 2.4: Repo config + history helpers

- [ ] **Step 1: Failing test** covering:
  - `upsertRepoConfig(repo_id, patch, actor)` validates via `RepoConfigSchema`, writes to `repo_configs`, appends a `repo_config_history` row whose `patch` column is a JSON Patch (RFC 6902) diff of old→new.
  - `resolveRepoConfig(repo_id)` returns merged `defaults ← org_config ← repo_configs`.
  - `listRepoConfigHistory(repo_id)` returns patches in reverse chronological order.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `packages/db/src/repo-configs.js`.** Use the `fast-json-patch` package to compute diffs (`npm install fast-json-patch -w packages/db`).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** on precedence (swap `org_config` and `repo_configs` override order → test fails → revert).

- [ ] **Step 6: Commit** `feat(db): repo config resolver + JSON Patch history`.

---

## Phase 3 — Provider abstraction skeleton

**Goal:** Create the interface surface and move `src/github/*` into `src/providers/github/*` with zero behavioral change. Engine/routes/notifications/MCP still compile.

**Files:**
- Create: `packages/fluent-flow/src/providers/index.js`, `providers/client.js` (JSDoc interface), `providers/github/index.js`
- Move: `src/github/rest.js`, `graphql.js`, `webhook-verify.js` → `src/providers/github/`
- Move: `src/github/test-parser.js` → `src/engine/test-parser.js`
- Split: `src/github/check-run-handler.js` → `src/providers/github/check-run.js` + `src/engine/check-run.js`
- Modify: every importer of `src/github/*` (use `rg "from.*src/github" packages/fluent-flow/src` to enumerate)

### Task 3.1: Define `ProviderClient` interface

- [ ] **Step 1: Write interface file** `packages/fluent-flow/src/providers/client.js` — JSDoc `@typedef ProviderClient` listing all methods (per spec Architecture § Provider abstraction). Export nothing executable; this is type-only documentation.

- [ ] **Step 2: Commit** `feat(providers): document ProviderClient interface`.

### Task 3.2: Mechanical move of `src/github/`

- [ ] **Step 1: `git mv`** the four files per the disposition table.

- [ ] **Step 2: Update all importers.** `rg "from.*src/github" packages/fluent-flow/src` → update each path. `test-parser` moves to `engine/`.

- [ ] **Step 3: Update test fixtures.** `rg "src/github" packages/fluent-flow/tests` — update.

- [ ] **Step 4: Run `npm test -w packages/fluent-flow`.** Expect 381 tests pass (unchanged).

- [ ] **Step 5: Commit** `refactor: move src/github to src/providers/github`.

### Task 3.3: Split check-run-handler

- [ ] **Step 1: Read current handler.** Open `packages/fluent-flow/src/providers/github/check-run-handler.js`. Identify what is GitHub-API (REST calls, payload shaping) vs what is claim-lifecycle logic (when to create/update, state transitions).

- [ ] **Step 2: Failing test for `engine/check-run.js`.** Write `packages/fluent-flow/tests/engine/check-run.test.js` that asserts: given a mock `ProviderClient`, `onClaimDispatched(claim)` calls `client.createCheckRun` with `{ name, head_sha, status: 'queued' }`. Also: `onClaimStarted` → `updateCheckRun({status: 'in_progress'})`, `onClaimResolved({conclusion: 'success'})` → `updateCheckRun({status: 'completed', conclusion: 'success'})`.

- [ ] **Step 3: Run, expect failure.**

- [ ] **Step 4: Create `engine/check-run.js`** with three exported functions taking `(providerClient, claim)` and the right calls. Create `providers/github/check-run.js` with GitHub-specific request shaping (moved from old handler).

- [ ] **Step 5: Run test, expect pass. Re-run full suite, expect 381+3 = 384.**

- [ ] **Step 6: Breaking-change verify** (change `'queued'` to `'pending'` → test fails → revert).

- [ ] **Step 7: Commit** `refactor: split check-run into engine + provider halves`.

### Task 3.4: Resolver `getProvider(repo)`

- [ ] **Step 1: Failing test** `tests/providers/resolver.test.js`:
  ```js
  import { describe, it, expect } from 'vitest';
  import { getProvider } from '../../src/providers/index.js';

  it('returns github App client for provider=github', () => {
    const client = getProvider({ provider: 'github', installation_id: 1 });
    expect(typeof client.postComment).toBe('function');
    expect(typeof client.createCheckRun).toBe('function');
  });

  it('throws on unknown provider', () => {
    expect(() => getProvider({ provider: 'gitlab' })).toThrow(/unsupported provider/i);
  });
  ```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `providers/index.js`.** Build the client by wrapping existing `rest.js`/`graphql.js` exports behind the `ProviderClient` shape. Stub `createCheckRun`/`updateCheckRun` using the existing check-run code.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(providers): getProvider resolver`.

---

## Phase 4 — GitHub App auth

**Goal:** Replace PAT auth inside `providers/github/` with App JWT + installation-token exchange, cached. PAT client path remains callable but deprecated in code comments.

**Files:**
- Create: `packages/fluent-flow/src/providers/github/app-auth.js`, `providers/github/token-cache.js`
- Create: `packages/fluent-flow/tests/providers/github/app-auth.test.js`, `token-cache.test.js`
- Modify: `providers/github/rest.js`, `graphql.js` to accept `installation_id` and call `getInstallationToken(...)` instead of reading a PAT
- Modify: server startup to load `FF_GITHUB_APP_ID`, `FF_GITHUB_APP_PRIVATE_KEY`, `FF_GITHUB_APP_WEBHOOK_SECRET` from env

### Task 4.1: App JWT signer

- [ ] **Step 1: Failing test** — sign a JWT with a test RSA key, decode header/payload, assert `alg: 'RS256'`, `iss` = app id, `iat`/`exp` ~10 min apart. Use a fixture private key committed under `tests/fixtures/test-app.pem`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `app-auth.js` `signAppJwt({ appId, privateKeyPem })`.** Use Node's `crypto` — no new deps if possible; else add `jsonwebtoken`.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** (set exp to 1 hour — assert test catches it).

- [ ] **Step 6: Commit** `feat(providers/github): App JWT signer`.

### Task 4.2: Installation-token cache

- [ ] **Step 1: Failing test** covering:
  - First call for `installation_id` fetches via `fetch` mock, caches, returns token.
  - Second call within TTL returns cached token without refetch.
  - After TTL expiry, refetches.
  - Concurrent calls for the same `installation_id` coalesce to one fetch (single-flight).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `token-cache.js`.** In-memory `Map<installation_id, {token, expiresAt, inflight?}>`. TTL = 50 min.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** (disable single-flight → concurrent-calls test fails → restore).

- [ ] **Step 6: Commit** `feat(providers/github): installation token cache with single-flight`.

### Task 4.3: Thread `installation_id` through REST/GraphQL

- [ ] **Step 1: Failing test** at `tests/providers/github/rest.test.js`: `postComment({ installation_id: 123, ... })` calls `getInstallationToken(123)` and uses the returned token in `Authorization: token ...` header.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Refactor `rest.js` and `graphql.js`** to take `installation_id` and call the cache for each request.

- [ ] **Step 4: Update every existing call site** in `engine/`, `notifications/`, `mcp/`, `routes/` to pass `installation_id` (read from `repos.installation_id`). This is mechanical — use `rg "postComment\(|postReview\(|createCheckRun\(" packages/fluent-flow/src` to enumerate.

- [ ] **Step 5: Run full suite.** Expect green.

- [ ] **Step 6: Breaking-change verify** (remove Authorization header append → request test fails → restore).

- [ ] **Step 7: Commit** `feat(providers/github): use installation tokens in REST/GraphQL`.

### Task 4.4: Env config

- [ ] **Step 1: Add env vars to server bootstrap.** Find where env is read (likely `packages/fluent-flow/src/config/env.js` or similar — search with `rg "process.env" packages/fluent-flow/src | head -20`). Add `FF_GITHUB_APP_ID`, `FF_GITHUB_APP_PRIVATE_KEY` (base64 pem), `FF_GITHUB_APP_WEBHOOK_SECRET`, `FF_GITHUB_APP_CLIENT_ID`, `FF_GITHUB_APP_CLIENT_SECRET`, `FF_GITHUB_APP_ENABLED` (bool).

- [ ] **Step 2: Test** — boot server without the vars, expect startup error; with them, expect success.

- [ ] **Step 3: Document** required env vars in `packages/fluent-flow/README.md` (append a subsection).

- [ ] **Step 4: Commit** `feat(config): GitHub App env vars + flag`.

---

## Phase 5 — Webhook endpoint + installation lifecycle

**Goal:** Single `POST /webhooks/github-app` endpoint verified against the App secret; dispatches `installation`, `installation_repositories`, and existing event types. Installation suspend/delete cancels in-flight claims and parks the queue.

**Files:**
- Create: `packages/fluent-flow/src/routes/github-app-webhook.js`
- Create: `packages/fluent-flow/src/engine/installation-lifecycle.js`
- Modify: `packages/fluent-flow/src/routes/webhook.js` (legacy path returns 503 when flag on, 410 post-cutover)
- Modify: existing webhook handler dispatch to key by `installation_id`

### Task 5.1: App-level HMAC verify

- [ ] **Step 1: Failing test** in `tests/providers/github/webhook-verify.test.js`: a valid HMAC-SHA256 body/signature pair verifies; a tampered one rejects; a missing signature rejects.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Rewrite `providers/github/webhook-verify.js`** to use the single `FF_GITHUB_APP_WEBHOOK_SECRET`, timing-safe compare.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** `feat(providers/github): App-level HMAC webhook verify`.

### Task 5.2: `installation` event handler

- [ ] **Step 1: Failing test** at `tests/routes/github-app-webhook.test.js`:
  - POST with `X-GitHub-Event: installation`, action=`created`, valid signature → `upsertInstallation` called with right fields, `org_id` resolved via `account_login` (create shell org row if missing).
  - action=`suspend` → `softDeleteInstallation`, in-flight claims for this installation marked `cancelled` with reason `installation_suspended`, check runs receive `updateCheckRun({conclusion: 'cancelled'})` (skipped gracefully on 401), queue rows parked.
  - action=`unsuspend` → `unsuspendInstallation`, queue rows younger than 24h un-parked.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `routes/github-app-webhook.js`** and `engine/installation-lifecycle.js`. Use the engine's existing claim-query helpers; add a query for "in-flight claims by installation_id" if none exists.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** — skip the parked-queue step → test fails → restore.

- [ ] **Step 6: Commit** `feat(engine): installation lifecycle cancels claims + parks queue`.

### Task 5.3: `installation_repositories` handler

- [ ] **Step 1: Failing test** covers `added` (new repo rows, link to installation, shell row for unknown repo) and `removed` (soft-delete `provider_installation_repos` row, leave `repos.installation_id` alone for audit).

- [ ] **Step 2: Implement + verify pass + breaking-change + commit** `feat(engine): installation_repositories handler`.

### Task 5.4: Thread existing event handlers through installation_id

- [ ] **Step 1: Failing test** — `pull_request.opened` webhook handler reads `installation_id` from event payload, looks up `repos.installation_id`, and proceeds. No `repos.webhook_secret` is read.

- [ ] **Step 2: Refactor existing handlers** (`pull_request`, `pull_request_review`, `issue_comment`, `check_run`) — enumerate by `rg "event.*pull_request" packages/fluent-flow/src`.

- [ ] **Step 3: Run, expect pass. Full suite green.**

- [ ] **Step 4: Commit** `refactor(engine): webhook handlers keyed by installation_id`.

### Task 5.5: Route registration + legacy path

- [ ] **Step 1: Register the new route** in the server's route loader (find with `rg "routes/webhook" packages/fluent-flow/src`).

- [ ] **Step 2: Legacy `/webhooks/*` path** — when `FF_GITHUB_APP_ENABLED` is true, return HTTP 503 with JSON `{error: 'legacy webhook disabled during cutover'}`. After cutover (Phase 14), replace with 410.

- [ ] **Step 3: Test** both behaviors. Commit `feat(routes): register App webhook, gate legacy path`.

---

## Phase 6 — Outbound queue + worker

**Goal:** All provider writes go through `enqueueProviderAction`. In-process worker drains the queue with `FOR UPDATE SKIP LOCKED`, exponential backoff, and separate rate-limit accounting.

**Files:**
- Create: `packages/fluent-flow/src/providers/enqueue.js`
- Create: `packages/fluent-flow/src/workers/outbound.js`
- Create: `packages/fluent-flow/tests/workers/outbound.test.js`
- Modify: `providers/index.js` — wrap write methods of the returned client in `enqueueProviderAction`; reads stay synchronous.

### Task 6.1: `enqueueProviderAction` + wrapping

- [ ] **Step 1: Failing test** — `getProvider(repo).postComment(...)` inserts a queue row with `kind='comment'`, correct `client_ref`, and returns immediately (no HTTP fetched in the test).

- [ ] **Step 2: Implement `providers/enqueue.js`** `enqueueProviderAction(installation_id, kind, payload, client_ref)` → calls `db.outboundQueue.enqueue`.

- [ ] **Step 3: Wrap the resolver.** In `providers/index.js`, the returned client's `postComment`, `postReview`, `createCheckRun`, `updateCheckRun` become thin shims that build a `client_ref` (`<claim_id>:<kind>:<hash>`) and call `enqueueProviderAction`. Reads (`listOpenPRs`, `getPR`, `getDiff`, `verifyWebhook`, `parseWebhookEvent`) remain direct.

- [ ] **Step 4: Run, expect pass. Full suite.**

- [ ] **Step 5: Breaking-change verify** — remove `client_ref` uniqueness → duplicate-enqueue test fails.

- [ ] **Step 6: Commit** `feat(providers): route writes through outbound queue`.

### Task 6.2: Worker drain loop

- [ ] **Step 1: Failing test** at `tests/workers/outbound.test.js`:
  - `drainOnce()` claims one row, invokes the right HTTP call (via a test `fetch` mock), marks succeeded on 200.
  - On 500 → increments `attempts`, sets `next_attempt_at` per backoff, leaves row unsucceeded.
  - On 403 with `X-RateLimit-Remaining: 0` → sleeps until reset, does NOT increment `attempts`.
  - On 429 with `Retry-After: 10` → increments `rate_limited_attempts` only, honors delay.
  - `attempts >= 10` → row stays, `last_error` set, further `claimNext()` skips until `next_attempt_at`.
  - Two workers drained in parallel never claim the same row (assert via concurrent `drainOnce()` calls against a seeded table).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement `workers/outbound.js`.** Dispatch `kind` to the right direct HTTP call (bypassing the enqueue-wrapped client — use raw REST from `providers/github/rest.js` in un-wrapped mode). Export `startOutboundWorker()` that runs a loop with small sleep on empty.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Breaking-change verify** — drop the `Retry-After` branch → secondary-rate-limit test fails → restore.

- [ ] **Step 6: Wire into server startup.** Find bootstrap (`rg "listen\(" packages/fluent-flow/src | head`). Call `startOutboundWorker()` after server is listening.

- [ ] **Step 7: Commit** `feat(workers): outbound queue drainer with rate-limit separation`.

---

## Phase 7 — Check run lifecycle hooks

**Goal:** Wire `engine/check-run.js` into claim state transitions. Every claim dispatch/start/resolve emits a check-run action through the queue. Effective config snapshot included in `output.text`.

**Files:**
- Modify: `packages/fluent-flow/src/engine/` — identify state-transition points (from pre-flight reading)
- Modify: `engine/check-run.js` — add `output.text` composer that includes config snapshot
- Modify: claims table — add `check_run_external_id` column if not present

### Task 7.1: Claims table column

- [ ] **Step 1: Migration** `NNN+7_claims_add_check_run_external_id.sql` — `ALTER TABLE claims ADD COLUMN check_run_external_id BIGINT`.

- [ ] **Step 2: Run migration.** Commit.

### Task 7.2: Wire transitions

- [ ] **Step 1: Failing test** — simulate claim dispatch: engine calls `enqueueProviderAction('check_run.create', ...)` with correct payload; stores returned id on claim.

- [ ] **Step 2: Identify transition points** (likely `engine/state-machine.js` or similar). Insert hook calls at dispatch/start/resolve.

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Commit** `feat(engine): emit check-run lifecycle on claim transitions`.

### Task 7.3: Config snapshot in `output.text`

- [ ] **Step 1: Failing test** — on resolve, `output.text` contains a fenced code block with `default_agent`, `claim_types`, `review_model` exactly as returned by `resolveRepoConfig(repo_id)`.

- [ ] **Step 2: Implement composer** in `engine/check-run.js`.

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Commit** `feat(engine): include config snapshot in check-run output`.

---

## Phase 8 — Server config endpoint

**Goal:** Dashboard writes repo config through a new server HTTP endpoint; no direct DB writes from Next.js. Audit logging fires.

**Files:**
- Create: `packages/fluent-flow/src/routes/repo-config.js`
- Create: `packages/fluent-flow/tests/routes/repo-config.test.js`

### Task 8.1: Endpoint

- [ ] **Step 1: Failing test** — `PATCH /api/orgs/:org/repos/:repo/config` with valid session cookie + valid body returns 200, writes `repo_configs`, appends history, fires `audit('repo_config_update', {...})`. Invalid session → 401. Invalid body → 400 with Zod errors. Caller without `admin` role on the org → 403.

- [ ] **Step 2: Implement `routes/repo-config.js`.** Reuse existing session middleware (find with `rg "session" packages/fluent-flow/src/routes/`).

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Breaking-change verify** — skip audit fire → test fails.

- [ ] **Step 5: Commit** `feat(routes): repo config PATCH with audit logging`.

---

## Phase 9 — Dashboard: signup + org chooser

**Goal:** NextAuth post-sign-in flow auto-provisions orgs per spec rules (no/one/multi).

**Files:**
- Modify: `packages/dashboard/app/api/auth/[...nextauth]/route.ts` (or wherever NextAuth callback lives)
- Create: `packages/dashboard/app/signup/choose-org/page.tsx`
- Create: `packages/dashboard/tests/signup.test.ts`

### Task 9.1: OAuth scope + org fetch

- [ ] **Step 1: Update NextAuth provider config** to request `read:org` scope.

- [ ] **Step 2: Add signIn callback** that, on first login, calls GitHub `/user/orgs` with the access token, stores the list on the session.

- [ ] **Step 3: Test** using mocked GitHub API.

- [ ] **Step 4: Commit** `feat(dashboard): fetch user GitHub orgs on sign-in`.

### Task 9.2: Auto-provision + chooser

- [ ] **Step 1: Failing test** covering:
  - No orgs → creates `orgs` row with `type='personal'`, slug = user's `login`, user is `admin` + sole member; redirect target is `/orgs/<login>/integrations`.
  - One org → provisions if absent (user is `admin` if GitHub org admin, else `member`); redirect to that org's integrations page.
  - Multiple orgs → redirect to `/signup/choose-org`.

- [ ] **Step 2: Implement** in the NextAuth `signIn` callback (or a post-auth redirect layout).

- [ ] **Step 3: Build `/signup/choose-org/page.tsx`** — server component listing the user's orgs; client submit posts to a server action that provisions + redirects.

- [ ] **Step 4: Collision handling** — org with same slug already provisioned → join existing as member/admin per GitHub role; same `external_installation_id` reinstall → update in place.

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit** `feat(dashboard): org auto-provisioning + chooser`.

---

## Phase 10 — Dashboard: integrations page + callback

**Files:**
- Create: `packages/dashboard/app/orgs/[slug]/integrations/page.tsx`
- Create: `packages/dashboard/app/api/integrations/github/callback/route.ts`
- Create: `packages/dashboard/tests/integrations.test.ts`

### Task 10.1: Install callback

- [ ] **Step 1: Failing test** — GET `/api/integrations/github/callback?installation_id=123&state=<signed-org-id>` validates `state` against session, polls `findInstallationByExternalId(123)` up to 30s, redirects to `/orgs/<slug>/integrations`. Invalid `state` → 400.

- [ ] **Step 2: Implement** using a signed JWT in `state` (HMAC with session secret).

- [ ] **Step 3: Commit** `feat(dashboard): GitHub App install callback`.

### Task 10.2: Integrations page

- [ ] **Step 1: Failing test** — page renders `provider_installations` for the org with status chips, an "Install GitHub App" CTA when none, and a failed-queue panel showing last 10 poisoned / parked rows.

- [ ] **Step 2: Implement** as a server component reading via `packages/db` helpers.

- [ ] **Step 3: Commit** `feat(dashboard): integrations page`.

---

## Phase 11 — Dashboard: repo config page

**Files:**
- Create: `packages/dashboard/app/orgs/[slug]/repos/[repo]/config/page.tsx`
- Create: `packages/dashboard/app/orgs/[slug]/repos/[repo]/history/page.tsx`
- Create: `packages/dashboard/tests/repo-config.test.ts`

### Task 11.1: Config form

- [ ] **Step 1: Failing test** — form submits to the server PATCH endpoint via `fetch`; success shows toast; validation errors render per-field.

- [ ] **Step 2: Implement** as a client component. Agent picker pulls from `/api/agents` (existing endpoint — verify with `rg "agents" packages/dashboard/app/api`). Claim-type toggles, review-model dropdown, pause switch.

- [ ] **Step 3: Commit** `feat(dashboard): repo config form`.

### Task 11.2: History tab

- [ ] **Step 1: Failing test** — page renders `repo_config_history` patches in reverse-chronological order with actor + timestamp; JSON Patch ops displayed human-readably ("set `paused` to `true`").

- [ ] **Step 2: Implement** with a small JSON Patch → human-readable renderer.

- [ ] **Step 3: Commit** `feat(dashboard): repo config history tab`.

---

## Phase 12 — Importer CLI

**Files:**
- Create: `packages/fluent-flow/scripts/import-repo-config.js`
- Create: `packages/fluent-flow/tests/scripts/import-repo-config.test.js`

### Task 12.1: CLI

- [ ] **Step 1: Failing test** — given a fixture repo with a `.fluent-flow/config.yaml` (mocked via provider client), `importRepoConfig('org/repo')` reads the file via installation token, parses + validates via `RepoConfigSchema`, upserts `repo_configs`, prints a unified diff of before/after to stdout.

- [ ] **Step 2: Implement** as an executable Node ESM script with shebang. Use `yaml` package (`npm install yaml -w packages/fluent-flow`).

- [ ] **Step 3: Run, expect pass.**

- [ ] **Step 4: Commit** `feat(scripts): import-repo-config CLI`.

---

## Phase 13 — Cutover migration

**Goal:** Drop PAT columns, remove legacy code, make `repos.installation_id` NOT NULL, switch legacy webhook path to 410.

### Task 13.1: Run importer against dogfood repos

- [ ] **Step 1: Install App on the dogfood orgs** through the GitHub UI. Verify `installation_repositories` webhook populated `provider_installation_repos`.

- [ ] **Step 2: Run importer** for each dogfood repo: `node packages/fluent-flow/scripts/import-repo-config.js <org/repo>`. Verify `repo_configs` rows exist.

- [ ] **Step 3: Enable flag** in staging env: `FF_GITHUB_APP_ENABLED=true`. Smoke test: open a PR, confirm check run appears, config snapshot correct.

### Task 13.2: Cutover SQL

- [ ] **Step 1: Migration** `NNN+8_cutover.sql`:
  - `ALTER TABLE repos ALTER COLUMN installation_id SET NOT NULL`
  - `ALTER TABLE repos DROP COLUMN webhook_secret` (if exists — verify)
  - `ALTER TABLE agents DROP COLUMN pat` (if exists — verify name)
  - Any other PAT-bearing columns identified in pre-flight.

- [ ] **Step 2: Run migration.**

### Task 13.3: Delete legacy code

- [ ] **Step 1: Delete** the PAT auth branch in `providers/github/rest.js` + `graphql.js`. Delete the `.fluent-flow/config.yaml` engine loader (find via `rg "config.yaml" packages/fluent-flow/src`). Delete the per-repo webhook-secret path. Delete PAT client.

- [ ] **Step 2: Legacy webhook route** returns 410 Gone (remove 503 branch).

- [ ] **Step 3: Run full test suite.** Fix fallout. Expect ≥410 tests green.

- [ ] **Step 4: Remove `FF_GITHUB_APP_ENABLED` flag** from env loader and all guards (code now assumes App is on).

- [ ] **Step 5: Commit** `refactor: remove PAT auth + legacy config loader (cutover)`.

---

## Phase 14 — Docs + final verification

### Task 14.1: Docs

- [ ] **Step 1: Update** `packages/fluent-flow/README.md` — replace onboarding section with "Install the GitHub App from the dashboard." Remove PAT steps.

- [ ] **Step 2: Update** `packages/fluent-flow/config/README.md` — retitle as "Config (legacy YAML importer)", point to the dashboard as source of truth.

- [ ] **Step 3: Update** `packages/dashboard/README.md` — document the integrations + repo config pages.

- [ ] **Step 4: Update root `README.md` and `CLAUDE.md`** — reflect DB-as-source-of-truth for config.

- [ ] **Step 5: Commit** `docs: update onboarding + config docs for App cutover`.

### Task 14.2: End-to-end verification

Walk through every bullet in the spec's **Verification** section against staging:

- [ ] Fresh multi-org GitHub account → chooser → org created.
- [ ] Personal account → personal org.
- [ ] Existing org member joins as member/admin.
- [ ] Install flow + callback + repo visibility.
- [ ] Config edit → audit entry → PR → check-run lifecycle with config snapshot.
- [ ] Suspend App → claims cancelled, queue parked. Unsuspend → un-parked.
- [ ] Repo transfer between installed orgs → re-linked.
- [ ] Worker kill + restart → no dupes.
- [ ] Secondary rate-limit storm → `rate_limited_attempts` climbs, no poison.
- [ ] Legacy `/webhooks/*` → 410.
- [ ] `npm test` from root ≥410 passing.

### Task 14.3: Final breaking-change verification

- [ ] **Flip** `createCheckRun` to return a bad conclusion → check-run test fails → revert → passes.

### Task 14.4: PR

- [ ] **Open PR against `main`** with the commit log as the PR body outline. Link the spec. No Claude co-authored lines per project conventions.

---

## Self-Review

Re-read after writing:

- **Spec coverage:** every spec section maps to a phase above — Architecture → P3, Schema package → P1, Data model → P2, Webhook flow → P5, Installation lifecycle → P5, Check runs → P7, Outbound queue → P6, Self-service signup → P9, In-dashboard config → P8+P11, Dashboard UI → P10+P11, Migration plan → P4/P5/P13, Testing → every phase.

- **Placeholder scan:** no TBDs; every implementation step names specific files. A few steps say "find with `rg ...`" instead of giving an exact path — this is deliberate because those paths depend on pre-flight reading that happens before Phase 3, and guessing would be worse than instructing lookup.

- **Type consistency:** `installation_id` used uniformly; `external_installation_id` reserved for GitHub's numeric id on install events; `repo_external_id` identity key; `check_run_external_id` stored on claims.
