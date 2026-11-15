# Claim Data Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans or subagent-driven-development. Execute checked contracts; no source comments, temporary verification artifacts or unrequested production operations.

**Goal:** Preserve canonical collaboration evidence and historical execution access while native claims replace the connector execution source.

**Architecture:** Keep the existing collaboration services, tables, MCP endpoint and tool names. Add an explicit claim reporting source and a small runner-local stdio MCP adapter that captures file bytes before forwarding an atomic artifact registration. Historical UUIDs remain historical; append-only archive snapshots preserve original records and provide authorized readers before any legacy-table removal.

**Tech Stack:** Existing ESM JavaScript/checkJs and TypeScript, Zod, raw pg, MCP SDK 1.29.0, ACP SDK 2.4.0, Vitest, existing production-browser harness.

**Spec:** [Attended execution as chat claims](../specs/2026-11-13-chat-claim-attended-execution.md), especially re-key, history, summary and removal gates. This refines task 5 and the non-destructive preparation for task 6 in [the implementation plan](2026-11-13-chat-claims-implementation.md).

## Global constraints

- Stack on `9c32292` / PR 153 using branch `chat-claim-data-parity`. PR 153 is independently approved and all eight remote checks passed. Do not merge it or deploy production.
- Node >=20; chat storage remains Linux/procfs-only. Do not claim Windows secure artifact capture without an implementation and exercised proof.
- Preserve Ready Start as unattended; chat remains optional; summaries and handoff never imply human delivery acceptance.
- Legacy run/session UUIDs, integer claim/root IDs and integer runner-slot IDs are different identities. No synthetic historical claims, coerced IDs, reconstructed acceptance snapshots or invented principal session versions.
- All DDL is forward/additive and new fields/tables are unused before their writers deploy. No DROP, old-migration rewrites, cascade deletion, host revocation, freeze activation or shared-database mutation in local implementation.
- Use existing canonical reporting functions; internal visibility and agent provenance remain enforced. Captured file bytes do not turn model-reported checks into runner-observed verification.
- Scoped reporting is owner/lease/role/principal-bound. Same-user steering remains arbitrary operator-user code, not a filesystem or tenant sandbox.
- Preserve summaries as separate explicitly requested work, using a separately configured profile/model and an immutable bounded source snapshot. Do not replace them with handoff digests or silently cut them.
- No new code comments or type-suppression directives. Reuse existing readers, error redaction, logging, authorization and transaction helpers.

## Review focus

- A claim slot reused after release must not revive its previous reporting authority; ownership fencing must preserve database timestamp precision.
- End racing a file report must produce either a complete durable artifact or no artifact, never successful metadata with missing bytes.
- Dirty, unknown, different-head, changed-definition and stale-attempt evidence must not become current through root grouping.
- Public task readers must not acquire transcript text, model/profile, private event cursors, capture proofs or machine configuration through new projections/history.
- Historical cursor boundaries, command/idea links, delivery arrays and review fingerprints must retain original identities and precision after archive/restore.

## Task 1: Shared archive/source schema and contracts

**Files:** create `packages/db/src/migrations/0034_execution_archives.sql`, `packages/db/src/collaboration/execution-archives.ts` and `packages/db/tests/collaboration/execution-archives.test.ts`; update `packages/db/src/migrations/meta/_journal.json`, collaboration exports and existing directory READMEs.

**Interfaces:** Archive IDs identify snapshots, not new executions. Each snapshot keeps `sourceRunId` unchanged, plus org/project/task ownership, capture time, per-record-type counts and a manifest hash. Records preserve original UUID, type, session linkage, source creation timestamp, exact serialized JSON and its SHA-256. Multiple snapshots may exist for one source run; sealed snapshots are immutable.

