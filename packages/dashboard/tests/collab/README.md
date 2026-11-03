# Collaboration collab

[Parent documentation](<../../README.md>)

- [api.test.ts](<api.test.ts>) — Behavior regressions for api.
- [auth.test.ts](<auth.test.ts>) — Behavior regressions for auth.
- [board.test.ts](<board.test.ts>) — Behavior regressions for board.
- [live.test.ts](<live.test.ts>) — Behavior regressions for live.
- [proxy.test.ts](<proxy.test.ts>) — Behavior regressions for proxy.
- [questions.test.ts](<questions.test.ts>) — Behavior regressions for questions.

- [view-parity.test.tsx](view-parity.test.tsx) — runs the real NextAuth callbacks for password and GitHub sign-in of the same linked principal (owner, member, superadmin) over in-memory rows, checks equal sessions, org scope and server-rendered shell (TopBar, Sidebar, AuthGuard, legacy gate on internal pages); also covers unlinked collaborators, GitHub/principal mismatch, disabled or version-bumped principals and a missing linked user for both providers. Subprocess regressions check that the browser script refuses unsafe database names, target-override query parameters, socket URLs and fragments before connecting.
- [view-parity.browser.mjs](view-parity.browser.mjs) — actual password sign-in against a dedicated dashboard, an in-process mounted `createApp()` API and PostgreSQL, no HTTP mocks. Resets and seeds only `FF_VIEW_PARITY_DATABASE_URL` (loopback, name must match `ff_*_test`, never demo/prod), creating a linked org owner with a client workspace, project and task, plus an external collaborator invited to the project. Checks the owner sees full navigation, opens Settings and sees real workspace/project/member data; the external user sees only Board and Needs attention, sees the project task and is redirected from Agents. Fails on page errors or any 4xx/5xx collaboration response. It does not perform GitHub OAuth.
- [legacy-gate.test.tsx](legacy-gate.test.tsx) — real server-render regression for provider ordering on legacy pages.
- [run-refresh.browser.mjs](run-refresh.browser.mjs) — real execution components under server/network failures, recovery and revoked access; checks retained drafts/output and unhandled errors.
- [attention-pagination.browser.mjs](attention-pagination.browser.mjs) — real attention view with a second-page question, duplicate rows, repeated cursor, bounded Load more and revoked access.
- [decision-history.browser.mjs](decision-history.browser.mjs) — real delivery panel with immutable acceptance/reopen/cancel history, saved review state, pagination, unavailable/empty states and access revocation. Captures actual acceptance POST note, separate from delivery draft; checks draft retention on failure and clearing on success/denial.
- [settings-actual.browser.mjs](settings-actual.browser.mjs) — actual password sessions, NextAuth, HMAC proxy, mounted API and PostgreSQL. Verifies project-only membership administration, workspace-only role creation, offline work/summary configuration, read-only delivery controls and private generic Start. This script has no HTTP mocks.
- [host-settings-actual.browser.mjs](host-settings-actual.browser.mjs) — actual eligible legacy-admin password session and host APIs. Checks that the one-time prompt matches the required creation token, list/DOM/storage stay token-free, and a nonnull lastHeartbeatAt renders as seen. Logs only boolean results, takes no screenshots, dismisses the prompt and revokes each synthetic host.

Run `npm test` for Vitest. The first three browser scripts use a dedicated local Next server and mocked HTTP responses; they are UI regressions, not end-to-end server or native execution acceptance. From this package, start `npm run dev -- --hostname 127.0.0.1 --port 3100`, then run `node tests/collab/run-refresh.browser.mjs`, `node tests/collab/attention-pagination.browser.mjs` and `node tests/collab/decision-history.browser.mjs`. Set `FF_UI_TEST_ORIGIN` for a different dedicated server. The scripts use installed Chrome at `/opt/google/chrome/chrome` when available; `FF_UI_TEST_CHROMIUM_PATH` selects another installed browser.

The actual Settings script uses the private fixture emitted by the [mounted Settings suite](../../../fluent-flow/tests/routes/README.md). Boot dedicated API/dashboard processes with that fixture's database and matching assertion secret; configure the dashboard proxy to that API and use a private NextAuth secret. Run `FF_SETTINGS_BROWSER_FIXTURE_PATH=/tmp/your-private-fixture.json node tests/collab/settings-actual.browser.mjs`. It checks mode0600 and never prints credentials. It creates real disposable invitations, roles, configuration edits and one offline queued run; use a fresh fixture for each run, with no connected host consumer. It does not run a native agent or paid provider job.

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
