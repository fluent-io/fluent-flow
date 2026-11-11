# Collaboration collab

[Parent documentation](<../../README.md>)

- [api.test.ts](<api.test.ts>) — Behavior regressions for api.
- [auth.test.ts](<auth.test.ts>) — Behavior regressions for auth.
- [board.test.ts](<board.test.ts>) — Behavior regressions for board.
- [claim-execution.test.tsx](claim-execution.test.tsx) — RED-first ACP claim panel coverage for execution states, pagination, event reduction, safe terminal and rich-content rendering, idempotent drafts, cancellation, interactions, capability gates, revocation, loading failures and keyboard semantics.
- [claim-execution-actual.browser.mjs](claim-execution-actual.browser.mjs) — disposable PostgreSQL, actual password session, HMAC dashboard proxy, in-process service, spawned agent server CLI and deterministic ACP v2 child acceptance for claim creation, streaming, permission, follow-up, refresh, cancellation and persisted interaction rows. It has no HTTP product mocks.
- [live.test.ts](<live.test.ts>) — Behavior regressions for live.
- [proxy.test.ts](<proxy.test.ts>) — Behavior regressions for proxy.

- [view-parity.test.tsx](view-parity.test.tsx) — runs the real NextAuth callbacks for password and GitHub sign-in of the same linked principal (owner, member, superadmin) over in-memory rows, checks equal sessions, org scope and server-rendered shell (TopBar, Sidebar, AuthGuard, legacy gate on internal pages); also covers unlinked collaborators, GitHub/principal mismatch, disabled or version-bumped principals and a missing linked user for both providers. Subprocess regressions check that the browser script refuses unsafe database names, target-override query parameters, socket URLs and fragments before connecting.
- [view-parity.browser.mjs](view-parity.browser.mjs) — actual password sign-in against a dedicated dashboard, an in-process mounted `createApp()` API and PostgreSQL, no HTTP mocks. Resets and seeds only `FF_VIEW_PARITY_DATABASE_URL` (loopback, name must match `ff_*_test`, never demo/prod), creating a linked org owner with a client workspace, project and task, plus an external collaborator invited to the project. Checks the owner sees full navigation, opens Settings and sees real workspace/project/member data; the external user sees only Board and Needs attention, sees the project task and is redirected from Agents. Fails on page errors or any 4xx/5xx collaboration response. It does not perform GitHub OAuth.
- [current-project.test.tsx](current-project.test.tsx) — saved selection validation and per-principal keys, header routing, board scope precedence, task-creation default/refusal, Projects nav and selector in the server-rendered shell, and read/edit/settings controls on project pages.
- [projects-actual.browser.mjs](projects-actual.browser.mjs) — actual password sessions, NextAuth, HMAC proxy, mounted API and PostgreSQL (no HTTP mocks; one real response is delayed to test late results). Resets only `FF_PROJECTS_DATABASE_URL` (loopback `ff_*_test`). Covers the owner project list, creation, overview edit and reload, stale-version conflict with no mutation, header switching from project and task pages, late-response isolation, rename reaching header/list, workspace-only links, late create success and move failure after a switch, late Mark read after a switch, catalog 503 keeping a draft versus catalog 403 clearing it (including a late save), A-to-B-to-A abandoned move failure and create success, Back/Forward between project and workspace board links, initial catalog failure with retry on attention, named narrow sidebar links, mounted detail+draft revocation, remembered board scope, deep-link precedence, create-dialog default and draft discard, attention filtering, invalid saved selection, narrow layout, account switch, collaborator read-only and foreign-project 404, and revocation. It never starts runs.
- [settings-drafts.browser.mjs](settings-drafts.browser.mjs) — actual password session, NextAuth, HMAC proxy, mounted API and PostgreSQL using the private Settings fixture. Keeps an unsaved execution-defaults draft through shared catalog polls and a competing write, expects a 409 on save with the old base version, then an explicit Reload defaults and a successful fresh save. Edits only execution defaults; never starts a run.
- [internal-nav-gate.test.tsx](internal-nav-gate.test.tsx) — real server-render regression for provider ordering on internal nav pages (Agents, Repos, Pipelines).
- [attention-pagination.browser.mjs](attention-pagination.browser.mjs) — real attention view with a second-page question, duplicate rows, repeated cursor, bounded Load more and revoked access.
- [decision-history.browser.mjs](decision-history.browser.mjs) — real delivery panel with immutable acceptance/reopen/cancel history, saved review state, pagination, unavailable/empty states and access revocation. Captures actual acceptance POST note, separate from delivery draft; checks draft retention on failure and clearing on success/denial.
- [settings-actual.browser.mjs](settings-actual.browser.mjs) — actual password sessions, NextAuth, HMAC proxy, mounted API and PostgreSQL. Verifies project-only membership administration, workspace-only role creation, offline work/summary configuration and read-only delivery controls. This script has no HTTP mocks.
- [host-settings-actual.browser.mjs](host-settings-actual.browser.mjs) — actual eligible legacy-admin password session and host APIs. Checks that the one-time prompt matches the required creation token, list/DOM/storage stay token-free, and a nonnull lastHeartbeatAt renders as seen. Logs only boolean results, takes no screenshots, dismisses the prompt and revokes each synthetic host.