- `captureLegacyRunArchive({workspaceId,runId}) -> ArchiveManifest`: trusted operator operation, scoped to the collaboration workspace UUID, not the opaque `collab_runs.workspace_id` text. Preserve nullable historical workspace org IDs rather than inventing an org.
- `verifyExecutionArchive({workspaceId,archiveId,compareSource?:boolean}) -> {integrityValid,sourceMatches:boolean|null,issues}`: independently check stored bytes/counts/hash; optionally compare the live legacy source before cutover.
- `readExecutionArchiveExportPage({workspaceId,archiveId,cursor?,limit?}) -> {records,nextCursor}`: operator-only raw records. `getCollabExecutionArchive({actor,archiveId})` returns an allowlisted internal-read view; `getExecutionArchiveTimeline({actor,archiveId,sessionId,cursor?,limit?})` returns the existing timeline shape without consulting live connector data.
- `ArchiveManifest` has `id`, `sourceRunId`, `workspaceId`, nullable original `orgId`, `projectId`, `taskId`, format version **1**, capture time, counts keyed by `run/session/command/observation`, manifest SHA-256 and nullable seal time. Record pages retain exact JSON text, original IDs and six-digit UTC source timestamps.

- [ ] Add a failing real-PG archive round-trip test: preserve run/session/command/observation IDs, microsecond cursor boundaries and payload bytes; reject a foreign workspace, revoked principal and altered stored data.
- [ ] Add forward archive tables with ordinary primary keys; do not use a partial unique index as an FK target. Admission state belongs to the initially-open global control row introduced by migration 0044, not per-workspace archive metadata.
- [ ] Implement snapshot capture in a repeatable-read transaction with UTC serialization and bounded source pages. Insert records and manifest atomically; rollback leaves no partial visible snapshot.
- [ ] Implement integrity/source comparison and protected read projections. Raw export data is operator-only; browser readers receive allowlisted views, not serialized host configuration or machine paths.
- [ ] Run archive tests and migration journal checks. Record actual results before exposing any reader.

## Task 2: Claim-bound reporting and canonical resources

**Files:** modify `packages/db/src/collaboration/{tokens,runs,evidence,claim-executions,claim-handoffs}.ts`, `queries/claim-interactions.ts`, collaboration exports; create a native reporting module and migration `0035_claim_reporting.sql`; modify `packages/fluent-flow/src/collab/mcp.js`, agent-server poll delivery and follow-on claim linkage.

**Interfaces:**
- `ensureClaimReportingBinding(tx, {orgId,agentId,runnerSessionId,claimId,agentTokenId}) -> {bindingId,credential,captureKey}`. Mint only for an owned live collaboration claim.
- Internal report source is `{kind:'legacy',runId,sessionId}` or `{kind:'claim',claimId,reportingBindingId}`. User-visible source views never include credentials or capture keys.
- New claim links persist the initiating principal's actual session-version snapshot and server-derived reporting role. Follow-ons copy the original snapshot, not the principal's current version. Old rows without a trustworthy snapshot cannot mint new reporting authority.
- Native tokens bind the exact claim acquisition, runner session, originating agent token, task/project/org and reporting role. Store hashes and ownership fences, not plaintext credentials. Compare `claimed_at` in SQL without millisecond rounding.

**Integration rulings:** Reuse `collab_scoped_tokens.id` (UUID) as the native
reporting binding identity, not an integer or a synthetic legacy session.
Retain `kind: 'agent'` on authenticated MCP contexts and discriminate execution
through their explicit `source`. Migrate every caller; do not retain obsolete
run/session aliases. Repeated bootstrap for the same acquisition reuses a
deterministically derived, domain-separated credential and capture key rather
than minting an unbounded token set. Claim links store
`created_by_session_version` at initiation; fixtures must seed the actual
snapshot and an explicit missing-snapshot test must fail closed. Never infer
that snapshot from the principal's current version at bootstrap. Reporting role
is derived from claim work/summary purpose, then intersected with the current
initiator's required capabilities; it is not their membership role. No new
canonical reporting table or plain stored capture key is needed.

**Test prerequisites:** Use existing reader/output shapes and persisted
attribution rather than key-length or bare-defined assertions. Test downgrade
and revocation on formerly authorized principals. Test acquisition fencing by
changing the *same* claim's `claimed_at` by one microsecond; a new claim ID
alone does not exercise timestamp precision. Unknown binding IDs are UUIDs.

