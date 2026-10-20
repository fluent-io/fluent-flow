# Collaboration collab

[Parent documentation](<../../README.md>)

- [api.test.ts](<api.test.ts>) — Behavior regressions for api.
- [auth.test.ts](<auth.test.ts>) — Behavior regressions for auth.
- [board.test.ts](<board.test.ts>) — Behavior regressions for board.
- [live.test.ts](<live.test.ts>) — Behavior regressions for live.
- [proxy.test.ts](<proxy.test.ts>) — Behavior regressions for proxy.
- [questions.test.ts](<questions.test.ts>) — Behavior regressions for questions.

- [legacy-gate.test.tsx](legacy-gate.test.tsx) — real server-render regression for provider ordering on legacy pages.
- [run-refresh.browser.mjs](run-refresh.browser.mjs) — real execution components under server/network failures, recovery and revoked access; checks retained drafts/output and unhandled errors.
- [attention-pagination.browser.mjs](attention-pagination.browser.mjs) — real attention view with a second-page question, duplicate rows, repeated cursor, bounded Load more and revoked access.
- [decision-history.browser.mjs](decision-history.browser.mjs) — real delivery panel with immutable acceptance/reopen/cancel history, saved review state, pagination, unavailable/empty states and access revocation. Captures actual acceptance POST note, separate from delivery draft; checks draft retention on failure and clearing on success/denial.
- [settings-actual.browser.mjs](settings-actual.browser.mjs) — actual password sessions, NextAuth, HMAC proxy, mounted API and PostgreSQL. Verifies project-only membership administration, workspace-only role creation, offline work/summary configuration, read-only delivery controls and private generic Start. This script has no HTTP mocks.
- [host-settings-actual.browser.mjs](host-settings-actual.browser.mjs) — actual eligible legacy-admin password session and host APIs. Checks that the one-time prompt matches the required creation token, list/DOM/storage stay token-free, and a nonnull lastHeartbeatAt renders as seen. Logs only boolean results, takes no screenshots, dismisses the prompt and revokes each synthetic host.

Run `npm test` for Vitest. The first three browser scripts use a dedicated local Next server and mocked HTTP responses; they are UI regressions, not end-to-end server or native execution acceptance. From this package, start `npm run dev -- --hostname 127.0.0.1 --port 3100`, then run `node tests/collab/run-refresh.browser.mjs`, `node tests/collab/attention-pagination.browser.mjs` and `node tests/collab/decision-history.browser.mjs`. Set `FF_UI_TEST_ORIGIN` for a different dedicated server. The scripts use installed Chrome at `/opt/google/chrome/chrome` when available; `FF_UI_TEST_CHROMIUM_PATH` selects another installed browser.

The actual Settings script uses the private fixture emitted by the [mounted Settings suite](../../../fluent-flow/tests/routes/README.md). Boot dedicated API/dashboard processes with that fixture's database and matching assertion secret; configure the dashboard proxy to that API and use a private NextAuth secret. Run `FF_SETTINGS_BROWSER_FIXTURE_PATH=/tmp/your-private-fixture.json node tests/collab/settings-actual.browser.mjs`. It checks mode0600 and never prints credentials. It creates real disposable invitations, roles, configuration edits and one offline queued run; use a fresh fixture for each run, with no connected host consumer. It does not run a native agent or paid provider job.

The host script uses the same fixture and dedicated servers: run `node tests/collab/host-settings-actual.browser.mjs`. Fixture setup hashes a synthetic password for its existing legacy org admin through the shared password service; sign-in still uses normal NextAuth authentication and current database authority. There is no public password/linking endpoint or authentication bypass. The enrollment token stays in volatile test variables and is never written to the fixture, browser storage, screenshots or logs.
