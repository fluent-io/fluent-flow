# Chat claims implementation — gated plan

Binding input: `docs/specs/2026-11-13-chat-claim-attended-execution.md` (Draft v3, including uncommitted approved initiation/UX edits). Do not edit that input. No connector deletion or UI implementation in task 1. No migration execution outside disposable loopback ff_* databases.

## 1. Backend schema, creation, routing and lifecycle boundary

- Trace actual claim allocator, task execution service/routes, command persistence, runner result, expiry, and poll eligibility before editing.
- Add forward migration: nullable repo only for task-identified chats; enforced task/org identity; one active chat/task; task-local attempt uniqueness; target-agent/project default routing; pending TTL, independent activity time, end reason, chat slot admission and end_session command.
- Existing-task Open session: run.start + internal.read, expected version, atomic link/idempotency, no task lane change. New session: task.create + those capabilities, atomic minimal Backlog task/claim/link and retry identity.
- Poll: target org/agent eligibility, repo-null allowlist exception only for chats, opt-in runner chat support, reserve work capacity. Never deliver a chat to a pre-chat runtime.
- Lifecycle: activity writes but not heartbeat; pending TTL/idle/host-lost cancellation; no retry after failure/expiry/shutdown; turn cancel != session end; explicit idempotent end boundary. Keep work behavior unchanged.
- Gate: failing tests first, real disposable Postgres creation/concurrency/identity/rollback/eligibility/TTL tests, mounted API tests, regression suites, db build + agent-server typecheck. Document any incomplete sub-boundary rather than call task complete.

## 2. Interactive runtime, lease and resource safety

- Separate chat loop/openSession without initial prompt; sticky across turns; idle command service at existing 1s cadence; monitor child exit; turn cancellation and explicit end.
- Enforce max duration and GitHub token TTL cap; no GitHub token for repo-null. Ask/confirm permission policy and delivery-time originator capability checks.
- Per-task branch/worktree resumption; separate scratch root for repo-null. Reap child/free slot independently of filesystem teardown. Retain dirty/unpushed work, task GC evidence, safe startup cleanup, explicit discard.
- Backpressure before 16MiB event budget preserving terminal/security data, transcript truncation marker; profile/model catalog in session metadata and validated project defaults.
- Gate: runner lifecycle, timeout, command uncertainty, shutdown, process supervision, safe cleanup, no credentials in repo-null tests; real local ACP smoke; capacity/resize races.

## 3. Board-preserving task drawer and settings

- Flowly hierarchy: task context, inline progress/needs-input, compact sessions, expandable workpad/artifacts/ideas/history, discussion. No four-tab replacement. Drawer/deep links/back/mobile preserve board state.
- Ready Start remains unattended; Open/New session explicit; composer versus human comments separated. Stop response and End session distinct, closing drawer never ends.
- Authorized read projections and commands; pending countdown, attention/unread, queued vs accepted; agent slot split/default agent/profile settings, attended execution flag.
- Gate: browser acceptance incl keyboard/mobile/auth leakage; measure action-to-first-visible-token p95 <=5s, optimize dashboard read side if necessary.

## 4. Explicit chat -> unattended handoff

- User-gated Build this, task.create only for destination creation. No intent inference/model-triggered pipeline.
- Final live-context structured digest, task/spec payload, task branch artifact transfer with commit safety, handed_off_from/root lineage. Chat remains open; fresh ordinary unattended session may use another host. Repo-null handoff unavailable.
- Gate: atomic authorization/idempotency, branch/digest transfer, work retries unchanged; failed build never auto opens chat.

## 5. Data re-key and feature parity

- Inventory every collab_runs/sessions dependent and reader; claim/root re-key evidence, artifacts, plans/questions/workpad, summaries, usage, scoped reporting tokens and MCP tools.
- Migrate execution defaults to agent/profile; export/archive old transcripts; explicitly decide summary parity rather than drop it silently. Preserve surviving Flowly attribution.
- Gate: verified counts/checksums and reader parity, rollback/backup/recovery rehearsal, historical transcript access, scoped token authorization; no destructive changes before parity signed off.

## 6. Connector freeze, drain, then removal

- Server-side freeze new legacy runs/prompts/host/mapping writes while active executions drain. Reconcile zero-active condition; revoke connector credentials only at drain.
- Delete connector binary/config/code, host/mapping/settings/API/MCP surfaces and connector-only tests only after task 5 and history archive gate; separately approved destructive schema migration/export policy.
- Gate: zero active connector runs, no orphaned dependents, historic access, no Paseo references in db/server/dashboard except required surviving notices.

## 7. Full verification / release gate

- All package suites against isolated databases, builds and typechecks; environment-free dashboard build; security review of steering as host-code execution, tenant isolation, redaction, originator revocation and credential TTL.
- End-to-end repo/repo-null sessions, pending no-capacity, healthy-host idle, lost host/shutdown/failure no retries, concurrent uniqueness/end races, handoff and unattended regression, cleanup retention and transcript overflow.
- Report actual logs/results and remaining risks in adjacent ledger/report. No commit/push/merge/deploy in this task.