**Initial Task 2 integration failure (repaired below).** The initial coder
returned code without running checks, as directed. Parent observed a real-PG
fixture error (`collab_roles.capabilities` is `text[]`, not JSONB) and DB build
errors because native contexts still required obsolete run/session aliases.
At that gate, source inspection also found:

- Bootstrap stores a JS `Date` for `claimed_at`, losing the microsecond fence;
  it must persist/compare the acquisition in SQL, not round-trip that Date.
- Native token authentication compares the suffix against the whole credential,
  so valid minted credentials are rejected. Exercise actual token/MCP auth.
- Schema and validation omit the owning runner-session fence, disabled principal,
  credential expiry, org consistency and full role/capability checks.
- Initial claim creation and follow-ons do not yet persist the actual original
  session-version snapshot. No bootstrap-time inference is permitted.
- Poll delivery catches every bootstrap error and continues without reporting.
  Unexpected errors must fail loudly; known unavailable old origins need an
  explicit policy, not a catch-and-log fallback.
- Native file registration currently accepts metadata without storing bytes.
  It must fail closed until a real verified atomic capture is present.
- Capture proofs do not bind normalized tool arguments or relative references,
  and capture replay conflict handling is absent. No helper should adopt that
  incomplete signing contract.
- Legacy reporting tests/callers are not fully migrated and native summary work
  remains a separate Task 4 responsibility. This is not a completed parity gate.

**Repair verification:** DB TypeScript build, **23** real-PostgreSQL authority
tests and **17** mounted HTTP/MCP tests pass. The repaired implementation uses
the exact SQL acquisition and runner-session fence, current capability and
revocation checks, explicit original snapshots and atomic captured bytes.
Missing links/snapshots deliberately omit reporting; unexpected bootstrap
failures fail the poll and release the claim. Independent security review is
pending. Authoritative workspace freshness and native summaries remain later
gates; these checks do not establish complete feature parity.

- [x] Add failing real-PG/MCP tests for a native canonical check/plan/progress/idea and for cross-task, role, revoked principal/token, expired lease and reused-slot rejection.
- [x] Add nullable native source fields to canonical evidence, artifacts, ideas, plans/questions, summaries, usage and scoped tokens. Broaden non-human source constraints without removing them. Legacy UUID rows remain valid.
- [x] Extend existing work writers/readers and every caller to explicit sources. Resolve authority and attribution from stored bindings, not tool arguments. Recheck ownership/authority inside the mutation transaction with claim locking. Native summaries remain Task 4.
- [ ] Preserve check versions, output-artifact source ownership, visibility, author attribution, current-head/dirty freshness and existing transaction injection. Keep summary authority separate from ordinary work.
- [x] Extend `serverFor` callbacks to receive SDK `extra`; validate private capture metadata there and pass only validated internal capture values to the canonical writer. Reuse `/mcp/collab`; no second reporting stack.
- [x] Deliver bootstrap only to the authenticated owning runner. Add new credentials to redaction before bridge construction. Exercise actual MCP authentication and canonical reads, not mock forwarding echoes.

## Task 3: Native MCP adapter, durable bytes and workspace freshness

**Files:** create `packages/fluent-flow-agent-server/src/reporting-mcp.js` and a packaged launcher; modify `runner.js`, `acp/runtime.js`, package dependency/lockfile and runtime checkJs include; reuse the single implementations in `connector/artifacts.js` and `connector/workpad.js` until their later relocation.

**Interfaces:** A stdio descriptor uses `process.execPath`, an absolute packaged launcher path and helper-specific environment values. Forward the control-plane tool registry and normal calls. Intercept only file artifacts, replacing caller-supplied capture metadata with a secure local capture.

Private request `_meta['fluent-flow/file-capture']` includes version, binding/capture IDs, verified MIME/size/SHA/base64 and a domain-separated owner-bound HMAC. The installed SDK exposes request metadata as `extra._meta`; do not invent tool-definition metadata behavior. Sign material normalized arguments and capture identity; `_meta` alone is not authentication. Use capture IDs with existing idempotency storage; conflicting replay must fail and no automatic retry loop is added.

**Transport ruling:** derive the MCP target from the existing authenticated
HTTP client's normalized control-plane origin. Do not add a second independently
configurable reporting URL. Forward only claim reporting credentials and values
already visible in the ACP child environment, plus workspace redaction paths;
never put the durable runner token or unrelated coordinator secrets into the
helper environment.

