# Collaborative Kanban and Paseo shared contracts

[Documentation](../README.md) | [Plan](2026-10-19-collaborative-implementation.md) | [Specification](2026-10-19-collaborative-spec.md) | [Status](2026-10-19-collaborative-status.md)

Status: approved-scope implementation contract, 2026-10-19. These are decisions for implementation, not claims of shipped behavior. Owners A (persistence/API), B (dashboard/auth) and C (connector) must use these names and boundaries. A owns the shared Zod definitions exported by `@fluent-flow/db`; wire fields use camelCase. UUID identifiers and UTC ISO timestamps unless stated otherwise. No application code is changed by this planning document.

## Ownership and transport

- A: all new database migrations, shared collaboration schemas/services, Express collaboration/connector routes, scoped MCP, authorization, invitations/password persistence and delivery evidence. New tables have `collab_` prefixes. No ALTER/DROP on existing production tables, including `users`, `agent_claims`, `repos` or `user_orgs`. Use raw parameterized pg queries/transactions for new services.
- B: all new dashboard pages/components, NextAuth callbacks/Credentials provider, invite redemption/login, existing AuthGuard updates, same-origin collaboration proxy, and UI tests.
  The separately assigned prerequisite coder owns existing `packages/db/src/queries/{agents,pipelines,claims}.ts`, their old API/server-page callers and regressions. A/B must not edit those files until that prerequisite lands; consume its explicit `isSuperadmin = false` query argument. That prerequisite does not own auth, login, navigation or new task paths.
- C: runner connector mode, local durable launch journal, Paseo SDK adapter, allowlisted local host mapping, execution observations, command processing, safe artifact reads and wrap-up. C proposes protocol corrections through this document before changing field names. C does not edit migrations or server routes.
- Browser calls `/api/collab/v1/...` on Next.js. B's proxy forwards to the same Express prefix with a server-only, HMAC-signed 60-second actor assertion `{iss:'fluent-flow-dashboard',aud:'fluent-flow-collab',sub:principalId,sessionVersion,iat,exp}`; shared secret never reaches browser. Express validates signature, audience/issuer, expiry, current enabled principal/sessionVersion and current membership on every operation. Never trust caller actor IDs, membership lists or capability booleans. Proxy rejects cross-origin mutations and strips inbound authorization/actor headers.
- Connector calls `/api/connector/v1/...` outbound over authenticated HTTPS (loopback HTTP allowed for local smoke). Token is hashed at rest, scoped to one host, revocable; not the legacy global MCP token. No Mac-to-PC incoming listener or browser-to-daemon access.
- New collaboration MCP uses a separate scoped endpoint `/mcp/collab` and individual/project-scoped hashed tokens resolving to a principal. It calls the same services as HTTP. Global legacy MCP admin tokens grant no access to this endpoint. No user-supplied filesystem paths.

## Identity and permissions

`Principal = {id,displayName,email,legacyUserId:number|null,disabledAt:null|timestamp,sessionVersion:number}`. GitHub login continues to use existing `users`/`user_orgs` behavior and also resolves a collaboration principal by legacy user ID. Invited users are stored only in additive identity tables and use an invitation plus a password (scrypt, random salt, bounded lengths, constant-time comparison). Invitation URLs carry a single-use random secret; store only its hash, target email, expiry, inviter, scope and role. Admin can copy the invitation to deliver privately; email delivery is not a prerequisite. Possessing an invite does not authorize linking an existing GitHub identity by matching email. Existing-principal invitation acceptance requires sign-in as that principal. Rate-limit redemption/login; uniform invalid-credential response; rotate sessions on password reset/revocation.

B adds `session.user.principalId:string` and makes legacy `session.user.id:number|null` explicit for non-GitHub users; legacy `orgs` is empty and `isSuperadmin` false for them. Audit every old route before enabling Credentials login: **empty org IDs must never mean unrestricted access**. Replace implicit empty-array bypass with explicit trusted `isSuperadmin` in shared query scope and migrate all callers. Invited-user direct requests to old `/api/agents`, `/api/pipelines`, claims, repos and detail URLs return empty lists/404 or 403, not other clients' internals. Keep genuine superadmin and GitHub onboarding behavior working. Collaboration-only users enter the board without a GitHub installation CTA.

