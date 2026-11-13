# Collaboration database regressions

[Database package](../../README.md) · [Services](../../src/collaboration/README.md) · [Fixture safety helpers](../helpers/README.md)

- `auth.test.ts`: dashboard assertion signing, expiry and malformed input.
- `default-workspace.test.ts`: default provisioning, concurrent replay, admin enrollment and tenant-scoped repo links.
- `identity.test.ts`: invitation/password, scoped roles, membership and host ownership.
- `passwords.test.ts`: real fixed-cost scrypt work for valid and failed login paths, malformed stored hashes, disabled identities and throttle ordering.
- `board.test.ts`: durable ordering, compaction and optimistic concurrent writes.
- `runs-connector.test.ts`: real leases, recovery, replay, read state, current
  authorization, session continuation and a racing Start reservation.
- `claim-executions.test.ts`: task-linked work/chat creation, idempotency, authority, command delivery and safe public badges.
- `claim-handoffs.test.ts`: reviewed handoff confirmation, concurrent replay, source lineage, explicit new tasks and owning-runner workspace receipts.
- `claim-progress.test.ts`: all live claims, per-reader monotonic cursors, request attention, public redaction and authorization revocation.

Run with `COLLAB_DB_TEST_DATABASE_URL` set to your own loopback `ff_*` database:
`npm test -w @fluent-flow/db -- --fileParallelism=false`.
These tests drop the isolated schema and apply forward migrations. They do not
silently skip when the dedicated database is unavailable.