**Workspace observation ruling:** the existing scoped MCP task reader exposes
only a decimal-string observation cursor and safe head/dirty/state metadata.
A runner-owned helper reads Git itself, then calls the canonical
`collaboration_report_workspace` tool with a domain-separated HMAC in private
request metadata. The server accepts exactly the next per-binding sequence,
replays identical current observations and rejects conflicting/stale ones.
Helpers serialize reporting calls and bootstrap from the persisted cursor
after restart; no clock-derived ordering or automatic retry is used.
Check freshness uses that exact acquisition's observed workspace, not another
run or the claim's advertised head. Unknown remains unknown. The owning runner
publishes a final observation after its provider has closed and before workspace
cleanup; terminal evidence without that finalization is not certified fresh.
Migration `0036` owns these observations and source fences; `0037` is reserved
for independently implemented native usage identity.

- [x] Add failing end-to-end SDK tests: report a real file through the injected helper, retrieve identical bytes after workspace removal/restart, and reject a forged or altered envelope.
- [x] Reuse `createArtifactReader` with an explicit **524288-byte** cap. Retain traversal, credential-name, symlink/descriptor, FIFO, MIME and SHA checks. Reject known secrets/private paths in exact file bytes rather than redact them while preserving a false original hash.
- [x] Store artifact metadata and verified `bytea` bytes in one transaction. Read authorized durable content before any historical connector fallback. Native file registration without verified bytes fails without a row.
- [x] Inject the descriptor into both ACP new and resume paths. Keep stdout protocol-only; close/abort the HTTP client and pending calls explicitly on stdin EOF, close and termination. SDK stdio construction alone does not handle EOF.
- [x] Report authoritative workspace head/dirty observations with owner proof, independent of model-selected event names. Use monotonic decimal-string sequences without JavaScript integer precision loss. Unknown stays unknown; do not substitute `agent_claims.head_sha` for an observed workspace.
- [ ] Exercise missing/oversized/changed/hash-invalid files, the exact size boundary, End/capture races, lost responses, helper failure, redaction and helper exit. Run Node 20/typechecks and real protocol smoke.

The native transport suite passes **19 scenarios on Node 22 and Node 20**,
including actual runner End, durable bytes, Git freshness, malformed/forged
observations, concurrent sequence conflicts, counters beyond JavaScript's safe
integer range, and helper teardown during HTTP and Git stalls. Git subprocesses
use an owned process group; `execFile` did not forward the detached option, so
the reader now uses `spawn` and terminates only its own group. Package-wide
smoke/full-suite verification remains pending for the final parity integration.

Native usage identity has **8 passing real-PostgreSQL regressions**. Migration
`0037` separates native acquisition samples from legacy session samples and
keeps snapshot precedence within the original reporting acquisition. Accepted
event projection now writes canonical cumulative provider-session costs in the
same transaction. Consumed token counts remain unknown; context occupancy is
not billing. Explicit typed snapshots prevent double counting with turn rows,
while preserving whole-acquisition snapshot priority and unavailable fallback.
The real PostgreSQL/HTTP concurrency regression exposed and fixed a task/claim
lock inversion. The usage slice passed **54 DB regressions**, **58 mounted
reporting/interaction/owner tests**, and independent scoped review. Native
summary authority and the wider Task 4 integrations remain open.

## Task 4: Native summaries, usage, decisions and unattended lineage

**Files:** `packages/db/src/collaboration/evidence.ts`, `summary-claims.ts` and `summary-settings.ts`; `packages/db/src/queries/claims.ts`; `packages/fluent-flow-agent-server/src/summary-claim.js`, `runner.js` and prompt owners; `packages/fluent-flow/src/agents/claim-manager.js`, `engine/review-manager.js`, `engine/verify-transitions.js`, `providers/github/check-run-handler.js`, `routes/webhook.js` and `routes/agent-server.js`; existing dashboard Workpad/Ideas/Insights/settings components.

