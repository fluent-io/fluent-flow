# Engine

The deterministic orchestration core. LLM agents never decide what step comes next — this code does.

## Auth Context

All GitHub API calls require an **installation context** (`ctx`) with `installation_id`. This is resolved via `installationCtxForRepo(owner, repo)` from the config loader. Every engine function that makes GitHub API calls resolves this context at the top of the function and passes it through. There is no PAT fallback — if `installationCtxForRepo` returns `undefined`, the operation is skipped or throws.

## Modules

### state-machine.js

Config-driven state transitions with requirement validation.

**Pure functions (no I/O):**
- `buildTransitionMap(transitions)` — parses YAML transition config into `Map<from, Map<to, requirements>>`
- `checkTransitionAllowed(map, from, to)` — validates transition, handles wildcard `* → Cancelled`
- `validateRequirements(requirements, context)` — checks context has required fields (assignee, linked_pr, etc.)

**Async functions (DB + GitHub):**
- `executeTransition({ owner, repo, issueNumber, toState, ... })` — the core function: validate → record in DB → update GitHub Projects
- `getCurrentState(repo, issueNumber)` — latest state from DB, defaults to `Backlog`
- `autoTransition(owner, repo, issueNumber, event)` — find and execute transitions marked `auto: true` on matching event
- `attemptTransitionToDone(...)` — guard for Done: reverts with comment if no merged PR

**Key rules:**
- `Done` is terminal — no outbound transitions
- `Done` always requires `merged_pr` regardless of config
- Project card updates are non-blocking (`Promise.allSettled`)
- Transition trigger types: `webhook`, `api`, `auto`, `pause`, `resume`, `mcp`

### review-manager.js

Automated code review dispatch and retry tracking.

- `dispatchReview({ owner, repo, prNumber, ref, attempt, priorIssues, issueNumber })` — dismisses stale Fluent Flow reviews, then creates a `claim_type: 'review'` claim via `claim-manager.createClaim` (always as `pending`, no session pre-assignment). Stores `head_sha` on the claim for check-run creation on re-dispatch. An online runner claims it via `claimPendingWork()` (long-poll) and invokes the configured harness (`claude-code` / `aider` / …) with a prompt that tells it to post a PR review comment terminated by `<!-- reviewer-result: {…} -->`. Skips dispatch if the issue is paused. Called by the check-run handler after CI passes (not on PR open). No GitHub Actions workflow is triggered — review runs on the user's runner. Returns `{ claimed: boolean, claimId?: number, reason?: string }`.
- `handleReviewResult({ ..., result, agentId })` — PASS: enable auto-merge, complete active claim. FAIL: increment retry, create `verify:red` when verification is enabled, otherwise create `review_fix`. Max retries escalate to human review (`needs-human` label, pause record, retry reset). Claims are created before notification so the long-poll push can hint the runner, but runners always fall through to `claimPendingWork()` if the push was lost.
- `getRetryRecord(repo, prNumber)` — query `review_retries` table
- `resetRetries(repo, prNumber)` — zero out counter and clear issues. Called after escalation and unconditionally on PR close to prevent stale retry records.

**Review result flow:** runner posts a review with `<!-- reviewer-result: {...} -->` → webhook or runner fallback parses the verdict → `handleReviewResult` → verify/red-fix-green chain or auto-merge.

### pause-manager.js

Human-in-the-loop pause/resume with agent notification.

**Pure function:**
- `parseResumeCommand(body)` — parses `/resume`, `/resume to:review`, `/resume to:progress` from comment text

**Async functions:**
- `recordPause({ ..., agentId })` — insert pause record → transition to Awaiting Human → add `needs-human` label → post checklist comment → notify agent
- `processResume({ ..., agentId })` — update pause record → transition to target state → remove label → post comment → wake agent
- `getActivePause(repo, issueNumber)` — find unresolved pause (`resumed_at IS NULL`)

**Pause reasons:** decision, ui-review, external-action, agent-stuck, review-escalation, manual