### A/B identity service exports

A exports the following server-only interface from `@fluent-flow/db`, implemented in `packages/db/src/collaboration/auth.ts` and re-exported through the package index. B imports it only in server modules. A owns that file and its directory README; no client bundle may import it. Domain services accept `CollabActor` and reload current roles.

```ts
type CollabActor = {principalId:string;sessionVersion:number};
type CollabPrincipal = {id:string;displayName:string;email:string|null;
  legacyUserId:number|null;disabledAt:string|null;sessionVersion:number};
ensureGithubPrincipal(input:{legacyUserId:number;displayName:string;email:string|null}):Promise<CollabPrincipal>;
getCollabPrincipal(id:string):Promise<CollabPrincipal|null>;
authenticateCollabPassword(input:{email:string;password:string;rateLimitKey:string}):Promise<CollabPrincipal|null>;
acceptCollabInvitation(input:{token:string;displayName:string;password?:string;
  rateLimitKey:string;actor?:CollabActor}):Promise<{principal:CollabPrincipal;workspaceId:string;projectId:string|null}>;
getCollabBootstrapEligibility(actor:CollabActor):Promise<{eligible:boolean;legacyOrgIds:string[]}>;
bootstrapCollaborationWorkspace(input:{actor:CollabActor;legacyOrgId:string;name:string;
  idempotencyKey:string}):Promise<{id:string;name:string}>;
signCollaborationActor(actor:CollabActor,secret:string,nowSeconds?:number):string;
verifyCollaborationActor(assertion:string,secret:string,nowSeconds?:number):CollabActor;
```

`ensureGithubPrincipal` loads the legacy user by ID and uses that unique link, never email, as identity. B calls it only after successful GitHub OAuth/upsert. `rateLimitKey` comes from a hash of server-observed connection/client address with trusted proxy configuration, not a caller-chosen JSON value. Invitation acceptance with no actor requires password for a new principal; an existing principal must authenticate before accepting and cannot have its password replaced by the invitation path. Invalid credentials return null; throttling throws a typed 429 error. Disabled/version-mismatched principals fail authentication.

Credentials `authorize()` calls `authenticateCollabPassword` directly. There is no public `/auth/password` HTTP endpoint. The only unauthenticated collaboration mutation is invitation redemption (secret-token bound, rate-limited, no actor assertion returned); NextAuth owns credential/CSRF handling. B's signed NextAuth JWT carries `principalId` and `sessionVersion`. Exact custom session fields: `session.user = {id:number|null,principalId:string,sessionVersion:number,login:string,email:string|null,image:string|null,isSuperadmin:boolean,orgs:UserOrg[]}`. For non-GitHub users, id=null, login=principal displayName, orgs=[], isSuperadmin=false. Reload principal on session resolution; reject disabled or version-mismatched JWTs, never silently refresh their version.

Header `X-Fluent-Flow-Actor` contains `v1.<payloadBase64url>.<signatureBase64url>`, with payload UTF-8 JSON `{iss:'fluent-flow-dashboard',aud:'fluent-flow-collab',sub:principalId,sessionVersion,iat,exp:iat+60}`. Signature is HMAC-SHA256 over ASCII `v1.<payloadBase64url>` with server-only `FF_COLLAB_AUTH_SECRET`; compare decoded fixed-length signatures in constant time. Verify version/schema/issuer/audience, maximum 60-second lifetime and 5-second clock skew before returning actor, then DB-check identity/sessionVersion. Reject duplicate headers, missing/invalid secret and malformed assertions. B strips any browser actor header before signing. No assertion/secret/password/token enters logs or a response. Bootstrap eligibility is loaded from current legacy DB roles, never encoded as an asserted browser privilege.

First existing GitHub org admin clicks Create client workspace. `bootstrapCollaborationWorkspace` queries current `user_orgs`/superadmin state from `principal.legacyUserId`, checks admin for the selected org, and atomically creates the workspace plus manager membership. It needs no prior collaboration membership and does not trust session-supplied admin booleans. A supplies an explicit non-production fixture/bootstrap CLI for an isolated database: two clients, at least three projects, collaborator/reviewer/operator principals, an internal GitHub admin fixture and one offline host. Random fixture passwords/tokens go only to a mode-0600 local file, never committed or logged.