**Interfaces:** Summary work is an ordinary bounded claim with its own reporting role, target/profile/model and frozen source cursor. No GitHub credential or repository edits are needed to summarize supplied source data. Results remain internal and explicitly not verification evidence. Source selection retains the existing **100-entry / 60000-character** bound.

Native summary defaults are separate from chat defaults and the preserved legacy
host summary configuration. Saving them requires current project administration
and internal-read authority. The selected runner must explicitly advertise
`summary` and a validated profile catalog; summary availability uses ordinary
work capacity, never chat-slot admission. Capacity-one and chat-disabled runners
can summarize. Offline saved selections remain identifiable, not silently mapped
to another runner or model.

An explicit summary request requires current internal-read, start and steering
authority. It freezes the selected source identity/cursor and bounded source
text, the effective configured profile/model, and the requesting principal's
session version. The summary claim has no repository or GitHub credential and
does not move the task between lanes. Its reporting role can publish its internal
summary and acquisition-bound usage, but cannot publish work progress, checks,
plans, artifacts or ideas. Work credentials cannot publish summaries. The model
cannot override frozen attribution through report arguments. A handoff digest is
not a generated summary.

Summary retry attempts retain one immutable logical request, frozen source and
profile/model. Each attempt has an explicit parent mapping. A result remains
attributed to the attempt that actually published it; a retry after publication
acknowledges that result without another paid turn. Completion requires the
canonical result inside the claim-finalization transaction, not an idle session.

Keep handoff mutations in the same task-before-claim lock order as accepted
event accounting. Exercise their concurrency before considering this gate done.

- [x] Add real claim tests for explicit/idempotent summary generation, frozen source/model attribution and rejection of work/summary capability confusion. Keep handoff digest separate.
- [x] Preserve typed usage semantics/deduplication and unavailable reasons; project native usage/plan/progress into the canonical readers atomically with their accepted source updates.
- [x] Update task review/delivery readers to native source head/dirty, requests, evidence revisions and source identity without reconstructing past review snapshots. Preserve human delivery/acceptance gates.
- [x] Add an authenticated build-PR association that validates the actual GitHub repository, task branch and head against owner-bound workspace state. Never infer task authority from a branch-name marker on an untrusted fork.
- [x] Link normal review/fix/verification claims through that association and authoritative parent relationships, including the race where the signed PR webhook arrives before the build association. Do not steal old/unrelated task history.
- [x] Exercise chat -> spec -> build -> signed PR webhook -> review/fix/verification with real Git and mounted services; external GitHub/provider APIs remain controlled test boundaries. Record the distinction from a paid-provider/GitHub live run.

### Task 4 PR association implementation contract

Reuse canonical delivery links for the verified PR association. The source is a
live, acquisition-bound build credential, or an already-linked fix credential
updating the same PR. Extend signed workspace observations with normalized origin
repository, the server-assigned task branch, and its locally observed remote head.
The GitHub repository/head repository, branch and head must match that witness.
Model-supplied PR numbers only select a GitHub read; they are never proof.

The reporting helper publishes that witness before forwarding a PR-link tool
call. Native build completion also performs the link before workspace cleanup,
so a missing or unverified PR cannot look like a successful delivered build.
Existing PR-scoped tasks retain their explicitly authorized branch; no branch
name is treated as task membership.

Keep an org/PR-scoped candidate and a pending-claim reservation for an early
signed webhook. Candidates carry genuine GitHub identity, not invented task or
session identities. The claim factory and association writer share a PR lock;
admission excludes reserved claims. Only a verified association releases matching
pending claims with the original task/creator snapshot and real parent/source
references. Already executed or unrelated history is never adopted. An event
that precedes the PR-open webhook resolves the same candidate through the
authenticated GitHub API before inserting work.

Same-task handoffs preserve the chat parent/root only for the same initiating
principal and session-version snapshot. A different initiator or explicitly
created destination uses the genuine new spec claim as its root, while
`handed_off_from` retains the causal transfer. New destinations get their own
task branch seeded from the prepared source SHA. Do not weaken parent-authority
constraints to make an unrelated task or initiator appear in an old root.

CI fixer selection follows actual parent ancestry from the current verified
producer. Sharing a root is insufficient when a chat has produced several
builds; an older still-active fix must not reserve the new build's CI work.

