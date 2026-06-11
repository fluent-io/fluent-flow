# Loop Engineering Product Architecture — Fluent Flow v2

**Date:** 2026-06-10 (revised)
**Status:** Draft — awaiting review
**Authors:** Flow (Fluent Flow orchestrator)
**Based on:** Loop engineering discourse (Boris Cherny, Peter Steinberger, Addy Osmani, Geoffrey Huntley)

---

## 1. The Shift

### 1.1 What Changed

The AI coding landscape shifted from **prompt engineering** to **loop engineering** in June 2026. The key voices:

> *"I don't prompt Claude anymore. I have loops running that prompt Claude and figuring out what to do. My job is to write loops."*
> — **Boris Cherny**, Head of Claude Code, Anthropic (WorkOS Acquired Unplugged, June 2, 2026)

> *"You shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents."*
> — **Peter Steinberger**, Creator of OpenClaw, now at OpenAI (June 8, 2026)

> *"Build the loop. Stay the engineer."*
> — **Addy Osmani**, Google (Loop Engineering blog, June 2026)

### 1.2 What This Means for Fluent Flow

Fluent Flow was already building an orchestration system. The loop engineering wave formalizes and accelerates this direction. The product must evolve from:

| Old (Prompt Era) | New (Loop Era) |
|---|---|
| Human writes prompt → agent responds → human writes next prompt | Human designs loop → loop prompts agent → loop evaluates → loop decides next step |
| Linear, human-in-the-loop | Recursive, human-on-the-loop |
| One-shot agent sessions | Multi-turn, multi-agent loops running autonomously |
| Prompt templates per claim type | Loop contracts: TRIGGER → SCOPE → ACTION → BUDGET → STOP → REPORT |
| Runner as sequential claim executor | Runner remains a sequential claim executor; server loop engine decides which claim comes next |

### 1.3 Architecture Principle

**The loop orchestrator is the server. The runner is a single-purpose executor.**

In Claude Code / Codex, the CLI tool is both orchestrator and executor in a single process — it runs `/goal` internally, making multiple prompts to itself. The loop lives inside the tool.

Fluent Flow is distributed: the server and runner are separate processes. The loop belongs on the server side:
- **Server** = orchestrator (loop definitions, scheduling, dispatch, verification, budget enforcement, memory)
- **Runner** = single-purpose claim executor (poll → claim → execute in worktree → report results)

The runner stays a single-purpose agent that handles one claim type. It does not spawn sub-agents, track budgets, or manage loop state. Those are server concerns.

### 1.4 The Five Loop Primitives (Addy Osmani)

Every production loop needs these five primitives plus one memory layer:

| Primitive | Role in Fluent Flow (Server-side) |
|---|---|
| **Automations** | Scheduled discovery, triage, and dispatch (cron, hooks, GitHub Actions) |
| **Worktrees** | Server dispatches isolated claims; runners create per-claim worktrees during execution |
| **Skills** | Codify project knowledge so loops don't re-derive intent every cycle |
| **Plugins/Connectors** | Hook loops into real tools (issue trackers, CI, Slack, staging APIs) via MCP |
| **Sub-agents** | Server dispatches multiple claims (sub-agents) per tick |
| **Memory** | Persistent state (DB tables, markdown files) that survives between runs |

---

## 2. Product Vision v2

### 2.1 New Vision Statement

> Fluent Flow is a loop engineering platform. It lets developers define autonomous development loops — systems that observe, plan, act, verify, and iterate — without the developer manually prompting each step.

### 2.2 The Loop Contract

Every loop template/definition in Fluent Flow is defined by a contract:

```
TRIGGER  → What starts the loop? (cron, PR comment, CI failure, manual)
SCOPE    → What does the loop operate on? (repos, PRs, files, issue labels)
ACTION   → What does the loop do? (review, build, test, fix, merge)
BUDGET   → What are the limits? (max iterations, token cap, dollar cap, sub-agent count)
STOP     → When does the loop stop? (all tests pass, max iterations, human approval)
REPORT   → What happens on completion? (post to Slack, create issue, update Linear, notify)
```

The contract is the reusable recipe. A loop run is a concrete execution of that recipe against a specific repo/PR/issue/scope.

### 2.3 Data Model Vocabulary

Fluent Flow already has the execution substrate: `agent_claims`. Claims are the current implicit loop. The v2 adjustment is to make the template/run boundary explicit while keeping claims as the work units.