`Workspace = {id,name}` is a client boundary, not a Paseo workspace. `Project = {id,workspaceId,name,version,boardVersion,executionDefaults:ExecutionDefaults|null}`. Membership is explicit at workspace and/or project level. Workspace roles may inherit into its projects; project-only membership must not enumerate sibling projects or other workspace members. Cross-workspace IDs always fail 404. A default internal admin bootstrap may link existing org administrators to a newly created workspace only through an explicit, idempotent admin action; do not auto-enroll all org members.

Capabilities: `task.read`, `task.write`, `comment.write`, `internal.read`, `run.start`, `run.steer`, `run.cancel`, `delivery.accept`, `project.admin`, `membership.admin`. Presets:

| Role | Grants |
| --- | --- |
| viewer | task.read |
| collaborator | task.read, task.write, comment.write |
| reviewer | collaborator plus delivery.accept |
| operator | collaborator plus internal.read, run.start, run.steer, run.cancel |
| manager | operator plus delivery.accept, project.admin, membership.admin |

Workspace admins can create custom roles as explicit subsets of these capabilities, with no grants outside their own delegable scope. At least one workspace membership administrator must remain. Host enrollment/mapping requires an existing internal admin plus project.admin; external collaboration roles alone cannot authorize a filesystem root. Return effective capabilities per project for UI display, but recheck server-side. Permission revocation affects open streams, queued commands and launch eligibility.

`visibility:'client'|'internal'` is mandatory on comments, artifacts, summaries, checks and delivery notes. Sessions, raw timelines, approvals, prompts, local mapping details and provider errors are always internal. Client-safe board execution badges are separate from raw payloads. Default agent outputs are internal; only authorized human publication makes them client-visible. Never derive client notifications from an internal transcript. A client-visible task description is untrusted prompt content, never routing/configuration.

## Persisted resources

A creates only new tables and indexes. Foreign keys from new tables may reference existing IDs; no constraints added to live tables. Minimum logical resources (one table per resource unless owned transactionally as a bounded JSON field):

- principals, external identities, password credentials, invitations, roles, workspace/project memberships, scoped API tokens;
- workspaces, projects, execution hosts, project-host repository mappings;
- tasks, comments, task events and per-principal read cursors;
- runs, sessions, connector commands, connector observations, idempotency records;
- acceptance criteria, workpad checks/check evidence, artifacts, ideas, summaries, usage samples, delivery decisions;
- legacy import manifests/mappings and task-to-existing-claim/PR links.

Every child row carries project/task ownership directly or through an enforced foreign-key chain. Cross-resource references must be in the same project/task. Service-layer reads are actor-scoped before search, pagination, counts, joins or event serialization. Never fetch globally then filter in UI.

```ts
type TaskStatus = 'backlog'|'ready'|'in_progress'|'review'|'done'|'cancelled';
type ExecutionStage = 'design'|'development'|'test'|'in_review';
type RunState = 'queued'|'launching'|'running'|'needs_input'|'idle'|'failed'|'cancel_requested'|'cancelled'|'reconciling';
type HostReachability = 'online'|'stale'|'offline';
type Task = {id:string;projectId:string;title:string;description:string;
  status:TaskStatus;priority:'low'|'normal'|'high'|'urgent';assigneeId:string|null;
  version:number;position:string;blockedReason:string|null;createdAt:string;updatedAt:string};
type ExecutionDefaults = {mappingId:string;profileId:string;model:string|null;
  instructions:string;summary:{enabled:boolean;profileId:string|null;model:string|null}};
type Run = {id:string;taskId:string;hostId:string;mappingId:string;profileId:string;
  model:string|null;state:RunState;stage:ExecutionStage;version:number;createdAt:string;
  workspaceId:string|null;lastObservedAt:string|null;headCommit:string|null;
  retryOfRunId:string|null;errorCode:string|null};
type Session = {id:string;runId:string;paseoAgentId:string|null;providerSessionId:string|null;
  title:string;role:'work'|'summary';state:RunState;lastObservedAt:string|null;
  timelineEpoch:string|null;timelineSeq:string|null;capabilities:Record<string,boolean>};
```

