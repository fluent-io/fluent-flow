# Native probe evidence

[Native probes](../README.md) · [Harness](../harness/README.md) · [Claude Code 2.1.317](claude-code-2.1.317/README.md) · [Codex 0.162.1](codex-0.162.1/README.md)

Sanitized per-probe JSON from the last `npm run test:native` run on 2026-11-04 (after the C7 ruling). `<probe-root>` is the probe's mkdtemp root and `<real-home>` the host home; neither real path is stored. Credentials are dummies (`sk-…-ff-probe-dummy…`, `ff-probe-dummy-mcp-token`), and bearer values are written as `Bearer <dummy>`. Tasks 5 and 6 build on these files.

## Environment

- Host: Linux 7.0.0-42-generic, util-linux 2.39.3, Node 22.23.3, vitest 4.1.4.
- Namespace: `unshare --user --map-user=1000 --map-group=1000 --keep-caps --net --mount`. The caller-UID mapping worked, so the root fallback was not used. `uid_map` was `1000 1000 1`. Namespace capabilities are dropped with `setpriv --inh-caps=-all --ambient-caps=-all` before the test command runs.
- A fresh sysfs mount is required: without `--mount` plus `mount -t sysfs`, `/sys/class/net` in a new network namespace still lists the host's interfaces. The brief's launcher text names only `--user --map-root-user --net`; the added private mount namespace, namespace-local sysfs remount and capability drop are an accepted implementation of it (controller ruling). Mount propagation is private to the namespace, so no host mount changes.
- UID note: the natives ran as the caller's UID inside a user namespace. This is a test-environment detail. It proves nothing about ordinary-UID subscription execution, which needs separate authorized UAT.

## Result

23 of 25 probes pass. X4b and X7 fail because the native tool behaves differently. These are not harness bugs. No capability was dropped to make them pass, and both stay as explicit failures for later correction.

### C7 — resolved by controller ruling (PASS)

The first run used the design argv (`--setting-sources user`, `--strict-mcp-config`). The planted hook did not run and the planted `.mcp.json` server was absent, but the `CLAUDE.md` marker was in no model request. Exploration on the same binary showed:

| Variant | CLAUDE.md in request | Planted hook ran |
| --- | --- | --- |
| design argv (`--setting-sources user`) | no | no |
| same, without `client_composed` | no | no |
| `--setting-sources user,project` | yes | **yes** |
| `--add-dir <repo>` | no | no |
| `--add-dir <repo>` plus env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | yes | no |

Per the controller ruling, `buildNativeEnv` now emits `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` for Claude, and `claudeArgs` takes `workspaceDir` and passes exactly that directory as the one `--add-dir`. `--setting-sources user` and strict MCP are unchanged. C7 now passes: the marker is in the model request, the hook marker file is absent, the planted `.mcp.json` server is not in `mcp_servers`, and the planted MCP endpoint recorder saw no request. `system/init` reports `additional_directories: []` with this argv, presumably because the added directory equals the cwd; the instructions load anyway.

### X4b — untrusted project MCP server is started (FAIL, acceptance for later correction)

The planted `.codex/config.toml` defines `ff_planted_codex_toml` pointing at a loopback recorder. On 0.162.1 the app-server warns that project-local config is disabled for the untrusted repo, yet `mcpServer/startupStatus/updated` reports the planted server `starting` then `failed`, and the recorder got `POST /ff_planted_codex_toml`. The planted `model` is not used. Config isolation for Codex is therefore **not** proven. No pinned argv or override found so far neutralizes this without knowing the project's server names in advance (see the task report).

### X7 — `requestUserInput` shape (FAIL, held pending the Planner's source resolution)

On 0.162.1, the model-facing `request_user_input` tool is offered only in Plan mode (`turn/start` `collaborationMode: { mode: 'plan', … }`), or with the under-development feature `default_mode_request_user_input`. Its parameter schema requires `options` and has no `isSecret`. The server request arrives as `{ questions: [{ id, header, question, isOther: true, isSecret: false, options: [...] }], isBlocking: true, autoResolutionMs: null }`. A model call that sets `isSecret: true` with no options is rejected before any server request. So `isSecret: true` with `options: null` cannot be reached through this tool. The answer `{ answers: { <id>: { answers: [<value>] } } }` does reach the next model request (that part passes).

## Task 1b (stopped under Step 8 at X14c)

### Stop record — X14c, `turn/interrupt` does not close a held `ff_questions.ask` call (FAIL)

