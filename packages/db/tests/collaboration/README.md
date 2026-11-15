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
- `claim-reporting.test.ts`: exact acquisition/session/token authority,
  initiator revocation, canonical attribution and native capture proofs.
- `claim-usage.test.ts`: distinct claim/acquisition usage, cumulative
  replacement, legacy isolation, snapshot precedence and revocation.
- `execution-archives.test.ts`: original identities and exact payload bytes,
  microsecond timeline paging, current authorization, nullable historical orgs,
  foreign cursors, corruption/source-change detection, atomic rollback and
  sealing serialized against record writes.
- `execution-archive-transfer.test.ts`: private actual-CLI dump/restore, original IDs/bytes, full-stream replay, scope validation and atomic corruption refusal.
- `execution-archive-artifacts.test.ts`: required byte inventory and verified historical artifact reads after fixture retirement/restore.
- `execution-retirement.test.ts`: isolated admission/freeze races, rollback, native claim creation after freeze, and owner observation/permission/cancel/artifact/reconciliation drains.
- `execution-retirement-operator.test.ts`: truthful server-record counts, private actual-CLI output, explicit global confirmation and missing-state refusal.

Run with `COLLAB_DB_TEST_DATABASE_URL` set to your own loopback `ff_*` database:
`npm test -w @fluent-flow/db -- --fileParallelism=false`.
These tests drop the isolated schema and apply forward migrations. They do not
silently skip when the dedicated database is unavailable.
