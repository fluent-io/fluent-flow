# Collaborative Kanban implementation plan

[Documentation](../README.md) | [Specification](2026-10-19-collaborative-spec.md) | [Shared contracts](2026-10-19-collaborative-contracts.md) | [Status and UAT](2026-10-19-collaborative-status.md)

Implement the full approved scope. This plan divides ownership for three coding agents, with one integration owner. It does not reduce the feature set to an initial scaffold. Read the contract once; do not invent separate B/C payloads or duplicate authorization logic. All new directories require a README linking parent and child READMEs. No production connections, Mac installation, public listeners, commit or PR publication is authorized by this plan.

## Current code and prerequisites

- Monorepo: Express ESM server, Next.js 15/NextAuth 4/React 19 dashboard, CLI runner, shared `@fluent-flow/db`. Build db before server/dashboard runtime imports: package main is `dist/index.js`.
- `auth.ts` only supports GitHub, resolves legacy users by github_id and carries org memberships. New collaborators need additive identity tables and B's login/session/AuthGuard changes. `users.github_id` is live/non-null: never ALTER it.
- Existing agents/pipelines/claims queries treat empty org arrays as unrestricted. The separately assigned prerequisite coder owns those queries and old API/page callers. B waits for that security cutover before enabling external login; test old direct endpoints as a real invited user.
- Existing `client.ts` exposes a Drizzle-backed pg pool; `pool.ts` also has a raw pg query wrapper. Despite the stale README and the `client.ts` preference comment, repository instructions require raw pg for new code. Reuse the existing exported pg pool with explicit client BEGIN/COMMIT/ROLLBACK for transactions; do not introduce a third pool or new ORM. Avoid importing a connection-string fallback into non-test bootstrap.
- Migrations use Drizzle's journal and baseline-aware migrator. A appends forward-only SQL/journal entries that create new collaboration tables/indexes only. Do not regenerate historical baseline/snapshots to match new guesses about production. Verify against a disposable database, with the exact new statements inspected before execution. Startup automatically migrates: never point normal boot at a shared/prod URL.
- Existing server startup requires GitHub App env, binds `0.0.0.0`, starts outbound/expiry workers, and migrates automatically. For isolated smoke use the real `createApp()` on `127.0.0.1` with explicit test DB and dedicated fixture initialization; keep unrelated outbound workers off. B runs `next dev --hostname 127.0.0.1 --port <free-port>`. These are smoke harnesses, not fake application handlers.
- Existing package scripts: root `npm test`/`npm run build` use Turbo; `npm test --workspace=fluent-flow`, `npm test --workspace=@fluent-flow/db`, `npm test --workspace=@fluent-flow/dashboard`; runner's package-local Vitest script remains authoritative. Parent's bootstrap worker owns dependency install, baseline results and DB service discovery. Do not duplicate installs or claim those checks passed before its evidence arrives.
- Real browser tests need isolated Postgres, db build, server and Next, fixture credentials, loopback browser reachability. Invitation/password flow deliberately needs no SMTP service; admin privately shares a scoped invitation link. GitHub OAuth smoke additionally requires a configured approved callback/application, otherwise report that path unexercised while preserving its regression suite.
- Real execution smoke needs existing local Paseo daemon, chosen configured profile/model, a disposable repository mapped on the PC, bounded authorized prompt and observed SDK capabilities. Parent reports MCP operations work, but shell `paseo --version/--help` hits an AppImage FUSE limitation in sandbox. C must resolve the existing supported CLI invocation for cancel (e.g. existing CLI entry point/runtime), without installation or daemon upgrade; record this prerequisite separately from SDK connection. Do not silently substitute archive for stop.
- No local default Flowly data discovered; see the specification's exact limits. Do not read `.env`, local credentials, provider env or whole daemon config into logs. C's runtime profile extraction must retain secrets locally.

## Shared delivery order

A first publishes the real Zod contracts, identity exports and first additive migration. B can build component behavior against those schemas and an isolated HTTP fixture while A implements services; C can test journal/Paseo adapter with fake *external* daemon I/O while A implements connector routes. Fixtures never replace final integration. The integration owner controls root package lock changes and shared entrypoint conflicts. All owners keep the acceptance ledger current with exact commands/results. Profile selection uses the configured profile's notes; favor suitable OMP AI3 coding profiles through the shared gateway. Respect the runtime's active-agent cap when dispatching these ownership slices.