Run `npm test` for Vitest. The attention and decision-history browser scripts use a dedicated local Next server and mocked HTTP responses; they are UI regressions, not end-to-end server or native execution acceptance. From this package, start `npm run dev -- --hostname 127.0.0.1 --port 3100`, then run `node tests/collab/attention-pagination.browser.mjs` and `node tests/collab/decision-history.browser.mjs`. Set `FF_UI_TEST_ORIGIN` for a different dedicated server. The scripts use installed Chrome at `/opt/google/chrome/chrome` when available; `FF_UI_TEST_CHROMIUM_PATH` selects another installed browser.

The actual Settings script uses the private fixture emitted by the [mounted Settings suite](../../../fluent-flow/tests/routes/README.md). Boot dedicated API/dashboard processes with that fixture's database and matching assertion secret; configure the dashboard proxy to that API and use a private NextAuth secret. Run `FF_SETTINGS_BROWSER_FIXTURE_PATH=/tmp/your-private-fixture.json node tests/collab/settings-actual.browser.mjs`. It checks mode0600 and never prints credentials. It creates real disposable invitations, roles and configuration edits; use a fresh fixture for each run. It does not run a native agent or paid provider job.

The host script uses the same fixture and dedicated servers: run `node tests/collab/host-settings-actual.browser.mjs`. Fixture setup hashes a synthetic password for its existing legacy org admin through the shared password service; sign-in still uses normal NextAuth authentication and current database authority. There is no public password/linking endpoint or authentication bypass. The enrollment token stays in volatile test variables and is never written to the fixture, browser storage, screenshots or logs.

For the view-parity script, put two random secrets in owner-only files, start a dedicated dashboard pointed at the script's API port and the same disposable database, then run the script with the matching collaboration secret:

`FF_VIEW_PARITY_DATABASE_URL` must use `postgres://` or `postgresql://`, a loopback host and a database name matching `ff_*_test` without `demo`, `prod` or `production` segments. Query strings and fragments are rejected, including empty `?` or `#` delimiters. Test mode or `FF_COLLAB_TEST_DB_OPTIN=1` is also required. The script checks the URL before importing the database helper or opening a connection.

```bash
DB=postgres://user@127.0.0.1:5432/ff_view_parity_test
DATABASE_URL=$DB NEXTAUTH_URL=http://127.0.0.1:3190 NEXTAUTH_SECRET=$(cat /tmp/nextauth-secret) \
  FF_COLLAB_AUTH_SECRET=$(cat /tmp/collab-secret) FF_COLLAB_API_URL=http://127.0.0.1:3191 \
  GITHUB_CLIENT_ID=unused GITHUB_CLIENT_SECRET=unused npx next dev --hostname 127.0.0.1 --port 3190 &
FF_COLLAB_AUTH_SECRET=$(cat /tmp/collab-secret) FF_COLLAB_TEST_DB_OPTIN=1 FF_VIEW_PARITY_DATABASE_URL=$DB \
  FF_UI_TEST_ORIGIN=http://127.0.0.1:3190 FF_VIEW_PARITY_API_PORT=3191 node tests/collab/view-parity.browser.mjs
```

Set `FF_VIEW_PARITY_SCREENSHOT_DIR` to save screenshots. The script prints booleans and lists only, never credentials.

The linked owner's password is provisioned directly by this disposable fixture; the external collaborator chooses a different generated password through invitation acceptance. These checks do not add product password enrollment or account linking for GitHub users. Linked-account password sign-in requires trusted provisioning outside the product flow. Provisioned linked accounts must use distinct login emails: the existing password lookup is ambiguous if multiple credentialed principals share an email, and this parity fix does not change identity lookup or uniqueness rules.

For the Projects script, start a dedicated dashboard (`next dev` or `next build` + `next start`) on its own port with `DATABASE_URL` set to the same disposable database, a private NextAuth secret, and `FF_COLLAB_API_URL` pointing at the script's API port, then run:

```bash
FF_COLLAB_AUTH_SECRET=$(cat /tmp/collab-secret) FF_COLLAB_TEST_DB_OPTIN=1 \
  FF_PROJECTS_DATABASE_URL=postgres://user@127.0.0.1:5432/ff_projects_browser_test \
  FF_UI_TEST_ORIGIN=http://127.0.0.1:3192 FF_PROJECTS_API_PORT=3193 node tests/collab/projects-actual.browser.mjs
```

Set `FF_PROJECTS_SCREENSHOT_DIR` to save screenshots. Use a separate copy of the dashboard source when another dashboard is running from this checkout, so the two do not share `.next` output or `.env.local`.

For the Settings drafts script, write a fresh fixture with the [mounted Settings suite](../../../fluent-flow/tests/routes/README.md) (`FF_SETTINGS_BROWSER_FIXTURE_PATH=/tmp/…json`, mode 0600), start a dedicated dashboard with that fixture's database, NextAuth secret and assertion secret, with `FF_COLLAB_API_URL` pointing at the script's API port, then run `FF_SETTINGS_BROWSER_FIXTURE_PATH=/tmp/…json FF_UI_TEST_ORIGIN=http://127.0.0.1:3192 FF_SETTINGS_DRAFTS_API_PORT=3193 node tests/collab/settings-drafts.browser.mjs`. The script mounts its own API and refuses non-loopback or non-`ff_*_test` databases.