| Concept | Meaning | Current/Future Data Model |
|---|---|---|
| **Loop definition** | Reusable recipe/template: trigger, scope, actions, budget, stop conditions, report target | New `loop_definitions` table |
| **Loop instance** | One active/completed execution of a loop definition | New `loop_instances` table |
| **Claim** | One executable task inside a loop instance | Existing `agent_claims`, with optional `loop_instance_id` |

Example:

```text
loop_definition: review-fix-verify
loop_instance: PR #42 run started by check_run.completed
agent_claims: review → review_fix → test_verify → review → ...
```

This means templates require explicit loop definitions, and productized templates require loop instances. But claims remain the durable task/tick records that runners execute.

### 2.4 Loop Types

| Type | Description | Use Case |
|---|---|---|
| **Open loop** | Agent writes until it says "done" | Demos, prototyping |
| **Closed loop** | Agent writes → runs tests/lint → reads result → corrects | Production CI repair, review fixes |
| **Review loop** | Background reviewer feeds findings back while context is fresh | Long sessions, complex refactors |
| **Orchestration loop** | Supervisor loop dispatches and monitors multiple sub-agent loops | Multi-feature work, multi-repo changes |

**Fluent Flow v2 targets closed loops and orchestration loops.** Open loops are not ship-worthy.

---

## 3. Architecture Changes

### 3.1 High-Level Shift

```
BEFORE (v1 — Sequential Pipeline):

  Webhook → Claim → Runner → Agent → Report → Next Claim → Runner → Agent → Report

AFTER (v2 — Loop-Centric):

  Webhook → Loop Definition → Loop Instance → Server Loop Orchestrator
         → [Sub-agent Claim 1, Sub-agent Claim 2, ...]
         → Server Loop Memory (loop instance state + claim history)
         → Server Verification (tests, linters, reviewers that can say "no")
         → Server Report (human notification, PR creation, issue updates)
         → Runner: poll → claim → execute → report (unchanged per tick)
```

### 3.2 Component Changes

#### 3.2.1 Server (`fluent-flow`) — **Major changes**

**New: Loop Engine (`src/loops/`)**

A new module that manages loop lifecycle entirely on the server:

- **Loop definitions** — persisted reusable templates/contracts with TRIGGER, SCOPE, ACTION, BUDGET, STOP, REPORT
- **Loop instances** — one execution of a loop definition against a concrete repo/PR/issue/scope, with runtime status and stop reason
- **Loop scheduler** — triggers loop instances based on triggers (cron, webhook, manual)
- **Loop runner** — executes loop ticks: resolves scope, dispatches sub-agent claims, collects results, runs verification
- **Loop memory** — persistent state between ticks (`loop_instances` runtime state + existing claim history)
- **Loop verification** — runs tests/linters/reviewers between ticks, gates progression
- **Loop budget enforcement** — enforces max iterations, token/dollar caps, sub-agent limits
- **Loop reporting** — posts results to configured channels (Slack, GitHub, Linear, email)

**Changes to existing components:**

- **Claim system** — claims remain the executable work units. Existing claim chains are the current implicit loop; v2 adds an optional `loop_instance_id` FK so claims can belong to an explicit loop instance.
- **Pipeline abstraction** — current dashboard pipelines are claims grouped by `org_id + repo + pr_number`. In v2, that grouping becomes the default implicit loop migration path: a `review-fix-verify` loop instance can be materialized around that claim chain.
- **State machine** — state transitions now operate on loop-instance states (`running`, `paused`, `completed`, `failed`, `needs_approval`) in addition to claim-level states.
- **Agent system** — agents become "loop participants" with roles (`author`, `reviewer`, `verifier`) in addition to their existing `harness` type.
- **Runner** — **unchanged role**. The runner still polls for work, executes one claim, and reports results. It just receives claims with `loop_instance_id` context now.

#### 3.2.2 Runner (`fluent-flow-runner`) — **Minimal changes**

The runner stays a single-purpose claim executor. No loop orchestration logic.

**Changes to existing components:**

- **Claim execution** — claims now include `loop_instance_id` in the payload. The runner passes this through to the agent subprocess (for context) but doesn't interpret it.
- **Worktree management** — **unchanged**. Already works correctly for per-claim isolation.
- **Report results** — includes `loop_instance_id` in the report so the server can update loop state.

