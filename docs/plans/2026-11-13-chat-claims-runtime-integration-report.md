# Task 2 — production chat runner integration

## Gate status

**Production runner integration and automated safety gates pass. Chat remains default-off, explicitly operator opt-in; this is not overall spec completion or a production UI release.** `runner.js` actually calls `runChatSession` for delivered chat claims. The mounted application/HTTP/PostgreSQL tests spawn a real deterministic ACP child and exercise claim acquisition, idle opening, multiple prompts, active response cancellation, explicit end, terminal-result response loss/retry, authoritative idle/host expiry and admission shrink. The earlier report's “isolated protocol core, not connected” status is superseded for this slice.

Controller/independent review is still required. No agents were spawned. No commit, push, merge, deploy, connector removal, UI/handoff work, shared database migration or real credential-file access was performed. Existing dirty backend files and the binding spec were preserved; the parent is separately updating the spec approval record.

## Implemented boundaries

| Boundary | Implemented behavior / evidence |
| --- | --- |
| Actual dispatch | `createAgentServer` loads an explicit local profile file, creates shared safe chat storage, passes it to ordinary slot runners. Opted-in runners advertise chat and dispatch it to `runChatSession`, not the work prompt/verification loop. Default runners advertise only existing work types. Server composition and real claim transport are tested. |
| Sticky lifecycle | Prompt-free ACP opening; idle command service; serialized follow-ups; renewed prompt leases; acceptance acknowledgements; active-turn Cancel distinct from End. Child exit and shutdown are supervised. Existing unattended recovery and verification behavior remain unchanged. |
| Ownership | Existing heartbeat runs through idle/turns. Null claim/410 aborts chat and reaps the child; an immediate final heartbeat reconciles expiry/end committed during transport. The runner never overwrites an authoritative terminal row with a generic shutdown result. Mounted tests preserve `idle` and `host_lost`. |
| Results | No chat `completed` result. User End/duration return cancelled; child loss/setup failure returns terminal failed/host_lost. Existing bounded result retry sends the same claim/session/result identity, proven with a deliberately lost response **after** the mounted backend persists the result. A lost End-command acknowledgement propagates/logs its transport failure but carries the already-applied user-end result for final reporting. There is no automatic chat redispatch. |
| Independent resource release | ACP close/reap precedes return. Workspace release/inspection is background work and cannot hold the slot or process. Inspection failure retains evidence and degrades health. A test holds filesystem release unresolved and proves the real child exits and `activeWork` clears. Same-task immediate reopening waits for prior local cleanup rather than losing edits or failing an EEXIST race. |
| Credentials | New owning resolver `getInstallationCredential` atomically returns the token **paired with its actual provider expiry**, including cache and single-flight paths. Chat poll overwrites payload expiry/token; repo-null resolves neither. Runner strips inherited GH/GITHUB/GIT/SSH authentication environment and ignores even a malformed delivered repo-null token. A deterministic child reports credential-presence as a boolean; repo-null is false. Linked chats cap at earlier token expiry/8 h; expired credentials start no child. No refresh invented. |
| Ask/confirm/model | Strict local allowlist; no remote executable/argv/env. Runtime checks advertised ACP v2 config selectors/options, sets and verifies the selected model and `ask`/`confirm` permission value **before any prompt**, then fails terminally on subsequent config drift. Unsupported adapters fail closed; no guessed provider flags. |
| Safe workspaces | Separate manager, not legacy worktree cleanup. Checked-out `ff/task-<task UUID>` branch, per-claim Git worktree, inactive retained checkout moved/resumed on later task sessions. Per-repository local mutex prevents clone/fetch/worktree races. Real Git tests cover concurrent tasks, dirty/unpushed/ignored content, remote-ref deletion, clean/pushed removal and resumption. |
| Durable retention/startup/discard | Private atomic task/claim receipts exist **before preparation**, default retained. Dirty (including ignored), unpushed, uninspectable and repo-null work stay. Clean removal requires refreshed/pruned origin reachability, not stale refs, and never uses force. Dead-process startup reconciliation reclaims lease metadata only, deletes no chat work. Explicit local discard requires a named inactive retained receipt and confirmation, and rejects a replaced workspace symlink. Shipped local CLI is tested as a real child. |
| Transcript budget/privacy | Future-emission budget charges queued payloads conservatively before upload; single truncation marker, reserved state/user/config/notice capacity, no sequence gaps, no persisted-history mutation. Exhaustion does not fail the session or block commands/results/requests. Actual runner-bridge tests continue sticky turns and End after truncation. Workspace/source roots are elided using existing stream/payload redaction. |
| Capacity | Existing conservative capacity-minus-one admission retained. Mounted concurrency test now also proves the reserved slot actually acquires a work claim. Mounted runner tests lower `max_chat_slots` to zero without killing the live chat or preventing follow-up/active Cancel. No aggregate admission weakening. |

