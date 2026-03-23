# Engine

The deterministic orchestration core. LLM agents never decide what step comes next — this code does.

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

- `dispatchReview({ owner, repo, prNumber, ref, attempt, priorIssues })` — triggers `pr-review.yml` GitHub Actions workflow
- `handleReviewResult({ ..., result, agentId })` — PASS: enable auto-merge. FAIL: increment retry, notify agent with rich issue details and optional `on_failure` model/thinking config. FAIL at max retries: escalate (add `needs-human` label, record pause, reset counter)
- `getRetryRecord(repo, prNumber)` — query `review_retries` table
- `resetRetries(repo, prNumber)` — zero out counter after escalation

**Review result flow:** GitHub Actions posts review with `<!-- reviewer-result: {...} -->` → webhook parses → `handleReviewResult` → agent notified or PR auto-merged.

### pause-manager.js

Human-in-the-loop pause/resume with agent notification.

**Pure function:**
- `parseResumeCommand(body)` — parses `/resume`, `/resume to:review`, `/resume to:progress` from comment text

**Async functions:**
- `recordPause({ ..., agentId })` — insert pause record → transition to Awaiting Human → add `needs-human` label → post checklist comment → notify agent
- `processResume({ ..., agentId })` — update pause record → transition to target state → remove label → post comment → wake agent
- `getActivePause(repo, issueNumber)` — find unresolved pause (`resumed_at IS NULL`)

**Pause reasons:** decision, ui-review, external-action, agent-stuck, review-escalation, manual