Normal follow-ons record actual parent claim IDs. Review prompts include their
real claim ID; a native review webhook must match an executed review on that PR
and head before producing children. It must not complete the still-running owner
lease merely because a GitHub review was posted. Unmatched or stale native
reviews cannot launch work. Non-native repository pipelines retain their current
behavior.

Native review verdicts are published once through the owning review claim's
authenticated collaboration MCP credential before posting to GitHub. Publication
freezes the verdict/findings and actual claim head under that acquisition. Its
public marker signs the publication identity and result digest, not merely a
claim nonce; copying a marker cannot change PASS to FAIL or replace findings.
Binding IDs, reporting credentials and signing material are not public marker
fields. GitHub is a delivery signal for that canonical publication, not an
authority source for arbitrary verdict JSON. Acceptance, retry accounting and
follow-on insertion share one transaction; redelivery cannot create another paid
claim or spend another retry. Historical publication fields remain immutable.

Verification order:

1. Real PostgreSQL authority/association tests: valid/idempotent linking; wrong
   repository, fork, branch/head, task, acquisition and role denials; immutable
   original source; no adoption of pre-existing unrelated claims.
2. Mounted signed-webhook/claim tests: pre-association review stays pending and
   unleased, then links atomically after proof; reversed event order; normal
   review/fix/verify parents; stale/missing review markers spend nothing.
3. Real Git plus mounted services: owner helper observes pushed task refs,
   native build links before cleanup, and chat/spec/build reaches the signed
   webhook review/verification path. GitHub/provider calls are controlled external
   boundaries, not evidence of a paid-provider/GitHub live run.

## Task 5: Historical access, archive export/restore and defaults

**Files:** `packages/db/src/collaboration/{execution-archives,runs,tasks,events,evidence,workspaces}.ts`; an operator archive launcher under existing `packages/db/scripts/`; `packages/fluent-flow/src/collab/routes-runs.js`; dashboard `task-detail.tsx`, `task-navigation.ts`, `types.ts` and a new read-only `legacy-run-history.tsx`; existing workpad/ideas/delivery/settings views.

- [x] Restore legacy history visibility inside the drawer alongside claim history, with no four-tab layout and no invented continuation. Preserve source run/session IDs and existing timeline cursor precision. Fix legacy run pagination, which currently ignores its cursor, before using a fetch-all client.
- [ ] Capture remaining legacy file bytes through existing authorized artifact reads before host revocation. Validate cached historical bytes against the declared artifact SHA; expose missing/unavailable captures as blockers, never as successful archival.
- [x] Implement operator-only raw execution snapshot export/import with counts, per-record SHA and manifest verification. Keep private configuration out of browser APIs. Restore original IDs, bytes and timestamps; reject tampered or foreign ownership data. This covers the four-record dump contract below, not the separate artifact/dependency backup.
- [ ] Add native/archive source references to every surviving canonical dependent and reader, including idea conversion command/session references, usage sentinel handling, delivery arrays and soft JSON references. Do not rewrite immutable acceptance decisions.
- [x] Preserve legacy project configuration without guessing host-to-runner identities. The 2026-11-15 user decision removes project chat overrides and the defaults mapper; agent operators must explicitly disposition stored configuration before retirement. Independent summary settings remain separate.
- [x] Prove authorized historic transcript/artifact access after a disposable export/restore rehearsal. Original canonical artifact rows and identifiers remain intact; this does not prove a complete canonical-dependency backup, authorize production deletion or ship replacement source constraints.

### Native idea follow-up contract

Preserve the existing explicit idea-conversion action; never turn an agent's
proposed idea into autonomous work. Extend `POST /ideas/:id/conversions` with an
integer `claimId` destination for `follow_up`, mutually exclusive with the legacy
UUID `sessionId`. Require current task-write, internal-read and steering
authority, a same-task active chat, optimistic idea version and idempotency key.
No implicit latest session, automatic session start or unattended build.