### Deliberate conservative rulings

1. Keep automatic startup deletion disabled for **all** chat work, including old repo-null scratch. Only normal verified clean/pushed release or explicit local discard removes it. Cost: retained disk usage can accumulate.
2. Use the durable state volume for production chat storage, outside the work root. A sibling of `/work` is often unwritable in the non-root container. Programmatic standalone runners retain a sibling-root default; the production server explicitly supplies the state directory. Reject a state storage location inside the work root. Cost: operators must preserve/size the state volume for retained work, not merely credentials.
3. Pin actual locally verified ACP v2 selectors plus `ask`/`confirm`, never infer unsupported provider switches. Cost: a provider without this configuration contract cannot run chats even if unattended execution works.
4. Reserve 4 MiB of the **charged** 16 MiB transcript ceiling for state/user/config/notice emissions. If this finite reserve also fills, suppress later transcript events rather than fail the session. Commands, permission requests/answers and terminal claim results remain separate durable data. Cost: extreme sessions lose later transcript detail; suppressed output alone does not refresh server activity.
5. Capacity remains conservative per polling instance, not summed across heterogeneous instances. Lowered admission does not force-kill live chats; excess sessions drain at ordinary inactivity/duration/explicit-end boundaries, **not immediately on a response-idle transition**. Cost: temporary excess after a shrink and under-admission across heterogeneous instances. The spec's more aggressive immediate resize behavior is not implemented.
6. Bounded report retries are not an infinite durable outbox. If all retries/control-plane contact fail, the runner logs/propagates the failure, releases local resources and relies on authoritative host-loss expiry; chat is never redispatched. Cost: the UI can show the previous claimed state until expiry instead of the intended end reason during a sustained outage.

## Exact contracts for task 3

### Local configuration and registration

`--chat-profiles-file /operator/local/catalog.json` is the explicit preview opt-in. Absent means disabled. File limit: 64 KiB. No catalog or permission policy is read from a claim's process configuration.

Strict file schema (array, 1–32 profiles; duplicate profile IDs rejected):

```ts
{
  id: string;
  permission: { configId: string; value: 'ask' | 'confirm' };
  models: string[];              // at most 100, unique
  modelConfigId?: string;
  defaultModel?: string;         // required and allowlisted when models is nonempty
}[]
```

Identifiers are 1–128 characters and match `[A-Za-z0-9][A-Za-z0-9._:/-]*`. Empty `models: []` means leave the provider model unchanged. Permission/model selectors are **provider-advertised ACP v2 configId values**, not executable options; the file pins the operator's known safe permission value. The deterministic fixture uses `approval=ask`, but that is **not a real-provider default**.

Each opted-in slot registers through the existing `POST /api/agent-server/register` with:

```ts
meta: {
  // existing runtime/instance_id/slot_id/capacity/provider/deployment/... fields
  supported_claim_types: ['spec','build','review','review_fix','test_verify','verify','chat'];
  profiles: { id: string; models: string[]; default_model?: string }[];
}
```

No permission selector, command, argv, environment, workspace path or secret is advertised in `profiles`. Schema validation is local; the actual provider capability/selected-value confirmation occurs when the session opens. The disabled path has no added `profiles` field and no chat support.

### Delivered claim and selection

The actual poll work object is flat, not a new nested runtime payload:

```ts
{
  claim_id: number;
  task_id: string;               // authoritative task UUID from the claim row
  claim_type: 'chat'; claimType: 'chat';
  repo: string | null;
  attempt: number;
  agentType: string;
  profile?: string;              // local allowlisted profile ID
  model?: string;                // local allowlisted model ID
  githubToken?: string;          // repository-linked only; internal runner delivery
  githubTokenExpiresAt?: string; // actual provider ISO expiry; repository-linked only
}
```

