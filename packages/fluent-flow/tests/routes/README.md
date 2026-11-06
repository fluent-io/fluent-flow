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

Set `COLLAB_ROUTES_TEST_DATABASE_URL` to a disposable database before running `npm test` in this package. Test setup rejects non-loopback or non-`ff_*` databases and resets its own test schema. Run the Settings suite alone with `npx vitest run tests/routes/collab-settings-security.test.js --fileParallelism=false`.

For the actual Settings browser check, set `FF_SETTINGS_BROWSER_FIXTURE_PATH` to a file under `/tmp` when running that suite. It writes synthetic fixture credentials with mode0600. Start a dedicated API and dashboard using that fixture's database/assertion secret, then follow the [dashboard browser instructions](../../../dashboard/tests/collab/README.md). Do not point these checks at a shared application database or a connected execution consumer.

That internal fixture also hashes a synthetic password for its existing legacy org admin, allowing actual host Settings tests to use normal password sign-in and current org-admin authority. No public credential or identity-linking route is added. Host browser tests compare one-time tokens only in memory, dismiss the prompt, verify token-free lists/storage and revoke their created hosts.