Add `0042_claim_idea_conversions.sql` with nullable
`conversion_claim_id`/`conversion_claim_command_id` and source-consistency checks.
Keep legacy command/session UUIDs distinct and unchanged. Return native
`claimCommandId` separately from legacy `commandId`; expose the idea's genuine
origin `claimId` without changing it to the follow-up destination.
Reuse `submitCollabClaimCommand(input, client?)` inside the conversion transaction,
including executor-scoped authorization. Idea state, command originator and
idempotency receipt commit together or all roll back.

The drawer lets an authorized user explicitly select an active chat and request
a follow-up from an inbox idea. A closed/replaced session never silently retargets
the request. Existing task conversion remains backlog-only. Verify mounted
MCP-to-idea-to-command behavior, cross-task/non-chat/ended-target rejection,
revocation, replay and rollback, then the actual production browser interaction.

### Canonical execution-source links

Checks, artifacts, plans and questions expose their genuine nullable `claimId`
alongside preserved original `runId`/`sessionId`, matching idea attribution.
Reporting credentials, binding IDs and acquisition secrets never enter these
views. Human-only sources stay unbound; no claim or legacy UUID is synthesized.

Resolve an original legacy session or command UUID under its authorized task,
preferring live storage and otherwise a verified sealed archive. A conversion's
destination may be in a different run from its idea's origin: resolve the actual
command/session, never borrow `idea.runId`. The read-only endpoint returns the
original navigation IDs and source kind, not private command payloads. Reject
foreign-task, ambiguous, corrupt or unauthorized references without resuming work.
Add a `(record_type,record_id)` lookup index; do not replace IDs or source FKs.

Drawer source links use current internal-read authority and existing board
navigation. Delayed reference lookups cannot reopen a previous task or restore
revoked context. Existing canonical delivery/decision/idempotency JSON and arrays
remain unchanged; their cross-source dependency preflight is still required.

### Agent-owned chat configuration contract

The 2026-11-15 user decision supersedes the earlier project-default mapper.
Chat uses ordinary eligible agents, or an explicit per-operation target, and
the selected runner's local profile/model/permission policy. There is no project
chat-settings panel, backend selector, settings API or replacement mapping writer.
Stored project mode/agent/profile/model/instructions and lifecycle overrides do
not affect new chat claims. Old delivered profile/model values do not override
local runner policy.

Remove the obsolete project-default mapper and its launcher rather than keeping
a hidden writer. The follow-up migration `0045_remove_project_chat_settings.sql`
drops the five dead project chat columns only after PR154's no-reader code has
fully deployed and older instances have stopped. Keep already-applied migrations
unchanged.

Preserve still-used legacy JSON, host/mapping records and project run/test
instructions. Agent operators must preserve and explicitly disposition that
historical configuration and repository context before connector retirement;
no profile/model or checkout equivalence is inferred. Native summary settings
remain separately authorized and unchanged.


### Operator execution-dump contract

This is the raw run/session/command/observation snapshot transfer, not a complete
canonical artifact/dependency backup. Artifact-byte capture and dependent-row
re-keying remain separate Task 5 requirements.

- Reuse the archive schemas, hashes, ordered records and repeatable-read
  transaction. `writeExecutionArchiveDump({workspaceId,archiveId}, writeEntry)`
  writes one header, ordered records and a required completion footer through
  an awaited sink. Never buffer the full dump or publish a successful export
  whose counts, record hashes or manifest digest fail verification.
- `restoreExecutionArchiveDump({workspaceId}, entries)` consumes an async
  stream. Require the same pre-existing workspace/project/task identities and
  ownership; no destination-ID remapping or fake live runs/hosts/tokens.
  Restore archive records with original UUIDs, exact payload JSON text and
  microsecond timestamps in one transaction. Validate each record's identity,
  run/task/project/session scope, referenced sessions, counts, ordering and
  hashes. Reject tampering, truncation, extra records and foreign ownership.
- Preserve the original archive ID and seal timestamp. Import never cuts over
  execution, freezes writers, revokes credentials or permits deletion. Exact
  replay must validate the entire incoming stream and existing stored archive
  before returning the same archive; conflicting existing data is not replaced.