API task detail adds `{capabilities,criteria,execution:{latestRun,hostReachability,progress,attentionCount},...}`; expensive collections are paginated subresources. `position` is an opaque server-generated decimal/string rank. Task changes use `expectedVersion`; board moves also use `expectedBoardVersion` with `{status,beforeTaskId:null|string,afterTaskId:null|string}`. Lock project board row, validate neighbors belong to target lane, change rank/status and increment versions in one transaction; compact ranks transactionally when necessary. Stale writers get 409, never a silent overwrite. Done/Cancelled are decision endpoints, not unrestricted PATCH values.

Business status and execution state are independent: a completed turn is `idle`, never Done. Start queues a run while preserving task status; confirmed first execution advances backlog/ready to in_progress. An explicit delivery submission moves in_progress to review. Only a human with delivery.accept can accept to Done or cancel task. Agent-triggered failure/idle/PR merge cannot close a task. Starting follow-up on done/cancelled requires explicit human reopen. Card moves to Ready never create a run.

## HTTP resource contract

Base `/api/collab/v1`. JSON success `{data:T}`; lists `{data:T[],nextCursor:string|null}`; `limit` default 50/max 100, stable opaque cursor. Mutation POST create = 201; queued command = 202; PATCH = 200; revoke = 204. Errors `{error:{code,message,requestId}}`, no raw DB/provider messages. 400 malformed, 401 unauthenticated, 403 known accessible object but insufficient capability, 404 inaccessible/missing object, 409 version/state/idempotency conflict, 422 invalid domain input, 429 rate limit, 503 unavailable configuration. Authorized version conflicts may include `currentVersion`, never another client's record.