Omitted `profile` uses the **first local profile**; omitted `model` uses that profile's `defaultModel`, or leaves it unchanged for an empty model list. Unknown selections fail before workspace/child setup. Top-level `command`, `args`, `env`, `acpCommand`, `acpArgs` and `providerEnvironment` in delivered work are rejected. Agent targeting remains enforced by the owning backend poll query; the runner does not trust payload target/executable fields.

**Not added here:** mounted defaultAgent/profile/model/execution_mode read/write APIs or project-default validation/projection. Task 3 must validate persisted project selections against the latest catalog and place selected `profile`/`model` into claim payload/delivery. It must not introduce a new process configuration channel. Runtime allowlisting remains the final enforcement boundary. `task.write` for New session is the already-approved backend permission ruling, not a blocker.

### Commands, events, requests and terminal results

Existing transport paths are retained: `/api/agent-server/claims/:claimId/{events,requests,commands/poll,commands/:id/renew,commands/:id/ack}`. Dashboard/service commands use existing claim-execution command routes and delivery-time capability revalidation.

- `prompt`: `{ kind: 'prompt', payload: { text: string } }`; serialized between turns. Ack only on ACP acceptance, with `{ applied: true, messageId }`. Lost/uncertain acceptance is never replayed.
- `cancel`: current response only. Ack `{ applied: boolean }`; false while idle. Never terminalizes a chat.
- `end_session`: closes/reaps child, acknowledges `{ applied: true }`, reports cancelled/user. Separate from turn Cancel.
- `permission`/`elicitation`: existing request-key and answer object contracts. Explicit runtime invalid/not-open rejection is acked `failed` with a generic error, preserving the session and allowing the request to reopen. Transport/uncertain failures propagate rather than being mislabeled applied.
- Queue/command-ID limits from the prior core remain: at most 64 pending/active prompts, at most 8192 remembered delivery IDs per session. Queue overflow gets a failed ack; reaching the lifetime ID ceiling ends rather than forgetting/replaying intents.

Normal event shape remains `{ seq, kind, payload: { claimId, sessionId, raw, entity? } }`; `sessionId` here is the ACP session, not the control-plane slot. New truncation event:

```ts
{ seq: number, kind: 'notice', payload: {
  claimId: number, sessionId: string,
  raw: {
    sessionUpdate: 'notice',
    type: 'transcript_truncated',
    message: 'Transcript truncated; later verbose output is omitted.'
  }
}}
```

UI must render this explicitly. No historical events are replaced/deleted. Charged event cost is `2 * UTF8(JSON.stringify(payload)).length + 1024`, conservatively covering PostgreSQL JSONB whitespace. Permission/elicitation requests are separate persistence and retain existing redaction. File roots are elided; authorized transcript visibility still requires `internal.read`.

Final result uses the existing `/api/agent-server/claim` contract with authoritative `claim_id`, `session_id`, `attempt`, nullable `repo`, and `status: 'cancelled'` plus `end_reason: 'user' | 'max_duration'`, or `status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost'`. `idle`/expiry/no-capacity reasons remain backend-authoritative; a null final heartbeat skips writing any competing result. No new result status or public `chatOutcome` field was added; that field is only internal error propagation for an already-applied terminal intent.

### Retention receipt and local discard

Production paths:

- repository caches: `<state-dir>/chat-workspaces/repos/<owner>/<repo>`;
- checked-out workspace: `<state-dir>/chat-workspaces/tasks/<task UUID>/chat-<claim ID>`;
- repo-null scratch: `<state-dir>/chat-scratch/<task UUID>/chat-<claim ID>`;
- receipt: `<state-dir>/chat-workspaces/tasks/<task UUID>/<claim ID>.json`;
- exclusive task lease metadata: same task directory's `lease/pid`.

Receipt JSON:

```ts
{
  task_id: string; claim_id: number; repo: string | null;
  active: boolean; retained: boolean; pid: number; updated_at: string;
  reason: 'active' | 'dirty' | 'unpushed' | 'scratch' | 'inspection_failed'
        | 'preparation_failed' | 'clean_pushed' | 'resumed' | 'host_lost'
        | 'explicit_discard';
}
```

Receipts are private local operator data, written mode 0600 by atomic rename; roots are created 0700. Windows ACL/privacy behavior was not executed in this Linux pass. There is **no mounted retention projection** yet. Task 3 must add an authorized, scoped projection for “unsaved work from session N”; do not expose raw local paths/PIDs to arbitrary browser readers. A receipt is not a new agent prompt or workpad artifact.

