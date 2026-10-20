# HTTP route regressions

[Server package](../../README.md) · [Collaboration API](../../src/collab/README.md)

The collaboration suites boot the actual `createApp` router and run migrations against a dedicated loopback `ff_*` database. They do not assemble a substitute router or create application tables in test setup.

- [collab-auth.test.js](collab-auth.test.js) — signed-actor authentication boundary and safe failures.
- [collab-principal.test.js](collab-principal.test.js) and [collab-backlog.test.js](collab-backlog.test.js) — identity, scoped project entry, backlog, discussion and revoked access.
- [collab-settings-security.test.js](collab-settings-security.test.js) — custom-role execution configuration, default redaction, project member privacy, project listing and project-scoped role delegation. Known offline mappings and separate summary model/disable settings remain supported.
- [collab-runs-protocol.test.js](collab-runs-protocol.test.js) — explicit Start, host protocol, reporting scopes and lifecycle authority.
- [collab-evidence.test.js](collab-evidence.test.js) — mounted workpad, artifact, summary and immutable human-review acceptance.
- [collab-evidence-domain.test.js](collab-evidence-domain.test.js) — supplementary evidence-domain regressions; these are not mounted-app acceptance.

Set `COLLAB_ROUTES_TEST_DATABASE_URL` to a disposable database before running `npm test` in this package. Test setup rejects non-loopback or non-`ff_*` databases and resets its own test schema. Run the Settings suite alone with `npx vitest run tests/routes/collab-settings-security.test.js --fileParallelism=false`.

For the actual Settings browser check, set `FF_SETTINGS_BROWSER_FIXTURE_PATH` to a file under `/tmp` when running that suite. It writes synthetic fixture credentials with mode0600. Start a dedicated API and dashboard using that fixture's database/assertion secret, then follow the [dashboard browser instructions](../../../dashboard/tests/collab/README.md). Do not point these checks at a shared application database or a connected execution consumer.

That internal fixture also hashes a synthetic password for its existing legacy org admin, allowing actual host Settings tests to use normal password sign-in and current org-admin authority. No public credential or identity-linking route is added. Host browser tests compare one-time tokens only in memory, dismiss the prompt, verify token-free lists/storage and revoke their created hosts.