Current implementation ownership: A4 is delegated to B alongside the dashboard so evidence services and their UI can progress while A builds the durable protocol. B owns the new evidence service modules, evidence HTTP route module, tests and migrations `0014_collab_evidence.sql` and `0015_collab_workpad.sql`; A retains migration journal registration, shared barrel exports/router composition and all A1/A2/A3/A5 work. A2 discussion/events can follow as migration 0016; do not reuse B's workpad slot. Criteria, workpad plans and open questions belong to B's A4 slice; comments, roles and event delivery remain A's A2 slice. B calls A's run/session command and stage services rather than editing them. Coordinate shared types, event insertion and connector observation sinks before editing shared files. C remains the runner/connector owner and owns its package-lock update. This changes coding ownership only, not product scope.

Each numbered slice below is a red/green/refactor loop: first write a meaningful public-behavior test, run it and record its expected assertion failure, implement, run green, then refactor. A missing-import failure alone does not prove the behavior. Use a disposable real Postgres fixture for transactional/concurrency/security behavior; mocks cannot prove isolation or SQL locking. Avoid broad whole-suite churn mid-edit; each owner runs focused red/green checks, and integration runs the full suites/build once source has settled. UI also needs an actual browser smoke; connector also needs actual Paseo execution.

## A: persistence, authorization, server APIs and MCP

Own `packages/db` additive collaboration schemas/queries/services/migrations/tests; new Express collaboration and connector routes; scoped MCP; new server integration tests; safe fixture/bootstrap/import commands and relevant server/db docs. Do not edit prerequisite-owned legacy queries/callers, dashboard auth/components or runner implementation. C owns local import reading, A owns import persistence/API.

A1. Identity and independent backlog.
- RED: redeem an invite once into client A/project A1; the principal can create a task with no repository/run; a second redemption and client B task read fail. Exercise service and route rather than mocked role booleans.
- Implement identity exports in the contract, hashed/single-use invitations, password verification/rate limiting, GitHub principal mapping, explicit admin workspace bootstrap, project-scoped roles and fixture CLI. Defaults are fixed capability lists; custom roles are small validated subsets, not a generic policy language.
- GREEN: DB constraint/query isolation plus POST/GET persistence after process restart. Revocation denies next request and event delivery. Ensure no old users table DDL.

A2. Collaboration, ordering and publication.
- RED: two simultaneous moves with the same board version cannot both overwrite order; task edit conflict preserves the first accepted write. Internal comment/artifact text must not appear in another client's/client-visible search or event output.
- Implement task/criteria/comment APIs, transactional board locks/ranks, current-work filters, per-user read state and cursor events/SSE with reauthorization. Add exact generic errors/codes and bounded pagination.
- GREEN: concurrent DB sessions, permission revocation during stream, client/internal projection tests. Publish shared types consumed by B.

A3. Durable queue and host protocol.
- RED: repeat Start with identical key yields one run/one launch command; changing body with same key conflicts; Ready creates none; host B cannot poll/ack host A's command; stale fence cannot mutate state.
- Implement host enrollment/revocation, allowlisted mappings/catalog, server-side start/control authorization, frozen execution defaults, command claims/acks/observations, active-run uniqueness and replay dedupe. Expired connector leases cause same-command reconciliation, never legacy claim redispatch.
- GREEN: restart server between launch claim and acknowledgment; immutable IDs and queue survive. Queued work rechecks actor/mapping authorization before delivery. Client-safe progress excludes internal payloads.

A4. Flowly data and human delivery (currently owned by B).
- RED: stale/dirty/failed/not-run evidence cannot silently produce clean delivery; accept must acknowledge current open-item IDs. Agent or merged PR cannot set Done. Replayed idea conversion does not create a second task/command. Human-owned artifact cannot be overwritten by agent.
- Implement checks/history, open questions/native plans, provenance, safe artifact publication/retrieval metadata, ideas, versioned summaries/settings, usage coverage/insights and delivery snapshots/decisions. Implement run-scoped agent reporting credential for workpad/artifacts/ideas/progress; derive task/session identity from the token, not agent arguments; exclude membership/start/accept powers.
- GREEN: multiple sessions/runs remain on one task; unknown usage remains null; cumulative samples do not double-count. Add APIs for explicit run-stage changes and prompt/permission state.

