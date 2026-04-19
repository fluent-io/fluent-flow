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

## In flight

*Nothing currently open.* See the PR list on GitHub for truth.

## Known gaps / next candidates

Each entry: the gap, the impact, and the rough shape of the fix.

### Runner distribution

- **`@fluent-flow/runner` not published to npm.** Runner package name is still `fluent-flow-runner` (unscoped). Victor owns the `fluent-flow` npm scope. End users running `npx @fluent-flow/runner@latest` (the dashboard's generated command) will hit 404 until publish lands.
  - **Fix shape:** rename runner package to `@fluent-flow/runner`, add `publishConfig.access: public`, set up a release workflow (`release: { types: [published] }` + `NPM_TOKEN` secret), cut v0.1.0.

### GitHub App install flow

- **"All Repositories" at scale.** `installation.created` payload truncates at ~100 repos. Orgs with more repos only get partial `repos` rows; the rest materialize lazily via later events that mention them. No initial API backfill.
  - **Fix shape:** on `installation.created`, enqueue a background task that calls `GET /app/installations/{id}/repositories` (paginated), iterates, upserts via `ensureRepo`. Uses App JWT + installation token from existing `app-auth.js`.

- **Regenerate key from dashboard (session-authed).** Currently `/api/agents/[id]/key` POST is MCP admin only; there's no way for an org admin to re-issue a token if they close the New Agent modal without copying.
  - **Fix shape:** session-auth branch on the existing `/api/agents/[id]/key` handler. Gated on `hasRole(session, agent.org_id, 'admin')`.

### Schema cleanup

- **`repos.installation_id` has no FK constraint.** Column exists and now has correct type (BIGINT), but no `REFERENCES provider_installations(id)`. Historical — old homegrown migration landed without it.
  - **Fix shape:** add a migration declaring the FK. Need to confirm nothing in the existing data violates the constraint first.

- **`agent_type` is a bad name.** Stored on `agents` and used as a routing hint (`claude-code`/`aider`/etc.). Users confuse it with `claim_type` (which is the role — `spec`/`build`/`fix`/`test`). Rename to `harness` to disambiguate.
  - **Fix shape:** migration renames `agents.agent_type` → `agents.harness`; update Drizzle schema, Zod schemas, UI strings, docs.

### Quality of life

- **Backfill tool for existing installs.** Teams that installed before PR #82 have empty `repos` tables. Today the recovery path is toggling App repo access to force an `installation_repositories.added` redelivery. A one-off admin script that reads `provider_installation_repos` and synthesizes `repos` rows would be less surgical.

- **Local dev ergonomics.** `npm install -g fluent-flow-runner` won't work until publish. Document the workspace-linked `npx fluent-flow-runner` path in the runner README more prominently.

## Longer-horizon work

Held in `docs/plans/` and `packages/fluent-flow/docs/plans/`:

- Server-side reviewer (replace runner-based review with direct Claude API calls in the server) — `packages/fluent-flow/docs/plans/saas-github-app.md`
- VSCode extension — `packages/fluent-flow/docs/plans/vscode-extension.md`
- Agent work queue redesign — `packages/fluent-flow/docs/plans/2026-03-28-agent-work-queue-plan.md`
- Admin dashboard phase 2 (claim history, audit log viewer, notification preferences) — scoped in existing dashboard plan

## Process notes

- Every non-trivial PR must have a "How did you verify this end-to-end?" answer filled in the template (ships in PR #75).
- Deploy workflow does post-deploy smoke checks that fail the deploy if the webhook endpoint 404s or the dashboard login page is missing its expected CTA. Add to the smoke checks when touching user-visible surfaces.
- Claude Code is not listed in commit co-authors (project convention).
