# Roadmap

Rolling view of what's shipped, what's in flight, and what's known-missing.

## Recently shipped (last 30 days)

| PR | Area | Summary |
|----|------|---------|
| #56 | server | GitHub App provider integration — webhook handlers, provider_installations, installation tokens |
| #72 | dashboard + server | Install CTA on AuthGuard, installer linked to org on `installation.created`, sender-aware webhook handler |
| #73 | ci | `DEPLOY_SHA` in compose override so `up -d --build` actually recreates app containers |
| #74 | server | Mount `githubAppWebhookRouter` at root — matches GitHub App's configured Webhook URL |
| #75 | ci + tests | Post-deploy smoke checks, PR template with "How did you verify end-to-end?" field, route-integration test for webhook mount |
| #76 | dashboard | Dashboard-driven agent registration (stepper modal Name → Run → Connect); `createAgent` + `createToken` moved into `@fluent-flow/db` |
| #78 | dashboard + ci | Auth-before-env-check in `POST /api/agents`; `NEXT_PUBLIC_FLUENT_FLOW_URL` wired in deploy override |
| #79 | dashboard | Dialog command overflow fix |
| #80 | server + dashboard + docs | Stop leaking env var names in user-facing error responses; Security section added to CLAUDE.md |
| #82 | server + db | `installation.*` webhooks materialize `repos` shell rows; migration 0002 widens `repos.installation_id` to BIGINT |
| #84 | server + db | Cascade repo-link tombstones on `installation.deleted`; `softDeleteAllReposForInstallation` + breadcrumb `repos.installation_id` preserved |
| #85 | server + db + ci | Read-time session status (`CASE status <> 'offline' AND expires_at > NOW()`) via shared SQL fragment; scheduled `expireSessions` worker on boot; migrate+agent-detail test repairs; CI runs every workspace via turbo fan-out |
| #86 | server + db + scripts | Wire `routeWebhookEvent` into App webhook (closed 6-day PR-review outage since the 2026-04-14 PAT cutover); install-scoped token for config fetch (joins to external installation id); populate `provider_installation_repos` on `installation.created`; one-shot `scripts/backfill-install-repos.js` |
| #87 | docs + db | Correct the `repos.installation_id` FK gap — the FK is enforced on prod but absent from the Drizzle declaration; ROADMAP + schema comment updated to match reality |
| #88 | server + runner + docs | Migrate initial PR review from per-repo `pr-review.yml` workflow_dispatch to the runner-claim path — `dispatchReview` now creates a `claim_type: 'review'` claim; runner `prompts.js` gains a `review` template; deletes `review.yml`, `pr-review.yml`, `review.js`, `run-review.mjs`, `post-review.mjs`, `system-prompt.txt` from this repo; `onboard_repo` MCP tool stops writing workflow files; repos now need zero per-repo setup beyond the App install |
| #89 | dashboard + db + server + docs | GitHub App onboarding action surface — `/repos` page, `GET /api/repos`, dashboard-initiated `POST /api/repos/{repoId}/claims`, `listRepos`/`createClaim`, Repos nav, BYOK README refresh, stale `packages/fluent-flow/DESIGN.md` deletion, and check-run handler GitHub App installation-auth fixes for commit→PR/check-run/annotation lookups |
| #90 | server | Next-15 route fix |
| #91 | server + runner | Standalone claims + auto-chain — nullable `pr_number`, `StartWorkflowDialog` redesign, `CLAIM_TYPE_MAP`, claim → claim chaining |
| #92 | server + db | Org ID from DB via `resolveOrgId` instead of relying on webhook payload alone |
| #93 | runner | Runner env pass-through + git SSH/HTTPS auth with x-access-token URL embedding |
| #95 | server | Spec-only workflow start validation |
| #96 | server + runner + dashboard + db | Claim dismiss/archive (migration 0006, cancelled status, bulk/stale dismiss endpoints, pipeline filter UI); runner x-access-token git auth fix; review agent E2E flow (gh CLI auth, claim_type/agentType passthrough, inline review comments via `gh api`); GitHub App token for bot-posted reviews; auto-chain review FAIL→review_fix; reference Dockerfile + Docker deployment docs |

## In flight

- None currently tracked in-repo. Next work should target the highest-risk known gaps below.

## Known gaps / next candidates

Each entry: the gap, the impact, and the rough shape of the fix.

### Runner distribution