Shipped local tool: `node <installed package>/bin/fluent-flow-chat-discard.js --work-dir WORK_ROOT --state-dir STATE_ROOT --task-id UUID --claim-id NUMBER --confirm`. No remote discard command/API. It refuses active/non-retained/unknown work and a symlinked workspace target. Repo-linked force removal exists **only** behind this explicit local discard; normal release/startup never force-deletes chat work. Keep one server process per private state/work root; cross-process conflicting leases fail closed.

## Verification and full logs

All logs below are under `/home/victor/.hermes/cache/scratch/`. Commands were actually run, full output redirected, underlying exit statuses inspected. Final package runs include their real DB-gated suites, not only mocked units.

| Command / gate | Result | Full log |
| --- | --- | --- |
| `COLLAB_CONNECTOR_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_connector_integration npm test -w packages/fluent-flow-agent-server` | exit 0; **52 files / 914 tests** | `chat-integration-agent-release-gate.log` |
| `DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_legacy_integration TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_legacy_integration COLLAB_ROUTES_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_chat_integration AUTH_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_auth_integration npm test -w packages/fluent-flow` | exit 0; **78 files / 783 tests** | `chat-integration-server-release-gate.log` |
| `COLLAB_DB_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32771/ff_db_integration npm test -w packages/db` | exit 0; **23 files / 327 tests** | `chat-integration-db-full.log` |
| `npm run build -w packages/db` | exit 0 | `chat-integration-db-build.log` |
| `npm run typecheck:runtime -w packages/fluent-flow-agent-server` | exit 0; actual checkJs compiler covers chat modules, ACP, runner/server/config and transitive runtime dependencies | `chat-integration-runtime-typecheck-release-gate.log` |
| `npm run typecheck -w packages/fluent-flow-agent-server` | exit 0; existing connector check, kept separate | `chat-integration-connector-typecheck-release-gate.log` |
| `npm run smoke -w packages/fluent-flow-agent-server` | exit 0; `Portable agent server smoke passed.` | `chat-integration-smoke-release-gate.log` |
| Mounted HTTP/PG/real ACP runner + capacity suite | exit 0; **2 files / 39 tests** | `chat-integration-http-capacity-green.log` |
| `git diff --check` | exit 0 | `chat-integration-diff-check.log` |

Runtime typecheck is incremental/non-strict (`checkJs: true`, explicit `strict: false`, `noImplicitAny: false`), not a claim of fully strict typing. Small JSDoc boundary annotations were added to existing ACP/environment/client/worktree and transitive verification helpers; unattended behavior was not changed. It runs the installed compiler via an npm script, so the prior direct oversized-entry scan blocker is gone.

Only newly created disposable loopback `ff_*` databases in `ff-chat-integration-pg` (127.0.0.1:32771) were migrated/reset. The container was stopped and its exact-name read-back is empty: `chat-integration-postgres-cleanup.log` and `chat-integration-postgres-cleanup-verified.log`, exit 0. No shared/pre-existing database was migrated.

### Actual RED → GREEN / breaking verification

RED logs intentionally fail; their fixes are covered by the final green runs above:

- `chat-integration-red-expiry.log`: credential-pair resolver missing.
- `chat-integration-red-delivery.log`: payload expiry leaked/real expiry absent; repo-null expiry not stripped.
- `chat-integration-red-workspace.log`: safe workspace manager absent.
- `chat-integration-red-policy.log`: allowlist absent; provider confirmation unavailable/unsupported configuration incorrectly accepted.
- `chat-integration-red-optin.log`: explicit local catalog CLI option absent.
- `chat-integration-red-runner-http.log`: actual runner never acquired/ran chats.
- `chat-integration-red-invalid-answer.log`: invalid permission answer killed the session instead of a failed ack.
- `chat-integration-red-privacy.log`: actual bridge exposed its local scratch/source root.
- `chat-integration-red-active-cancel.log`: mounted fixture completed before active Cancel; a deterministic held-response fixture now proves applied=true, without changing production cancellation behavior.
- `chat-integration-red-policy-drift.log`: provider drift incorrectly allowed the turn to complete.
- `chat-integration-red-state-storage.log`: production storage used an often-unwritable work-root sibling instead of the durable state volume.
- `chat-integration-red-stale-remote.log`: stale origin refs incorrectly authorized deletion after the remote ref disappeared.
- `chat-integration-red-ignored-work.log`: ignored uncommitted work incorrectly appeared disposable.
- `chat-integration-red-prepare-receipt.log`: no recovery receipt existed before clone/preparation could be interrupted.
- `chat-integration-red-repo-concurrency.log`: concurrent task clones raced on a shared base; fixed with the existing repository mutex.
- `chat-integration-red-immediate-resume.log`: same-task reopen raced asynchronous release and got EEXIST; fixed with local task-lease serialization.
- `chat-integration-red-discard-cli.log`: real explicit local discard entry absent.
- `chat-integration-mutation-repo-null.log`: intentionally removed the repo-null token guard, observed the real runner test fail on delivered GH_TOKEN, then restored the guard. Final runs are on the restored implementation.
- `chat-integration-red-end-ack-loss.log`: self-review found that applied user End became failed/host_lost on acknowledgement loss. Fixed by preserving the terminal intent while still propagating/logging transport failure; final full agent/server gates rerun after this fix.