## ACP claim execution actual-browser acceptance

Prerequisites are installed workspace dependencies, an installed Chromium browser, two free loopback ports, and a disposable local PostgreSQL database created specifically for this run. Run the dashboard and script from `packages/dashboard` in two shells. The dashboard and script must use the same database and collaboration assertion secret.

First shell:

```bash
umask 077
openssl rand -hex 32 > /tmp/ff-claim-nextauth-secret
openssl rand -hex 32 > /tmp/ff-claim-collab-secret
DB=postgres://user@127.0.0.1:5432/ff_claim_execution_browser_test
DATABASE_URL=$DB NEXTAUTH_URL=http://127.0.0.1:3194 \
  NEXTAUTH_SECRET=$(cat /tmp/ff-claim-nextauth-secret) \
  FF_COLLAB_AUTH_SECRET=$(cat /tmp/ff-claim-collab-secret) \
  FF_COLLAB_API_URL=http://127.0.0.1:3195 \
  GITHUB_CLIENT_ID=unused GITHUB_CLIENT_SECRET=unused \
  npx next dev --hostname 127.0.0.1 --port 3194
```

Second shell:

```bash
DB=postgres://user@127.0.0.1:5432/ff_claim_execution_browser_test
FF_COLLAB_TEST_DB_OPTIN=1 \
  FF_CLAIM_EXECUTION_DATABASE_URL=$DB \
  FF_COLLAB_AUTH_SECRET=$(cat /tmp/ff-claim-collab-secret) \
  FF_UI_TEST_ORIGIN=http://127.0.0.1:3194 \
  FF_CLAIM_EXECUTION_API_PORT=3195 \
  FF_CLAIM_EXECUTION_SCREENSHOT_DIR=/tmp/ff-claim-execution-shots \
  node tests/collab/claim-execution-actual.browser.mjs
```

`FF_CLAIM_EXECUTION_DATABASE_URL` is rejected unless it uses `postgres://` or `postgresql://`, has a loopback host, has no query string or fragment, and names an exact `ff_*_test` database without `demo`, `prod` or `production` segments. `FF_COLLAB_TEST_DB_OPTIN=1` is mandatory. The script drops and recreates only the target database's `public` and `drizzle` schemas, runs migrations, seeds volatile credentials, and removes its disposable agent server directories. Context, browser, agent servers, in-process API, database pool and temporary-directory cleanup are isolated so every cleanup is attempted; the original test failure wins over cleanup failures, each asynchronous shutdown is bounded, and agent server spawn errors are handled. Do not connect another process to this database.

The fixture registers a `test-acp` long-poll agent scoped to `fixture/claim-browser`, creates its one-hour durable token directly through the shared database service, and writes it to a mode-0600 token file. It queues the claim through the UI while no session exists, captures that state, then starts the real agent server CLI with `--provider claude-code --capacity 1`, a free loopback `--health-port`, private `--work-dir` and `--state-dir`, and `FLUENT_FLOW_TOKEN_FILE` pointing at the token file. `--acp-command` is the current Node executable, and `--acp-arg` entries point to `packages/fluent-flow-agent-server/tests/unit/fake-acp-agent.js` with `--scenario claim-browser-uat` and a `--trace` path. The scenario and trace travel as ACP arguments because the child environment is an allowlist. The harness needs a real `git` on `PATH` and puts a stub `gh` in front of it so the startup tool probe passes. After the follow-up command POST succeeds, the browser script creates an owner-only marker in the work directory; the fake ACP child waits boundedly for that marker before ending the initial turn, so the follow-up is queued before claim completion. A second launch uses the `accepted-loss-resume-running` scenario and proves one prompt, one resume, two child starts, and a completed claim. Generated passwords and tokens stay in memory except the token file, and are not printed or included in screenshots; temporary traces stay under the disposable agent server directories.

The acceptance screenshots are `00-queued.png`, `01-streaming-permission.png`, `02-permission-answered.png`, `03-elicitation.png`, `04-refreshed-history.png`, `05-cancelled.png`, the overflow-checked narrow viewport `06-narrow-cancelled.png`, and `07-recovered-completed.png`. When the screenshot directory is configured, the first failure also attempts `failure.png`. Failure output includes only the bounded, in-memory agent server stderr tail after generated credentials, tokens and bearer values are redacted; stderr is never written to a fixture file. The final database checks require one cancelled `spec` claim, one recovered and completed `build` claim, unique ordered events containing message, tool, plan and state updates, resolved permission and elicitation requests with responses, acknowledged permission/elicitation/prompt/cancel commands with results, and one matching `collab_claim_executions` link per claim.

The task Execution tab mounts the claim-backed ACP panel after the legacy Paseo execution UI removal in PR #128. A missing `Start execution` button is a fixture failure.