| Method and path | Request or query | Response data / requirement |
| --- | --- | --- |
| GET /me | none | principal, authorized workspace/project summaries, capabilities |
| GET/POST /workspaces | POST `{name}` | workspace list/new workspace; internal bootstrap permission |
| GET/POST /workspaces/:id/projects | POST `{name}` | authorized projects/new project |
| PATCH /projects/:id | `{expectedVersion,name?,executionDefaults?}` | project; project.admin |
| GET/POST /:scope/:id/members | scope workspaces/projects; POST `{principalId,roleId}` | scoped membership list/member; membership.admin |
| PATCH/DELETE /:scope/:id/members/:principalId | PATCH `{roleId,expectedVersion}` | membership/revoked; last-admin guard |
| GET/POST /workspaces/:id/roles | POST `{name,capabilities}` | roles/role; membership.admin |
| POST /:scope/:id/invitations | `{email,roleId,expiresInHours}` (max 168) | invitation ID and one-time URL, secret only in this authorized response |
| POST /invitations/accept | `{token,displayName,password}` or authenticated acceptance | principal/membership; atomic consume, never replay |
| GET /tasks | workspaceId/projectId/status/assigneeId/q/cursor/limit | authorized cards across all allowed projects |
| POST /projects/:id/tasks | `{title,description?,priority?,assigneeId?}` | task; no repo/host/run prerequisite |
| GET/PATCH /tasks/:id | PATCH `{expectedVersion,title?,description?,priority?,assigneeId?,blockedReason?}` | task/detail; task.read/write |
| POST /tasks/:id/moves | `{expectedVersion,expectedBoardVersion,status,beforeTaskId,afterTaskId}` | task plus boardVersion; task.write |
| GET/POST /tasks/:id/comments | POST `{body,visibility}` | comments/comment; comment.write, internal.read for internal |
| GET /tasks/:id/runs | cursor/limit | safe run metadata or full internal run by capability |
| POST /tasks/:id/runs | `{expectedVersion,mappingId?,profileId?,model?,instructions?,retryOfRunId?}` + Idempotency-Key | run; run.start; server resolves allowed defaults and snapshots prompt/config |
| GET /runs/:id | none | run with sessions; safe projection without internal.read |
| POST /runs/:id/sessions | `{title,profileId?,model?,instructions}` + Idempotency-Key | command to create another work session; run.start |
| GET /sessions/:id/timeline | cursor/limit | normalized persisted timeline; internal.read |
| POST /sessions/:id/commands | discriminated command below + Idempotency-Key | command; run.steer/cancel; internal.read |
| GET /commands/:id | none | command state/result; originating authorized actor or operator |
| GET /attention | filters/cursor/limit | permission-filtered questions, approvals, errors, unread updates |
| POST /tasks/:id/read-cursor | `{eventId}` | saved user cursor; cannot clear unresolved approvals/errors |
| GET /events | cursor/projectId/taskId, SSE Accept optional | scoped events with resumable cursor; no-cache, current permissions checked repeatedly |
| GET/POST/PATCH /tasks/:id/criteria[/:criterionId] | create `{text}`; update `{expectedVersion,text?,state:'open'|'met'|'waived',reason?}` | criterion; preserve actor/version history |
| GET/POST/PATCH /tasks/:id/checks[/:checkId] | name, command, visibility; evidence fields below | named checks and evidence history |
| GET/POST /tasks/:id/artifacts | metadata below | references with safe previews; no arbitrary file route |
| GET /artifacts/:id/content | none | authorized, bounded safe content or queued retrieval state |
| GET/POST /tasks/:id/ideas | POST `{title,body,sourceSessionId?,visibility}` | ideas/idea |
| POST /ideas/:id/conversions | `{kind:'task'|'follow_up',expectedVersion,title?,sessionId?}` + Idempotency-Key | new task OR command; follow_up additionally requires run.steer |
| GET /runs/:id/summaries | cursor/limit | versioned summaries with source cursor/model and visibility |
| POST /runs/:id/summaries | Idempotency-Key | explicit summary command; fails if disabled/unconfigured |
| GET /projects/:id/insights | time range, bounded | authorized aggregates, usage nulls/coverage, never invented costs |
| POST /tasks/:id/deliveries | `{expectedVersion,note,artifactIds,checkEvidenceIds}` | delivery snapshot and Review state; internal operator; no merge side effect |
| POST /tasks/:id/decisions | `{expectedVersion,decision:'accept'|'cancel'|'reopen',note,acknowledgedOpenItemIds:[]}` | decision and task; human delivery.accept |
| POST /runs/:id/wrap-up-preflights | none | queued read-only preflight command |
| POST /runs/:id/wrap-ups | `{preflightId,mode:'archive_sessions'|'archive_owned_workspace'}` + Idempotency-Key | command; fresh preflight, no force-delete |
| GET/POST /hosts | POST `{name}` | authorized hosts/enrollment token; internal admin |
| POST /hosts/:id/revoke | none | revoke credential; reject future polls/commands |
| GET/POST /projects/:id/mappings | POST `{hostId,repositoryKey,profileIds,defaultProfileId}` | mapping; internal admin plus project.admin |
| GET /hosts/:id/catalog | none | allowlisted profiles/providers/models and capabilities; no secrets/local config |

POST runs is idempotent for `(principalId,taskId,idempotencyKey)` with canonical request hash; same key/different body returns 409. Keep launch keys as long as run history exists. One unresolved active run per task by default; multiple sessions inside it are supported. Retry creates a new run with retryOfRunId only once previous execution is known terminal; unknown old execution cannot be retried into duplicate work. Server authorizes profile/model/mapping against current project and host catalog, then freezes the chosen values on run creation.

## Workpad, artifacts and ideas

`Check = {id,taskId,name,command,visibility,version}`. Append-only `CheckEvidence = {id,checkId,runId,sessionId,commit,status:'passed'|'failed'|'not_run',exitCode:number|null,observedAt,outputArtifactId:null|string,provenance:'human'|'agent'|'runner',actorId}`. `stale` is derived when evidence commit differs from current deliverable head, is unknown, or criteria/check definition changed since capture. Agent claims are visibly agent-reported; runner-observed command exit is distinguished. Summaries never set check status. Delivery snapshot lists failed/not-run/stale/open items; acceptance requires explicit acknowledgment of their IDs at that version. Existing required merge controls remain independently enforced.