### Existing package smoke root cause

The prior pass reproduced the timeout on HEAD but did not explain it. `chat-integration-smoke-diagnosis.log` now shows the actual cause: generated extensionless `bin/git` is ESM but lives under scratch outside any `type: module` scope; Node v26.9.0 rejects its `import` before ACP starts. Both claims failed in worktree preparation, so overlapping running states could never appear. The smoke now writes an explicit local `package.json` with `type: module` for fixture executables and includes redacted captured process diagnostics on failure. No product Git behavior was changed. The real package smoke is green; no baseline waiver remains.

An initial full agent run used `ff_agent_integration`, rejected by the connector suite's stricter `ff_connector_*` naming guard before DB access (`chat-integration-agent-full.log`). Correcting the disposable database name produced the passing complete runs above. Early runtime compiler logs contain inference errors; these were resolved rather than reported as a pass.

## Remaining gates / limits, not hidden implementation claims

- Independent controller/security review, real-provider compatibility/authentication and deployment/image/platform release gates remain. No real provider invocation, paid model run, live GitHub credential or Windows execution was used. Unsupported real adapters remain fail-closed, not auto-configured.
- The mounted full runner smoke is repo-null. Repo-linked workspace lifecycle uses real local Git repositories, credential expiry delivery uses the owning resolver and route tests, and expiry enforcement uses real ACP fixtures. A single combined live GitHub-token + hosted-provider + remote-repository smoke is **not** claimed.
- No 8-hour wall-clock soak was run; deterministic shortened-clock deadline/queue/lease tests cover those transitions. A sustained control-plane outage ultimately reconciles by backend host-loss expiry; no durable infinite result outbox/credential refresh/context reconstruction exists.
- Aggressive aggregate resize/next-response-idle eviction is deliberately not implemented; conservative admission/drain behavior is described above. Do not advertise aggregate live resizing.
- Task 3 owns mounted catalog/default-agent/default-profile/model/execution_mode mutation/read APIs, selected model/default plumbing from project settings, board/session progress/command-ack/retention projections, the approved drawer UI and measured user-action-to-visible-token p95. These are not blockers to the tested runtime interface and were explicitly kept out of this pass.
- Handoff, re-key, connector freeze/drain/removal and destructive schema changes remain later tasks. The connector has not been deleted or disabled.

## File inventory for review

New runtime/support artifacts: `src/chat-profiles.js`, `src/chat-workspace.js`, `src/chat-event-budget.js`, `bin/fluent-flow-chat-discard.js`, `jsconfig.runtime.json` (under the agent-server package). Existing untracked `src/chat-loop.js` was extended; it was not discarded/replaced with a work loop. Runner/server/config/ACP runtime integrate them; README and package script document/gate them.

New tests: agent-server `chat-profiles.test.js`, `chat-workspace.test.js`, `chat-event-budget.test.js`, `chat-discard.test.js`, `runner-chat.test.js`; server `agent-chat-runner.test.js` and `providers/github/token-expiry.test.js`. Existing chat-loop/fake ACP/config/server/poll/capacity tests were extended. Token resolver and poll route are the only additional server implementation changes in this continuation. Type-only JSDoc updates in existing transitive runtime/verification helpers and the reusable repository-lock export are included in the tracked diff. No DB implementation/migration changes were made in this continuation.

Final self-review only (no agents permitted): examined runner ownership/report/cleanup integration, provider fail-closed selection/drift, Git retention/resumption/concurrency, immutable-budget behavior and credential transport/environment. This is weaker than an independent review and does not replace the parent's acceptance gate.
