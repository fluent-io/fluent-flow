# HTTP route regressions

[Server package](../../README.md) · [Collaboration API](../../src/collab/README.md)

The collaboration suites boot the actual `createApp` router and run migrations against a dedicated loopback `ff_*` database. They do not assemble a substitute router or create application tables in test setup.

- [collab-auth.test.js](collab-auth.test.js) — signed-actor authentication boundary and safe failures.
- [collab-principal.test.js](collab-principal.test.js) and [collab-backlog.test.js](collab-backlog.test.js) — identity, scoped project entry, backlog, discussion and revoked access.
- [collab-settings-security.test.js](collab-settings-security.test.js) — custom-role execution configuration, default redaction, project member privacy, project listing and project-scoped role delegation. Known offline mappings and separate summary model/disable settings remain supported.
- [collab-project-overviews.test.js](collab-project-overviews.test.js) — project overview read/edit: blank existing projects, safe DTO, project.admin edits, 403/404/400/409 cases, conflicts with execution-default writes and a lock-held concurrent edit race.
- [collab-project-overview-fixture.test.js](collab-project-overview-fixture.test.js) — runs the real `collab-fixture.mjs` twice: demo overviews are inserted once, edited rows and credentials survive a re-run. Needs `packages/db` built.
- [collab-runs-protocol.test.js](collab-runs-protocol.test.js) — explicit Start, host protocol, reporting scopes and lifecycle authority.
- [collab-claim-executions.test.js](collab-claim-executions.test.js) — task-linked claim start/history, safe event and request pagination, capability-checked idempotent commands, transactional request answers and cancellation, limits and tenant isolation.
- [collab-connector-poll.test.js](collab-connector-poll.test.js) — connector long-poll timing over the real app and Postgres: `waitMs: 0` is immediate, empty waits expire at the deadline, queued work returns at once, new work wakes a held poll, heartbeat/ack/claims proceed during a wait, disconnect stops rechecks (also when it happens while authentication is still pending), and stale lease/revoked token end a held poll.
- [collab-evidence.test.js](collab-evidence.test.js) — mounted workpad, artifact, summary and immutable human-review acceptance.
- [collab-evidence-domain.test.js](collab-evidence-domain.test.js) — supplementary evidence-domain regressions; these are not mounted-app acceptance.

The agent server API (`/api/agent-server/*`, [agent-server.js](../../src/routes/agent-server.js)) has its own mocked-module suites, which need no database:

- [agent-server-enroll.test.js](agent-server-enroll.test.js) — single-use enrollment exchange: the `enroll_` credential is read from exactly one Bearer header, replays and all other failures give the same generic 401, unexpected errors give a generic 500 and are logged, and attempts are bounded per socket peer regardless of forwarded addresses.
- [agent-server-paths.test.js](agent-server-paths.test.js) — registration is mounted under `/api/agent-server` and the old runner path is gone.
- [agent-server-capability.test.js](agent-server-capability.test.js) — registration metadata and supported claim types, and the `meta` schema: wrong types, oversized fields, slot and capacity bounds and oversized unknown keys get `400 Invalid session metadata` without registering.
- [agent-server-poll-hint.test.js](agent-server-poll-hint.test.js) — long-poll hints only wake a poll; the database row is what gets delivered, payload keys cannot override the server-owned work fields or supply a token, undeliverable work is released and check runs start with the installation context.
- [agent-server-heartbeat.test.js](agent-server-heartbeat.test.js) — session and claim extension, `410` for an expired session and `claim: null` when the slot no longer owns the claim.
- [agent-server-claim-result.test.js](agent-server-claim-result.test.js) — results require `claim_id` and `session_id`, complete only the claim the session owns, and re-dispatch transient but not terminal failures.
- [agent-server-claim-interactions.test.js](agent-server-claim-interactions.test.js) — ownership proof for events, requests and commands, exact replays and generic conflict responses.
- [agent-server-verify-result.test.js](agent-server-verify-result.test.js) — verification evidence persistence, transition application and overwrite rejection.
- [agent-server-verdict-fallback.test.js](agent-server-verdict-fallback.test.js) — review verdict recovered from GitHub when stdout has no marker.
- [agent-server-auto-chain-head-sha.test.js](agent-server-auto-chain-head-sha.test.js) — head SHA and execution links carried through spec to build chaining.

Set `COLLAB_ROUTES_TEST_DATABASE_URL` to a disposable database before running `npm test` in this package. Test setup rejects non-loopback or non-`ff_*` databases and resets its own test schema. Run the Settings suite alone with `npx vitest run tests/routes/collab-settings-security.test.js --fileParallelism=false`.

For the actual Settings browser check, set `FF_SETTINGS_BROWSER_FIXTURE_PATH` to a file under `/tmp` when running that suite. It writes synthetic fixture credentials with mode0600. Start a dedicated API and dashboard using that fixture's database/assertion secret, then follow the [dashboard browser instructions](../../../dashboard/tests/collab/README.md). Do not point these checks at a shared application database or a connected execution consumer.

That internal fixture also hashes a synthetic password for its existing legacy org admin, allowing actual host Settings tests to use normal password sign-in and current org-admin authority. No public credential or identity-linking route is added. Host browser tests compare one-time tokens only in memory, dismiss the prompt, verify token-free lists/storage and revoke their created hosts.