A5. MCP and old delivery integration.
- RED: scoped MCP token cannot query another project or accept delivery as an agent; linked PR/claim with mismatched project/repo is rejected; legacy webhook/review semantics still pass existing tests.
- Implement `collaboration_list_projects`, `collaboration_list_tasks`, `collaboration_get_task`, `collaboration_create_task`, `collaboration_update_task`, `collaboration_add_comment`, `collaboration_start_run`, `collaboration_get_run`, `collaboration_send_prompt`, `collaboration_report_check`, `collaboration_add_artifact`, `collaboration_propose_idea`. Same Zod schemas/services/capabilities as HTTP. Run-scoped tools cannot broaden scope.
- Link existing claim/PR evidence through new association rows, never mutate existing schema or reroute old claims into the new connector accidentally. Backlog acceptance cannot bypass merge controls. Legacy data import is conditional on discovering real data: if discovered, implement the admin-authorized dry-run/commit path preserving associations; otherwise record bounded inventory and do not build speculative migration endpoints.

## B: dashboard, authentication and user workflows

Own `packages/dashboard` new collaboration routes/pages/components/tests, `auth.ts`, login/AuthGuard/nav, same-origin proxy and dashboard README, plus the explicitly delegated A4 backend slice above. Wait for prerequisite-owned old caller edits before touching their callers. Consume A's identity/execution services and shared authorization; SQL/migration work is limited to A4's new evidence schema. Never invent browser-side authorization.

B1. Real invited-user entry and client selection.
- RED: an invited non-GitHub user signs in and reaches authorized project board without installation CTA; direct old agents/pipelines endpoints reveal no internal data. Invalid invite/password shows generic error and cannot choose a principal ID.
- Implement invite landing/redemption, Credentials provider with A's verifier, sessionVersion checks, GitHub mapping/bootstrap UI, workspace/project/membership screens and role controls. Restrict admin/runner navigation appropriately while preserving old internal-user paths.
- Browser smoke: different identities in separate contexts, expired/reused invitation, membership removal, refresh/deep links and logout.

B2. Persistent Kanban and discussion with PC offline.
- RED: browser creates/edits/discusses task without mapping; refresh retains it; dropping to Ready never sends a launch command; 409 preserves draft and offers refresh/retry.
- Implement all-projects/client/project filters, board/order controls (drag plus accessible keyboard/menu alternative), priority/assignee/blocked badges, detail description/criteria/comments and client/internal separation. Bind execution badges to server projections and show observed timestamps/offline status.
- Browser smoke: two clients, two same-project browser sessions performing conflicting moves, no lost accepted edits, safe not-found on cross-client URL.

B3. Integrated execution and attention.
- RED: operator sees configured Start confirmation and queued PC state; collaborator cannot start or inspect transcript even by direct call; pending approval requires correct current session/request.
- Implement host/mapping/profile settings, explicit Start, selectable run/session history, live output, follow-up/steer/interrupt/cancel/retry, question/permission controls and consolidated Needs attention/unread behavior. Do not fabricate percentages or treat turn idle as Done. Preserve pending/ambiguous command state.
- Real browser plus C smoke: one Paseo run appears, streaming question/answer/approval lifecycle renders, reconnect catches up, stale/offline remains truthful.

B4. Complete workpad and delivery UI.
- RED: acceptance warns about failed/not-run/stale/open evidence and requires current acknowledgment; summary-disabled cannot start summarizer; idea conversion to backlog incurs no execution.
- Implement named commands/check evidence/commit association, plan/open-item view, artifact previews/publication/ownership, ideas inbox/new-task/continue actions, summary settings/history, supported usage/project insights, Review submission, human accept/cancel/reopen and wrap-up preflight/result. Keep archived history inspectable.
- Browser smoke: input/output artifact safe preview, restricted publication, two sessions under same task, idea conversion, summary on/off, unknown usage, Review to Done and dirty-wrap-up block.

## C: PC connector, supported Paseo lifecycle and import discovery