Observed on Codex 0.162.1: while FF holds an `ask` call open (SSE heartbeats, no result yet), `turn/interrupt { threadId, turnId }` returns `{}` and `turn/completed` reports `status: "interrupted"` within about 100 ms. Codex does **not** close the `tools/call` HTTP request and sends no `notifications/cancelled`. A scratch observation through a logging pass-through proxy saw nothing for 20 s, and the probe saw the request still pending 10 s after the interrupt (`X14c.json`: `withdrawnWithin10s: false`, `stillPendingAfterInterrupt: 1`). The request was settled only by FF's own shutdown at the end of the probe. Killing the worker (SIGKILL) does close the request at once, and FF records `native_aborted`. The probe sends no late answer while the request is still pending, so nothing is written into an abandoned call. The assertion is unchanged and fails: `X14c question_withdrawn after turn/interrupt: expected false to be true`.

Not performed after the stop: X14d (360 s hold), every Step 5 wrong-variant RED run, the X4b and X7 rewrites, and the final full native run.

### Passing Task 1b probes (focused runs)

- X4c: launched with cwd = worktree realpath. `config/read { cwd, includeLayers: true }` reports layers `sessionFlags`, `project` (disabled, with a reason naming the main repo as the project to trust), `user` and `system`. The planted root `config.toml` produced no layer. The gate passes with `disabledProjectLayersInert: true`, and `thread/start` without `cwd` returns `thread.cwd` equal to the worktree realpath. The turn completes with the `AGENTS.md` marker in the model request; there are no planted startup statuses or recorder hits, and the context `config.toml` is unchanged (absent).
- X4d: with the repo and worktree trusted in the context `config.toml`, the project layer is enabled. 0.162.1 omits `disabledReason` on an enabled layer rather than sending `null`. The gate refuses with `project_layer_enabled`, and no `thread/start`, startup status or recorder hit occurs.
- X4e: a new worker repeats the gate and sends `thread/resume { threadId }` without `cwd`. `thread.cwd` equals the worktree realpath, with 0 model and 0 server requests in 5 s, no planted statuses or hits, and the context `config.toml` unchanged.
- X6b: a command approval answered `cancel` leaves no file and the turn ends `interrupted`. `availableDecisions` is again `accept`, `acceptWithExecpolicyAmendment`, `cancel`.
- X11b: `ff_reporting` under `untrusted` asks (one `mcp_tool_call` approval, then the call). Under `never` it is refused (no approval, no call), and the turn completes.
- X11c: under `on-request`, `decline` gives no call and the turn completes. `cancel` also gives no call, and the turn **completes** (`mcpApprovalCancelInterrupts: false`).
- X14: under `on-request`, one `mcp_tool_call` approval (form mode, `persist: ["session","always"]`, empty requested schema) arrives first and is accepted once. FF then receives exactly one request. Its `correlation.threadId` is the thread id, and `callId` (not `itemId`) equals the `mcpToolCall` item id. The local answer dispatches, the next model request carries it as `function_call_output`, the item completes, and no record or log contains the answer.
- X14b: `ff_questions.ask` asks under `untrusted` and is refused under `never`.
- C12 (rewritten): the `C12-dup` expected count is 0, pinned from `existingSessionId: 'refused'`. The duplicate spawn exits 1, the C2 transcript's SHA-256 and line count are unchanged, and exactly one transcript exists.
- C13: `system/init` reports `manual` as `default`; every other mode is reported under its own name. Outcomes (reporting / AskUserQuestion): acceptEdits asks/asks, auto refused/asks, bypassPermissions runs/asks, manual asks/asks, dontAsk refused/refused, plan asks/asks. **auto caveat:** auto mode's reporting refusal came from its classifier. It sent 10 side requests to the synthetic model, got the fixture's generic reply, and blocked the call as "could not evaluate". So auto's outcome depends on the real model and is not proven by this fixture.

## Task 1b round 2 (after the root X14c ruling)

- X14c (rewritten, PASS in a focused run): FF's terminal bridge calls `withdrawTurn({ threadId, turnId, generation })` on `turn/completed` with status `interrupted`. Before cleanup, `X14c.json` shows `_meta['x-codex-turn-metadata'].turn_id` equal to the interrupted turn id (exact, not guessed), withdrawal reason `turn_interrupted`, no request still pending, a late local answer refused with `request_unavailable`, no answer barrier and no answer in any record. Post-cleanup records are labelled separately. The original native mismatch (no socket close after `turn/interrupt`) is preserved as `X14c-native-mismatch.json`.
- X14d (PASS): one `ask` call held 360 s with 15 s comment heartbeats; Codex kept it open, the local answer then dispatched and reached the next model request, and the turn completed.
- C13 (PASS): production `policyOutcomes` uses the extended enum. Claude `auto` reporting is `unproven`, while `rawObservedOutcomes.auto.reporting` stays `refused` (classifier "could not evaluate", 10 side requests to the synthetic model).
- X4b (rewritten as trap record, PASS): launched from the worktree with `cwd` in `thread/start`, the context `config.toml` goes from absent to `[projects."<probe-root>/repo"] trust_level = "trusted"`, and the planted `.codex/config.toml` server is started and contacted. The planted model is not used.
- X7 (rewritten as limit record): the first version failed (history kept here). The brief's original text expected Default mode to offer no `request_user_input`. On 0.162.1 the Default-mode model request's tools **include** `request_user_input`, whose description says it is only available in Plan mode. Task 1's evidence shows that calling it in Default mode is rejected without a server request. The other two clauses hold: in Plan mode a call with options arrives with `isSecret: false, isOther: true`, and a call without options produces no `item/tool/requestUserInput`; the model gets `request_user_input requires non-empty options for every question`.
- X7 (corrected per root ruling, PASS): Default mode advertises `request_user_input` with the description "…This tool is only available in Plan mode." A valid Default-mode call with options gets exactly the native tool output `request_user_input is unavailable in Default mode` and no `item/tool/requestUserInput`. The two Plan-mode clauses are unchanged. This remains an isolated diagnostic; Plan mode is never production evidence.