- Add an operator CLI under the existing database scripts directory:
  `capture --workspace-id --run-id`, `verify --workspace-id --archive-id
  [--compare-source]`, `export --workspace-id --archive-id --output`, and
  `import --workspace-id --input`. Database credentials come only from
  `DATABASE_URL`; never run migrations automatically or expose raw dumps over
  HTTP/stdout. File output must be private, refuse overwrite/symlinks and remove
  only its own failed output. A crashed partial export is not a valid dump.
  Malformed input must not print raw private backup content or secrets.
- Rehearse through the actual CLI and PostgreSQL in a guarded disposable
  database: preserve canonical parent scopes, simulate loss of only fixture
  execution/archive storage, import, verify and read the original authorized
  transcript. Keep Unicode, provider sequence strings beyond safe integers,
  original cursor precision and private machine configuration byte-exact in
  the private dump, while browser metadata remains sanitized.

## Task 6: Freeze/drain preparation and staged publication

- [x] Implement a server-side global admission fence for every new legacy run/session/prompt/retry/summary/follow-up, legacy `execution_defaults`, host and mapping write. Serialize admission against freeze; leave acknowledgements, observations, permission answers, cancellation, reconciliation and artifact capture available to drain. Global scope is explicit because host enrollment has no workspace scope. The obsolete project chat-backend switch has been removed.
- [x] Provide truthful drain inventory covering idle/resumable sessions and pending/accepted/ambiguous commands as well as active runs. Native-child settlement and remote retained work require authoritative operator/host evidence, not heartbeat guesses.
- [ ] Seal only verified immutable archive snapshots after their source is fenced and required bytes captured. Host and reporting-token revocation are distinct steps. No sealing flag by itself authorizes deletion.
- [ ] Run full suites, actual production UI/protocol paths, integrity/restore rehearsal and independent cross-provider/security reviews. Open the separate parity PR against the additive branch and verify its CI; do not merge.
- [ ] Keep final removal blocked until the re-key PR has shipped, real target counts/checksums/backup/restore/drain are verified and the destructive migration is separately approved. Only then remove obsolete connector runtime/config/API/settings/callers and preserve surviving attribution.

Here, default writes means the legacy `execution_defaults` JSON. Ordinary native
claims and native summary settings remain available after freeze. There is no
project chat-settings API or defaults mapper. Still-used legacy configuration
remains stored for explicit preservation and operator disposition; it is not
part of the five-column chat-settings cleanup.

### Admission and inventory implementation slices

1. **Fence actual legacy producers** (`risk:high`, no prerequisite): use one
   initially-open control row, shared-lock it inside admission transactions, and
   exclusively freeze that row through an operator-only function with NOWAIT.
   Busy admissions return `legacy_execution_busy` without applying a freeze;
   the operator must retry explicitly after settlement. Missing control state
   fails closed. Existing idempotent receipts remain readable; no new legacy
   intent can commit after a successful freeze returns. Deploy the fence to
   every producer first. No public HTTP/MCP freeze endpoint or automatic
   activation, revocation or deletion.
   Demonstrate actual host/mapping/default/start/session/prompt/summary/retry
   rejection, transaction rollback and a racing admission/freeze boundary, while
   owner acknowledgements, observations, permissions, cancellation and capture
   still drain.
2. **Expose a read-only operator inventory** (`risk:medium`, depends on slice 1):
   report persisted run/session/command state counts, stored defaults/mappings,
   observations, legacy scoped tokens and unrevoked hosts from one snapshot.
   Idle/resumable and ambiguous work stays visible. A zero server count never
   certifies remote-child exit, retained local work or a private backup.
   Demonstrate the actual CLI without printing tokens, machine paths or payloads.
3. **Verify the assembled boundary** (`risk:high`, depends on slices 1 and 2):
   run real DB/mounted API/CLI cases and independent review. Keep activation,
   decisive post-fence recount, host inspection/config backup, credential
   revocation and final removal as separately authorized operational actions.

The production read-only snapshot contains no legacy defaults, mappings or
execution history requiring a broader Git-ref translation engine. Keep the
strict mapper and explicit unsupported-source blockers rather than add new
profile/ref functionality for hypothetical data. Recount after a shipped fence;
newly discovered sources still require an explicit preservation disposition.