- **`@fluent-flow/runner` not published to npm.** Runner package name is still `fluent-flow-runner` (unscoped). Victor owns the `fluent-flow` npm scope. End users running `npx @fluent-flow/runner@latest` (the dashboard's generated command) will hit 404 until publish lands.
  - **Fix shape:** rename runner package to `@fluent-flow/runner`, add `publishConfig.access: public`, set up a release workflow (`release: { types: [published] }` + `NPM_TOKEN` secret), cut v0.1.0.

### GitHub App install flow

- **"All Repositories" at scale.** `installation.created` payload truncates at ~100 repos. Orgs with more repos only get partial `repos`/PIR rows on install. A manual `scripts/backfill-install-repos.js --all-active` fixes it (PR #86) but there's no automatic sync.
  - **Fix shape:** fire the same backfill logic automatically from the `installation.created` handler when the payload size hits the cap, or run it periodically. Reuse `scripts/backfill-install-repos.js`'s core as an exported function.

- **Regenerate key from dashboard (session-authed).** Currently `/api/agents/[id]/key` POST is MCP admin only; there's no way for an org admin to re-issue a token if they close the New Agent modal without copying.
  - **Fix shape:** session-auth branch on the existing `/api/agents/[id]/key` handler. Gated on `hasRole(session, agent.org_id, 'admin')`.

### Schema cleanup

- **`repos.installation_id` FK exists on prod but isn't declared in the Drizzle schema.** `repos_installation_id_fkey` is enforced in the DB (verified 2026-04-21 via `pg_constraint` — the constraint blocked a delete ordering until `repos` went before `provider_installations`). But `packages/db/src/schema/repos.ts` declares the column without `.references()`, and its comment still claims "No FK constraint" — both wrong. A `drizzle-kit generate` would emit a drop-constraint migration against reality.
  - **Fix shape:** add `.references(() => providerInstallations.id)` to the repos schema and regenerate the snapshot so drizzle's mental model matches prod. No DB migration needed.

- **`agent_type` is a bad name.** Stored on `agents` and used as a routing hint (`claude-code`/`aider`/etc.). Users confuse it with `claim_type` (which is the role — `spec`/`build`/`fix`/`test`). Rename to `harness` to disambiguate.
  - **Fix shape:** migration renames `agents.agent_type` → `agents.harness`; update Drizzle schema, Zod schemas, UI strings, docs.

### GitHub App auth/token bugs

- **Some non-check-run webhook paths still fall back to PAT auth.** PR #89 fixed the check-run completion path by passing the webhook installation context through `getPRsForCommit`, `getCheckRunsForCommit`, and `getCheckRunAnnotations`. Production logs after deploy still showed a `pull_request.closed` review-dismissal path fetching reviews without installation context and returning 401. This does not block new check-run-triggered review claims, but it means cleanup/dismissal behavior is not fully App-auth-safe.
  - **Fix shape:** audit every GitHub REST helper call from webhook handlers and require/pass a token context. Prefer making helpers fail fast in App mode when neither explicit installation context nor a valid fallback token exists.

- ~~**`workers/outbound.js` passes the wrong installation id.**~~ See also #96 fixed the same bug pattern in `fetchRepoConfig` / runner token lookup. The outbound worker still has the same class of bug — reads internal FK and passes to `getInstallationToken` which expects GitHub's external installation id.
  - **Fix shape:** join to `provider_installations` in the outbound worker's token path (or in `getInstallationToken` itself — safer, kills the whole class of bug) and pass the external id.

### Review pipeline

- **Verdict parsing is fragile for non-Claude-Code agents.** The review→review_fix auto-chain depends on the agent echoing a `<!-- reviewer-result -->` marker to stdout. Works for Claude Code but if the agent posts reviews via `gh api` directly (the new prompt), the marker goes to GitHub, not stdout. The auto-chain won't fire unless the agent also prints the marker.
  - **Fix shape:** after the agent exits, fetch the latest review from GitHub API and parse the verdict from there.

- **DismissStaleButton visible to non-superadmins.** The button renders for all logged-in users but the API returns 403. Should gate on `isSuperadmin`.
  - **Fix shape:** pass `isSuperadmin` from session to client component, conditionally render.

### Deploy/runtime reliability

- **Deploy can build a new app image without recreating the running container.** On 2026-04-25, CI built `fluent-flow-fluent-flow:latest`, but the live `fluent-flow` container stayed on the old image until `docker compose up -d --force-recreate fluent-flow` was run manually. During the forced restart, runners saw transient Cloudflare 502s and retried.
  - **Fix shape:** add `--force-recreate` or an equivalent deploy-sha image/container label change to the deploy workflow, and add a post-deploy smoke check that verifies the running container was created after the image build / exposes the expected `DEPLOY_SHA`.

### Routing tighter-than-display

- **`touchSession` lacks `expires_at > NOW()` guard.** A runner whose session TTL lapsed can silently revive the dead row on its next heartbeat instead of being forced through `registerSession`. PR #85 only tightened the read path (display + routing queries). Correctness-leaning — noted as out-of-scope on PR #85.
  - **Fix shape:** add `expires_at > NOW()` to the `touchSession` WHERE clause; if the update hits zero rows, the runner re-registers.

### Quality of life

- **Local dev ergonomics.** `npm install -g fluent-flow-runner` won't work until publish. Document the workspace-linked `npx fluent-flow-runner` path in the runner README more prominently, and prefer `https://flow.fluenthive.io` in runner examples to avoid tunnel/redirect confusion.

- **Consolidate webhook routers.** `webhook.js` exists only to host `routeWebhookEvent` + legacy 410 stubs; `github-app-webhook.js` forwards to it. Merge into one module now that PAT-era paths are fully retired.

## Longer-horizon work

Held in `docs/plans/` and `packages/fluent-flow/docs/plans/`:

- Server-hosted reviewer fallback is no longer a near-term direction. Fluent Flow is BYOK / bring-your-own-subscription: model credentials live with the user's runner/harness, not on the server. Any stale docs proposing server-side model calls or per-repo `pr-review.yml` workflows should be deleted or rewritten before use.
- VSCode extension — `packages/fluent-flow/docs/plans/vscode-extension.md`
- Agent work queue redesign — `packages/fluent-flow/docs/plans/2026-03-28-agent-work-queue-plan.md`
- Admin dashboard phase 2 (claim history, audit log viewer, notification preferences) — scoped in existing dashboard plan

## Process notes

- Every non-trivial PR must have a "How did you verify this end-to-end?" answer filled in the template (ships in PR #75).
- Deploy workflow does post-deploy smoke checks that fail the deploy if the webhook endpoint 404s or the dashboard login page is missing its expected CTA. Add to the smoke checks when touching user-visible surfaces.
- Claude Code is not listed in commit co-authors (project convention).