**What does NOT change:**
- No sub-agent spawning
- No budget tracking
- No verification logic
- No loop memory management

The runner executes one tick. The server manages the loop.

#### 3.2.3 Dashboard

**New: Loop Designer UI**

- **Loop creation wizard** — guided flow to define a loop contract (TRIGGER → SCOPE → ACTION → BUDGET → STOP → REPORT)
- **Loop templates** — pre-built loop definitions for common patterns:
  - `ci-repair` — auto-fix CI failures
  - `review-babysit` — auto-address PR review comments
  - `feature-build` — spec → build → review → test → merge
  - `dependency-audit` — scan deps, propose updates, verify
  - `test-debug` — find failing tests, diagnose, fix
- **Loop monitoring** — real-time view of running loops, sub-agent claim status, budget usage
- **Loop history** — past loops with results, duration, cost, and outcomes

**Changes to existing components:**

- **Pipeline view** — current claim-grouped pipelines become loop-instance timelines showing claims, ticks, verification results, budgets, and stop reasons
- **Agent management** — agents are now associated with loop roles (`author`, `reviewer`, `verifier`) in addition to their existing harness type

#### 3.2.4 Database

**New tables:**

| Table | Purpose |
|---|---|
| `loop_definitions` | Persistent reusable loop templates/contracts (TRIGGER, SCOPE, ACTION, BUDGET, STOP, REPORT) |
| `loop_instances` | Running/past executions of a loop definition (definition_id, concrete scope, status, started_at, completed_at, tick_count, budget_used, stop_reason) |
| `loop_tick_events` | Individual loop tick events (tick_number, claims_dispatched, verification_result, memory_snapshot) |
| `loop_skills` | Reusable skill definitions (name, description, prompt_template, verification_steps) |
| `loop_skill_usage` | Track which skills are used by which loops (for analytics) |

**Changes to existing tables:**

- `agent_claims` — gains an optional `loop_instance_id` FK to tie executable claims to explicit loop instances. Claims remain runnable by existing runners even when this field is null.
- `agents` — gains a `role` field (`author`, `reviewer`, `verifier`, `general`) in addition to `harness`

---

## 4. Anchor Files & Skills

### 4.1 Anchor Files

Loops need persistent context that survives between ticks. The model forgets everything between runs — memory must be on disk, not in context.

| File | Role |
|---|---|
| `VISION.md` | North star: product direction, constraints, what "done" looks like |
| `CLAUDE.md` / `AGENTS.md` | Operating rules: stack, commands, guardrails per tick |
| `PROMPT.md` / `loop.md` | The prompt the loop pipes in each iteration |
| `SPEC.md` | Feature spec that the loop is building toward |
| `PROGRESS.md` | What's been done, what's next, what's blocked |

**Fluent Flow contribution:** The server provides a `/api/loops/{id}/anchor-files` endpoint that fetches and validates anchor files for a loop's scope. The loop engine reads these files at the start of each tick to provide consistent context.

### 4.2 Skills

Skills are named recipes: prompt + tool policy + verification steps. The loop is plumbing that invokes those recipes on a schedule.

**Built-in skills for Fluent Flow:**

| Skill | Description |
|---|---|
| `triage` | Read CI failures, open issues, recent commits; write findings to PROGRESS.md |
| `review` | Review PR changes against spec; post inline comments |
| `fix-ci` | Diagnose CI failure, apply fix, re-run |
| `test-debug` | Find failing tests, diagnose root cause, apply fix |
| `dependency-audit` | Scan deps, propose updates, verify with tests |
| `spec-write` | Create/update spec and plan docs based on feature request |
| `verify` | Run full test suite, validate against acceptance criteria |

Skills are stored in `loop_skills` table and can be composed into loop actions.

---

## 5. Guardrails & Safety

### 5.1 Hard Stops (Non-Negotiable)

Every loop must have these three hard stops:

1. **Maximum iteration count** — `MAX_ITER` prevents infinite loops. Default: 20 for simple tasks, 50 for complex features.
2. **No-progress detection** — Stop when the same error message, empty diff, or failing test appears N times in a row. Default: 3 consecutive identical failures.
3. **Token/dollar budget ceiling** — Set a per-loop budget before execution. Default: $5 for simple tasks, $20 for features.

### 5.2 Verification Gates

A loop without verification is a machine for generating confident mistakes. Every loop must have at least one verification gate:

