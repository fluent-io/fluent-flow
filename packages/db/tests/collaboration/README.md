# Collaboration database regressions

[Database package](../../README.md) · [Services](../../src/collaboration/README.md) · [Fixture safety helpers](../helpers/README.md)

- `auth.test.ts`: dashboard assertion signing, expiry and malformed input.
- `identity.test.ts`: invitation/password, scoped roles, membership and host ownership.
- `passwords.test.ts`: real fixed-cost scrypt work for valid and failed login paths, malformed stored hashes, disabled identities and throttle ordering.
- `board.test.ts`: durable ordering, compaction and optimistic concurrent writes.
- `runs-connector.test.ts`: real leases, recovery, replay, read state, current
  authorization, session continuation and a racing Start reservation.
- `native-execution.test.ts`: migration `0022` shape (only two new side tables,
  existing columns/indexes/constraints unchanged), catalog-exact v2 Start,
  readiness error mapping, frozen summary profile (Task 8: the native cursor
  domain, no embedded history, refusal without a cursor, one row per repeated
  native summary report, separate rows across sessions and visibility, legacy
  sessions unchanged), claim-time withdrawal and
  v1 downgrade, same-backend additional sessions, v2 registration fields and
  the legacy v1 fallback (registration now stores the canonical capacity shape).
- `capacity-admission.test.ts` (Task 10): slot-requiring native commands are claimed per backend up to the
  poll's `availableSlots` in `created_at, id` order and marked `slotGranted`; the rest stay `pending` with no lease and
  are not redelivered when a delivered launch's lease lapses; a backlog larger than one batch never hides a control,
  a steer into a running session or the other backend; without `availableSlots` only native slot-requiring commands
  wait (Paseo and v1 commands are claimed); a claim publishes `{ limit, available, observedAt }` for the reported
  backends; a cancelled unclaimed launch is never delivered (command and run `cancelled`, the cancel `applied` with
  `dispatched: false`); `getCollabRun().queue` is only the run's own `queuedAt` and reason (`capacity`,
  `host_offline`). Concern pass: lost-response claims are reported as `heldClaims` and redelivered with `slotHeld`
  at zero capacity (one per limited batch, the other still reported), an accepted lost-ACK redelivery carries no slot
  marker; payload-less controls of a native run carry `nativeBackend`; withdrawn, revised and unready profiles and a
  v1 re-registration fail or cancel waiting launches undelivered with no free slot while a valid one keeps waiting.
  Concern pass 2: a launch re-queued by operator redelivery gets an ordinary Cancel delivered to its native backend
  (not inline no-write), while a never-delivered one is still cancelled inline; a poll held at an injected claim
  boundary until a later answer's `serverTime` passed its `notAfter` claims no slot work, and a timely one does.
- `native-pending-requests.test.ts` (Task 9): every outstanding request oldest
  first, 50 per page with a cursor (resolved and previous-generation requests
  never listed), the singular wrapper as the most recent request in today's DTO,
  answers refused without storing anything for a stale fingerprint or generation,
  a second non-failed answer under any key, a host-only allow
  (`answer_on_host`; deny accepted), a choice not offered or with another
  behavior, and selections outside the offered options (fix 1: by option id; raw labels and mixed entries refused; options that scrub to the same label stay separately selectable and the stored payload holds ids only); Paseo keeps `answers`.
- `native-binding.test.ts` (Task 7): canonical v2 capacity (limit-only integers
  normalized, objects kept, malformed refused), native `session_bound` writing
  only `collab_session_execution` by frozen backend and forward generation
  (never `paseo_agent_id`), v2 Paseo binding through the existing path, native
  turn completion making the session idle without changing task status, and a
  fragmented native observation reassembled exactly and shown once in session
  history. Task 11: on a `reconciling` native run a collaborator's Cancel is
  403 with nothing stored, the owner's Cancel is queued (idempotent replay), a
  `state: cancelled` closure observation projects session and run `cancelled`
  with task status unchanged, a new Start for the task then succeeds, and a
  Cancel on a `reconciling` Paseo run is still 409 `run_not_active`.
  Task 11 C5: after a real native `session_bound` at the current generation, a trusted
  supervisor `worker_lost` spool projects an idle session `reconciling` and admits the
  owner's continuation prompt; foreign-backend, stale-generation, unshaped, failed and
  cancelled spools are retained only.

Run with `COLLAB_DB_TEST_DATABASE_URL` set to your own loopback `ff_*` database:
`npm test -w @fluent-flow/db -- --fileParallelism=false`.
These tests drop the isolated schema and apply forward migrations. They do not
silently skip when the dedicated database is unavailable.
- Fix rounds 1 and 2 (clock authority): a forward authority stamp (a labelled fixture row; the database clock is never
  changed) keeps an old poll fenced across a corrected-clock heartbeat, a same-instance catalog refresh and a
  replacement registration. The real heartbeat records the corrected contact time; after a logical three-minute
  disconnect (only the JS `Date` the reachability checks read is advanced) the host, mapping and run read offline, the
  run's own queue reason is `host_offline`, and a replacement instance registers. The authority never appears in those
  reads. Legacy connector liveness is unchanged.