Own `packages/fluent-flow-runner` connector entry/mode/client/Paseo adapter/journal/import-reader/tests/docs and package dependency addition. Keep current direct-harness runner functioning for old claims. Coordinate package-lock once through integration owner. Do not add inbound PC services or server-side provider credentials.

C1. Outbound host and durable launch journal.
- RED: invalid host/mapping/path/profile cannot launch; two connector instances cannot both execute one command; a crash after journal write cannot forget intended run/session identity.
- Implement revocable host auth/register/heartbeat/poll, local canonical repo/profile allowlist, atomic private journal and exact shared protocol. Read configured Paseo profiles by supported API and publish sanitized catalog. Record version/capability checks before offering actions.
- GREEN: HTTP fake covers outages/errors, actual SDK read-only connection verifies catalog and chosen mapping without spending tokens.

C2. Idempotent creation, execution and reconciliation.
- RED: drop workspace/agent create acknowledgment, restart connector, replay same command: one workspace/agent; drop prompt ack: one prompt or reconciliation hold, never a second paid run. Idle snapshot alone cannot complete a turn.
- Implement exact pinned SDK types, stable workspace/session keys, idle creation then durable binding, stable send message ID, timeline subscription readiness, epoch/sequence backfill/dedupe, lease fencing and state observation. Cancel uses supported local CLI stop then observations, not archive. Terminal turn events drive state; task completion stays human-controlled.
- Real smoke: isolated git repository/worktree, explicitly selected configured profile, bounded change and test; verify IDs visible in Paseo, persisted through connector/server restart and follow-up. No uncontrolled paid jobs.

C3. Session controls and retained execution features.
- RED: wrong/expired permission response rejected; duplicate usage sample ignored; unavailable capability reported explicitly; symlink escape/credential-file artifact read denied; agent cannot publish human input artifact changes.
- Implement multi-session creation, steer/interrupt/permission answers, summary sessions with configured/disabled model, exact checks and git HEAD/dirty state, safe artifact read/preview transfer, ideas/reporting tools, provider progress/plan/usage normalization. Raw provider config/errors never go to client-visible fields.
- Real smoke: question and supported permission approval, cancellation then retry, actual supported usage or honest unavailable state, summary enabled once then disabled, safe artifact and recorded command evidence.

C4. Wrap-up and real-data inventory.
- RED: dirty/untracked/unpushed/unknown/shared/imported workspace cannot be destroyed; stale preflight invalid; partial archival records partial result, not success. If actual legacy data is discovered, repeated import must preserve identical task/workspace/session associations without launching.
- Implement read-only preflight, owned-session archival, strictly clean owned-worktree archival, retained code/branch/history. Inventory named Flowly files only; if real data is present, preserve it with a read-only backup manifest and coordinate the actual import with A. If none is found, report exact searched roots and unknown custom/remote roots. Do not build speculative older-version migration machinery or claim a migration occurred. Full execution feature retention remains mandatory regardless of data discovery.
- Smoke: dirty file survives wrap-up attempt; clean owned disposable workspace cleanup does not touch user's existing workspace; real inventory recorded as found/not-found/unknown with exact searched roots.

## Integration owner and exit criteria

1. Land prerequisite empty-org fix; establish isolated DB/fixtures; reconcile A exports with B auth and C wire payloads. No compatibility shims or duplicate models.
2. Exercise A/B/C as one actual application. Record all nine UAT scenarios in the ledger, including cross-client REST/MCP/stream attempts, offline/reconnect, ambiguous acknowledgment, server restart and human delivery.
3. Run focused new regression suites, existing server/runner/db/dashboard suites and production build after integration. Record exact observed results; baseline failures remain distinct. No tests that merely inspect source strings or mock forwarding.
4. Update root README, ROADMAP, product-positioning doc, docs index and relevant package/directory READMEs to task-first collaboration with retained review controls. Distinguish shipped verification controls from targets. Add upstream notices for any adapted code and runtime/setup/UAT/error guidance. Do not publish a PR; independent cross-model final-diff reviews are required only if publication is later requested.
5. Completion requires full approved behavior plus exercised scenarios. An inaccessible credential/provider/UI prerequisite is reported precisely with attempted safe alternatives; it does not authorize calling incomplete integrated behavior done. Tests alone do not satisfy browser/Paseo smoke requirements.