`Artifact = {id,taskId,runId:null|string,sessionId:null|string,direction:'input'|'output',kind:'file'|'url'|'text',name,visibility,provenance:'human'|'agent'|'runner',ownerId,version,mediaType,sizeBytes,sha256,reference}`. Host file references are mapping/workspace-relative opaque IDs, never client-provided absolute paths. Resolve realpath within mapped workspace, deny traversal/symlink escape and credential/config files; no execution of preview HTML/SVG. Use text, image/PDF allowlist, bounded bytes, attachment fallback and `nosniff`; no server-side arbitrary URL fetching. Agent cannot overwrite/delete human-owned material or broaden visibility. Human promotion creates an audited revision. Preview unavailable/offline is explicit, never an empty success.

Ideas retain `sourceTaskId`, optional run/session, author/provenance, status `inbox|converted|dismissed`, conversion target and visibility. Atomic conversion is idempotent. Conversion to task creates backlog only; continuing a session is a separate authorized, confirmed command. Source history remains inspectable.

## Connector protocol and duplicate prevention

Host credential is bound to the route host; no hostId body override. Local configuration maps `repositoryKey` to an existing canonical checkout path and allowed profiles. Only C resolves absolute paths. Client task text cannot select cwd, command executable, credential or daemon URL. Agent profile discovery uses configured Paseo profile values/notes, including OMP and user's gateway; do not hard-code Claude or model defaults.

- `POST /api/connector/v1/register` -> `{hostId,connectorSessionId,leaseEpoch,heartbeatIntervalMs:15000,staleAfterMs:45000,offlineAfterMs:120000}`. Body `{instanceId,protocolVersion:1,sdkVersion,daemonVersion,capabilities,catalog:{repositories:[{key}],profiles:[{id,name,provider,model,modeId,thinkingOptionId,features}]}}`. Reject concurrently active connector instance for the same host; recovery increments fencing epoch.
- `POST /heartbeat` body `{connectorSessionId,leaseEpoch,activeRunIds,observedAt}` -> current lease/status. Server time decides reachability. Stale/offline does not mean failed or cancelled.
- `POST /poll` body `{connectorSessionId,leaseEpoch,waitMs:25000,limit:1}` -> `{commands:Command[]}`. Atomic claim only for that host, current mapping and still-authorized actor. Short leases allow re-delivery of the SAME command ID, never new run creation.
- `POST /commands/:id/ack` body `{connectorSessionId,leaseEpoch,state:'accepted'|'applied'|'failed'|'ambiguous',result?,errorCode?}`. Stale fences rejected; accepted is not applied. Terminal result/replay is idempotent.
- `POST /observations` body `{connectorSessionId,leaseEpoch,events:Observation[]}` -> `{acceptedEventIds,highWatermarks}`. Unique eventId plus provider epoch/sequence prevents replay duplication. Batch cap 100 events/1 MiB. Server checks bound run/session/host on every event. Persist observations and projection in one transaction.

```ts
type Command = {id:string;runId:string;sessionId:string|null;kind:
 'launch'|'create_session'|'prompt'|'permission'|'cancel'|'summarize'|'artifact_read'|'wrapup_preflight'|'wrapup';
 payload:object;createdAt:string;leaseEpoch:number};
type Observation = {eventId:string;runId:string;sessionId:string|null;
 observedAt:string;kind:'workspace_bound'|'session_bound'|'state'|'timeline'|'attention'|
 'usage'|'check'|'artifact'|'idea'|'summary'|'wrapup';payload:object;
 providerCursor?:{epoch:string;seq:string}};
```

Launch payload `{repositoryKey,profileId,profileSnapshot,model,instructions,prompt,workspace:{mode:'worktree',branchName,baseRef},labels:{'fluent-flow.run':runId,'fluent-flow.session':sessionId}}`; server generates branch name from IDs, configured baseRef comes from mapping. Public SDK 0.12.0 agent creation supports `labels`; workspace creation has no top-level labels option. Carry task/run/session metadata on agents and in the journal, while recovering with explicit stable workspace/agent IDs and supported idempotency keys. Metadata alone never authorizes cleanup. The full session-bound `reportingCredential` is attached only to authorized launch/additional-session delivery, never stored in command payloads or exposed through ordinary reads; a prefix alone cannot authenticate. `session_bound` carries `{paseoAgentId,providerSessionId,workspaceId}` and partial bindings merge without clearing existing IDs. Browser command payloads:

- prompt: `{kind:'prompt',text,behavior:'steer'|'interrupt'}`;
- permission: `{kind:'permission',requestId,response:{behavior:'allow'|'deny',selectedActionId?,answers?}}`; C converts only valid current provider requests to supported SDK response schema, rejects expired/wrong-session requests and unsupported answer shapes;
- cancel: `{kind:'cancel'}`; abort current turn, do not archive resources or mark task Cancelled.

Pinned SDK contract: `@getpaseo/client@0.12.0` public declarations expose workspace `idempotencyKey`, agent `idempotencyKey`/`agentId`/`clientMessageId`, and `send(text,{messageId,activeTurnBehavior})`. Use `ff:workspace:<runId>`, `ff:session:<sessionId>` and command ID as stable keys; preserve them through retries. Still test the installed daemon's replay behavior before assuming exactly-once prompts. The public high-level agent handle has no cancel method; use supported local CLI `paseo stop <full-agent-id>` via `execFile` with explicit local daemon selection, then reconcile observed state. Do not import the SDK's internal driver merely to cancel. Configured profiles are exposed via `client.config.get()`; extract only profile name/provider/model/mode/thinking/features on PC, never persist or log the whole config or send provider env/keys to the control plane.

A stores all commands durably before delivery. C writes a mode-0600, fsync/atomic local journal before SDK side effects, keyed by command/run/session. Create workspace and **idle** agent first with stable IDs and supported idempotency keys; persist/ack their IDs before sending the initial prompt. The server response must explicitly confirm `state:'accepted'` under the captured fence; HTTP 200 alone does not authorize delivery. The timeline subscription and initial backfill must also be ready before the first prompt. Recover by recorded IDs, including archived/background resources; a familiar name alone does not prove ownership. There is no assumed SDK exactly-once create/send guarantee: a crash or timeout after send but before acknowledgment sets `ambiguous`/`reconciling`, never blindly repeats. Reconcile timeline/history; if absence cannot prove non-execution, keep Needs attention and require explicit operator reconciliation. No automatic expiry/relaunch of an existing active run. Stable command IDs and unique active-session binding prevent repeated clicks/reconnects creating duplicate work.

Paseo `idle` snapshots are not terminal turn evidence. Use timeline `turn_completed`, `turn_failed`, `turn_canceled`; wait timeout does not cancel. On subscription restore refetch missed history with saved epoch/seq; reconcile buffered live events; epoch replacement invalidates cursor, preserves old history and marks the gap until refetched. Unavailable/unsupported provider usage is null with a reason. Token/cost totals dedupe by session/turn/sample identity; never add repeated cumulative snapshots.

Wrap-up preflight includes dirty/untracked files, unpushed commits, active sessions, shared/foreign workspace references and ownership. Preserve code by default. Never archive a local/imported/shared workspace, delete dirty worktrees, discard branches or call force. Stop only owned terminal sessions after confirmation. A stale/offline preflight cannot authorize cleanup; recheck immediately before archival.

## Required integration regressions

1. Invited user with no GitHub org cannot query legacy unscoped agents/pipelines.
2. Two clients cannot access each other's tasks/comments/search/counts/artifacts/events/MCP, including guessed IDs and revoked open streams.
3. Ready move creates zero commands; same Start idempotency key creates one run; different payload conflicts.
4. Lost create/prompt acknowledgment followed by reconnect produces one agent/one prompt or an explicit reconciliation hold, never a retry launch.
5. Turn completed leaves task in_progress/review, never Done; cancel intent remains pending until observed.
6. Stale check/failed check/open criterion must be acknowledged at current version; no automatic merge or bypass of existing controls.
7. Concurrent move/edit loses no accepted write; stale version returns 409.
8. Workpad/artifacts/ideas/summaries/usage preserve multi-session task provenance and internal/client visibility.