- **Test gate** — `npm test` / `vitest` / `pytest` must pass
- **Type gate** — TypeScript type checking must pass
- **Lint gate** — ESLint / Prettier must be clean
- **Review gate** — A separate sub-agent (different model, different instructions) reviews the changes
- **Human gate** — High-risk actions (database migrations, breaking API changes, production deploys) require human approval

### 5.3 The 14% Tax

Boris Cherny reported that 14% of developer productivity is lost to poorly structured context files. Fluent Flow addresses this by:

- Providing structured anchor file templates (VISION.md, CLAUDE.md, PROMPT.md)
- Validating anchor files when a loop is created (warn if missing critical sections)
- Tracking "wasted turns" — iterations where the agent asks basic questions that should have been answered by anchor files
- Providing a "context health" score in the dashboard

---

## 6. Migration Path from v1 to v2

### 6.1 What Stays the Same

- GitHub App integration — unchanged
- BYOK model — runner still invokes models locally
- FOR UPDATE SKIP LOCKED for claim pickup — unchanged
- Git worktree isolation — unchanged
- Outbound queue pattern — unchanged
- Config-driven state machine — unchanged
- Dashboard auth (GitHub OAuth) — unchanged
- MCP server — unchanged (gains loop-related tools)
- **Runner role** — runner remains a single-purpose claim executor. No loop orchestration in runner.

### 6.2 What Changes Incrementally

| Area | v1 Behavior | v2 Behavior | Migration |
|---|---|---|---|
| Claims | Standalone sequential work; current implicit loop substrate | Executable tasks/ticks within an explicit loop instance | Add optional `loop_instance_id` FK to existing claims |
| Runner | Execute one claim, report, repeat | Execute one claim, report, repeat (with loop context) | Pass `loop_instance_id` through claim payload |
| Pipeline | Claims grouped by `org_id + repo + pr_number` | Explicit `loop_instance` timeline with claims, verification, budgets, stop reason | Materialize existing pipelines as `review-fix-verify` loop instances over time |
| Agent registry | Type + harness + sessions | Type + harness + role (author/reviewer/verifier) | Add `role` column to `agents` |
| Dashboard | Pipeline monitor | Loop designer + loop monitor | New UI components; existing views adapted |

### 6.3 Backward Compatibility

- Existing claims without `loop_instance_id` are treated as standalone or as part of an implicit pipeline loop (backward compatible)
- Existing runners without loop-specific context handling can still execute claims; loop orchestration stays server-side
- Existing dashboard users see a "classic pipeline" view alongside the new loop view
- Migration is additive — no breaking changes to existing APIs or data

---

## 7. Acceptance Criteria

### 7.1 Loop Engine (Server)

- [ ] Loop definitions can be created via API with full contract (TRIGGER, SCOPE, ACTION, BUDGET, STOP, REPORT)
- [ ] Loop instances can be created from loop definitions for a concrete repo/PR/issue/scope
- [ ] Agent claims can be linked to a loop instance via optional `loop_instance_id`
- [ ] Loops can be triggered by cron, webhook, and manual events
- [ ] Loop ticks execute sequentially with persistent memory between ticks
- [ ] Loop verification gates run between ticks and can block progression
- [ ] Loop budget enforcement prevents runaway execution (max iterations, token cap, dollar cap)
- [ ] Loop memory is persisted to disk and survives loop restarts
- [ ] Server dispatches sub-agent claims for parallel work within a loop

### 7.2 Sub-Agent Orchestration (Server)

- [ ] Loops can dispatch multiple sub-agent claims per tick
- [ ] Each sub-agent claim is executed by a runner in its own worktree (isolated checkout)
- [ ] Sub-agents have distinct roles (author, reviewer, verifier)
- [ ] Sub-agent results are collected and merged back into the loop state
- [ ] A loop can run for hours without human intervention

### 7.3 Runner (Minimal — unchanged role)

- [ ] Runner receives claims with `loop_instance_id` context
- [ ] Runner passes `loop_instance_id` to agent subprocess (for context)
- [ ] Runner includes `loop_instance_id` in report results
- [ ] Runner behavior is unchanged for claims without `loop_instance_id` (backward compatible)
- [ ] Runner does NOT spawn sub-agents, track budgets, or manage loop state

### 7.4 Skills System

- [ ] Skills can be defined with name, description, prompt template, and verification steps
- [ ] Skills can be composed into loop actions
- [ ] Built-in skills (triage, review, fix-ci, test-debug, verify) are provided
- [ ] Skills can be shared across loops and repos