Final full `npm run test:native` (2026-11-04): 2 files, 36 of 36 probes pass, and every evidence file was regenerated from that run.

## Recorded behavior used by later tasks

- C2: `initialize` returns `{ commands, … }`. `system/init` carries `session_id`, `apiKeySource: "ANTHROPIC_API_KEY"` and `mcp_servers: [{ name: "ff_reporting", status: "connected", source: "dynamic" }]`. The probe compares `{ name, status }`; `source` is an extra field.
- C3: `/login --resume x @README.md` is replayed with the same uuid (`isReplay: true`). It reaches exactly one model request verbatim, with no `@` expansion.
- C4: `can_use_tool` arrives without `--permission-prompts host`. Deny yields `tool_result.is_error: true`.
- Transport: with `--replay-user-messages`, 2.1.317 echoes the host's own `control_response` on stdout. `claude-control.js` ignores echoes for ids it answered.
- C5: `AskUserQuestion` arrives through the same `can_use_tool` callback with `requires_user_interaction`. Duplicate headers and a comma in a label are accepted. The answer goes back as `{ behavior: 'allow', updatedInput: { questions, answers: { <question text>: <label> } } }`. The native input schema is in `C5.json`.
- C6: MCP tools are deferred. The model calls `ToolSearch` (`select:mcp__ff_reporting__ff_probe_report`) before the tool. The MCP call carries the dummy bearer.
- C8: `interrupt { cancel_queued: true }` returns `{ still_queued: [], cancelled: [U2] }`, and the result is `error_during_execution`. The held stream is aborted.
- C9: after SIGTERM, `--resume` with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0` made 0 model requests in 5 s and exactly 1 after a new message.
- C10: `claude auth status --json` returns `{ loggedIn, authMethod: "api_key", apiProvider: "firstParty", analyticsDisabled, projectsDirectory, configDirectory, apiKeySource }` for the dummy context.
- C11: no unexpected requests, no proxy attempts. The transcript is `<contextDir>/projects/<repo path with non-alphanumerics as '-'>/<session>.jsonl`, and no such project directory exists under the real home.
- C12: `--resume <never-created uuid>` exits 1 (`No conversation found with session ID`) with no model request. `--session-id <existing uuid>` refuses and exits 1 (`Session ID … is already in use`) with no second transcript.
- X2: `--strict-config` accepts every probe override, listed in `X2.json`.
- X3: `account/read { refreshToken: false }` returns `{ account: null, requiresOpenaiAuth: false, workspaceRouting: null }`.
- X4: thread rollout is under `<contextDir>/sessions/…`. One model request carries `ff-probe-model` and the `AGENTS.md` marker; `planted-model` is not used. The planted MCP server's startup is asserted separately in X4b (failing).
- X5: `clientUserMessageId` is echoed as `userMessage.clientId`.
- X6: `availableDecisions` is `["accept", {acceptWithExecpolicyAmendment}, "cancel"]` and does not list `decline`, but a `decline` answer is honored (`status: declined`, `serverRequest/resolved`, turn completes).
- X8: `turn/steer` returns `{ turnId }`. A stale `expectedTurnId` returns `-32600`. Steered text reaches the next model request.
- X9: `turn/interrupt` returns `{}`, then `turn/completed` has `status: "interrupted"`. The held stream is aborted.
- X10: after SIGKILL with an approval pending, `thread/resume` in a new worker showed the turn as `interrupted` and made 0 model and 0 server requests in 5 s.
- X11: MCP calls go through `mcpServer/elicitation/request` (`_meta.codex_approval_kind: "mcp_tool_call"`). Answer `{ action: 'accept', content: {} }`. The fixture saw the dummy bearer from `bearer_token_env_var`.
- X12: 0.162.1 contacts `github.com:443`, `api.github.com:443` and `chatgpt.com:443` unless `features.plugins=false` is set. The probes launch with `codexLaunchControls()` (`features.plugins=false`, `features.apps=false`), and the deny proxy recorded nothing. The production adapter must merge the same controls.
- X13: `thread/list { cwd, limit }` exists and returns the X4 thread with its `cwd` and rollout path.