### 7.5 Dashboard

- [ ] Loop creation wizard guides users through defining a loop contract
- [ ] Loop templates (ci-repair, review-babysit, feature-build, dependency-audit, test-debug) are available
- [ ] Real-time loop monitoring shows tick progress, sub-agent claim status, and budget usage
- [ ] Loop history shows past loops with results, duration, cost, and outcomes

### 7.6 Safety

- [ ] Every loop has mandatory max iteration count (default: 20)
- [ ] Every loop has no-progress detection (default: 3 consecutive identical failures)
- [ ] Every loop has a token/dollar budget ceiling (default: $5)
- [ ] High-risk actions require human approval (configurable per loop)
- [ ] Anchor file validation warns users about missing or incomplete context files

---

## 8. Risks & Open Questions

### 8.1 Token Cost

> *"The costliest thing in AI coding is no longer writing code, it's managing the agent loop."*

Loops burn more tokens than single-prompt workflows, especially with sub-agents and verification gates. Mitigation:
- Tight budget defaults ($5 simple, $20 complex)
- Dynamic interval selection (short waits during builds, long waits when nothing is pending)
- Token usage analytics in the dashboard
- Enterprise budget controls (per-person, per-org caps)

### 8.2 Comprehension Debt

> *"The faster the loop ships code you did not write, the bigger the gap between what exists and what you actually get."*

Loops accelerate code production but also accelerate comprehension debt. Mitigation:
- Loop reports include detailed change summaries
- Human review is mandatory before merge (configurable)
- Dashboard shows "comprehension score" — how much of the loop's output the human has reviewed

### 8.3 Loop Bugs

> *"Without guardrails, you get infinite loops and billing surprises orders of magnitude over budget."*

Poorly designed loops can:
- Run forever (mitigated by max iterations + budget caps)
- Stop prematurely (mitigated by proper STOP conditions)
- Waste compute on low-value iterations (mitigated by no-progress detection)

### 8.4 Open Questions

1. **Should loops be defined in YAML files, via API, or both?** YAML enables git-versioned loop definitions. API enables dynamic loop creation. Both is safest.
2. **How do we handle loop failures?** Should a failed loop retry automatically? For how many times? With what backoff?
3. **Should loops be composable?** Can one loop call another loop as a sub-action? This adds complexity but enables powerful patterns.
4. **How do we handle multi-repo loops?** A loop that spans multiple repos needs cross-repo worktree coordination and merge conflict resolution.
5. **What about model routing?** Should different loop ticks use different models? (e.g., cheap model for triage, expensive model for verification)

---

## 8.5 Correction from Victor

The first draft incorrectly made the runner a "loop orchestrator." Victor corrected this:
- The runner is a single-purpose agent that handles one claim type
- The loop orchestrator has always been the backend server
- Runner stays minimal: poll → claim → execute → report
- Server owns all loop orchestration: definitions, scheduling, dispatch, verification, budget, memory

This correction is reflected throughout the spec.

## 9. References

- [Loop Engineering — Addy Osmani (Google)](https://addyosmani.com/blog/loop-engineering/)
- [Loop Engineering Guide — explainx.ai](https://explainx.ai/blog/loop-engineering-coding-agents-claude-code-guide-2026)
- [Harness Engineering — explainx.ai](https://explainx.ai/blog/anthropic-engineer-loops-prompts-ai-coding-harness-engineering-2026)
- [Stop Prompting AI and Start Building Loops — Product Market Fit](https://www.productmarketfit.tech/p/stop-prompting-ai-and-start-building)
- [The Anthropic leader who built Claude Code says he ditched prompting — The New Stack](https://thenewstack.io/loop-engineering/)
- [Boris Cherny at WorkOS Acquired Unplugged (video)](https://x.com/AnatoliKopadze/status/2063244296799617183)
- [Peter Steinberger's tweet (June 8, 2026)](https://x.com/steipete/status/2063697162748260627)
- [Geoffrey Huntley's ralph loop (July 2025)](https://ghuntley.com/ralph/)
- [Steve Yegge's Gas Town (January 2026)](https://github.com/gastownhall/gastown)

---

*Draft created 2026-06-10. Revised to clarify: server = loop orchestrator, runner = single-purpose executor. Awaiting review from Victor before implementation planning.*
