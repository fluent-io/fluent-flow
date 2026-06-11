# Loop Engine v2 — Phased Implementation Plan

**Date:** 2026-06-10
**Status:** Draft plan — ready for phased execution through Fluent Flow claims
**Spec:** `docs/specs/2026-06-10-loop-engineering-product-architecture.md`

## Goal

Evolve Fluent Flow from implicit claim pipelines into an explicit loop engineering platform while preserving the existing server/runner boundary:

- Server owns loop orchestration.
- Runner remains a single-claim executor.
- Claims remain the execution substrate.
- Loop definitions/templates and loop instances become the product/data-model layer around claims.

## Non-Negotiable Architecture Constraints

1. **No runner orchestration.** The runner must not schedule loops, spawn sub-agents, track budgets, decide stop conditions, or manage loop memory.
2. **Claims remain executable units.** `agent_claims` continues to be what runners poll, claim, execute, and report.
3. **Backward compatible migration.** Claims without `loop_instance_id` must continue to work.
4. **Server deterministic transitions.** Agents produce outputs; server decides state transitions.
5. **Verification-first.** Each phase must include tests or concrete inspection gates before completion.
6. **Work via Fluent Flow.** Implementation work after this plan should be dispatched as Fluent Flow claims where practical.

---

## Phase 0 — Stabilize Current Claim Pipeline

**Purpose:** Ensure the current implicit loop substrate is correct before building explicit loop abstractions on top.

### Scope

- Finish/verify `test_verify` claim pipeline fixes.
- Ensure claim attempts are per `claim_type` where required.
- Ensure `createClaim()` conflict handling is correct.
- Ensure `check-run-handler.js` falls back to normal review dispatch if `test_verify` claim creation conflicts.

### Files likely touched

- `packages/db/src/schema/agents.ts`
- `packages/db/src/migrations/0009_agent_claims_unique_include_claim_type.sql`
- `packages/fluent-flow/src/agents/claim-manager.js`
- `packages/fluent-flow/src/providers/github/check-run-handler.js`
- Relevant tests under `packages/fluent-flow/tests` and/or `packages/db/tests`

### Acceptance Criteria

- [ ] Unique indexes include `claim_type` for PR and NULL-PR claim uniqueness.
- [ ] `createClaim()` conflict target includes `claim_type` for PR claims.
- [ ] `check-run-handler.js` creates `test_verify` attempt `1` and only returns early if claim creation succeeds.
- [ ] If `test_verify` claim creation returns `null`, normal `dispatchReview()` still runs.
- [ ] Tests cover conflict between `review_fix` and `test_verify` at same attempt number.

### Verification

- Targeted unit/integration tests for claim creation and check-run handling.
- DB migration/schema inspection.

---

## Phase 1 — Explicit Loop Data Model

**Purpose:** Add loop definitions and loop instances without changing runner behavior.

### Scope

Add additive DB/schema support:

- `loop_definitions`
- `loop_instances`
- `loop_tick_events`
- optional `agent_claims.loop_instance_id`

### Data Model Draft

#### `loop_definitions`

Reusable loop template/recipe.

Core fields:

- `id`
- `org_id`
- `name`
- `description`
- `trigger` JSONB
- `scope` JSONB
- `actions` JSONB
- `budget` JSONB
- `stop_conditions` JSONB
- `reporting` JSONB
- `status` (`active`, `disabled`, `archived`)
- `created_at`, `updated_at`

#### `loop_instances`

One run of a definition.

Core fields:

- `id`
- `org_id`
- `definition_id`
- `repo`
- `pr_number` nullable
- `issue_number` nullable
- `status` (`running`, `paused`, `needs_approval`, `completed`, `failed`, `cancelled`)
- `trigger_event` JSONB
- `runtime_state` JSONB
- `tick_count`
- `budget_used` JSONB
- `stop_reason` nullable text
- `started_at`, `completed_at`, `created_at`, `updated_at`

#### `loop_tick_events`

Event log for loop progression.

Core fields:

- `id`
- `loop_instance_id`
- `tick_number`
- `event_type`
- `claims_dispatched` JSONB
- `verification_result` JSONB
- `memory_snapshot` JSONB
- `created_at`

#### `agent_claims`

Add:

- `loop_instance_id` nullable FK to `loop_instances.id`

### Acceptance Criteria

- [ ] Migrations create loop tables and optional claim FK.
- [ ] Drizzle schema exports loop tables.
- [ ] Existing claims without `loop_instance_id` still pass tests.
- [ ] Existing runner poll/claim/report flow does not require loop fields.
- [ ] README/docs explain: loop definition → loop instance → claims.

### Verification

- DB migration tests or schema generation checks.
- Existing claim-manager tests pass.
- Existing runner route tests pass.

---

## Phase 2 — Server Loop Engine Skeleton

**Purpose:** Introduce server-side loop orchestration primitives without product UI yet.

### Scope

Create `packages/fluent-flow/src/loops/` module:

- `definitions.js` — CRUD helpers for loop definitions.
- `instances.js` — create/start/pause/complete/fail loop instances.
- `dispatcher.js` — creates claims linked to loop instances.
- `events.js` — records tick events.
- `budget.js` — evaluates iteration/time/budget limits.
- `stop-conditions.js` — evaluates stop conditions.

### Acceptance Criteria

- [ ] Server can create a loop instance from a definition.
- [ ] Server can dispatch a claim linked to a loop instance.
- [ ] Server records a tick event when a claim is dispatched/completed.
- [ ] Budget/stop-condition stubs are deterministic and testable.
- [ ] Existing non-loop claim dispatch continues unchanged.

### Verification

- Unit tests for loop instance creation.
- Unit tests for claim dispatch with `loop_instance_id`.
- Existing runner route tests pass.

---

## Phase 3 — Materialize Current Review Pipeline as First Built-in Loop

**Purpose:** Turn the existing implicit review/fix/verify claim chain into the first explicit loop template.

### Built-in Template

`review-fix-verify`

Contract:

```text
TRIGGER: check_run.completed success, manual review trigger
SCOPE: one repo + PR + head SHA
ACTION: review → review_fix on FAIL → test_verify after fix → re-review
BUDGET: max 10 claim attempts / max configured loop duration
STOP: review PASS + CI PASS, max attempts, no-progress, failed claim requiring human
REPORT: GitHub check-run + PR review/comment + dashboard timeline
```

### Scope

- Seed or lazily create built-in `review-fix-verify` loop definition.
- When `dispatchReview()` starts a review flow, create or reuse a loop instance.
- Attach generated `review`, `review_fix`, and `test_verify` claims to the loop instance.
- Preserve current behavior if loop creation fails: claim dispatch should still work or fail safely.

### Acceptance Criteria

- [ ] Review claims created from check-run/manual dispatch are attached to a `review-fix-verify` loop instance.
- [ ] Auto-chained `review_fix` and `test_verify` claims preserve `loop_instance_id`.
- [ ] Re-review after `test_verify` stays attached to the same loop instance.
- [ ] Dashboard/API can still show classic pipeline grouping.
- [ ] Loop instance status reaches completed/failed/needs_approval deterministically.

### Verification

- Integration test covering review FAIL → review_fix → test_verify → re-review with same `loop_instance_id`.
- Existing review manager tests pass.

---

## Phase 4 — Loop API + MCP Tools

**Purpose:** Make loops operable programmatically before building UI.

### Scope

Add API/MCP support for:

- List loop definitions.
- Create/update loop definition.
- Start loop instance from definition.
- Get loop instance detail/timeline.
- Pause/resume/cancel loop instance.
- Trigger built-in `review-fix-verify` loop manually.

### Acceptance Criteria

- [ ] API validates loop contracts with Zod.
- [ ] MCP tool can start a loop instance.
- [ ] MCP/API returns loop timeline including claims and tick events.
- [ ] Authorization follows existing org/admin rules.
- [ ] Mutating endpoints are audited.

### Verification

- Route tests for auth and validation.
- MCP tool unit tests.
- Audit log inspection in tests where practical.

---

## Phase 5 — Dashboard Loop Visibility

**Purpose:** Expose explicit loops in the dashboard without a full designer yet.

### Scope

- Add loop list/detail views.
- Adapt current pipeline detail into loop timeline where `loop_instance_id` exists.
- Show classic pipeline fallback for claims without loop instance.
- Display status, tick count, budget used, stop reason, claims, verification events.

### Acceptance Criteria

- [ ] Dashboard shows active/completed loop instances.
- [ ] Loop detail shows associated claims in order.
- [ ] Existing pipeline pages still work.
- [ ] Empty/error/loading states are handled.

### Verification

- Dashboard tests for list/detail components where existing test patterns support it.
- Manual screenshot or route render check.

---

## Phase 6 — Loop Templates + Designer v1

**Purpose:** Productize templates as a user-facing loop creation surface.

### Scope

- Built-in template catalog:
  - `review-fix-verify`
  - `ci-repair`
  - `spec-to-build`
  - `dependency-audit`
  - `issue-triage`
- Dashboard wizard for selecting/configuring templates.
- Persist user-created definitions.

### Acceptance Criteria

- [ ] User can create a loop definition from a built-in template.
- [ ] User can start a loop instance from the dashboard.
- [ ] Template config validates trigger/scope/action/budget/stop/report.
- [ ] Generated loop instance dispatches claims through existing runner path.

### Verification

- API and dashboard tests.
- One manual end-to-end loop start in a safe test repo/PR.

---

## Phase 7 — Guardrails, Budgets, and No-Progress Detection

**Purpose:** Make loops safe enough to run unattended.

### Scope

- Max iteration enforcement.
- No-progress detection:
  - repeated identical failure
  - empty diff
  - same verifier output N times
- Human approval gates for high-risk operations.
- Budget counters in loop instance state.

### Acceptance Criteria

- [ ] Loop stops when max iterations exceeded.
- [ ] Loop stops with `stop_reason` when no-progress threshold hit.
- [ ] Loop transitions to `needs_approval` for configured high-risk gates.
- [ ] Dashboard/API surfaces stop reason and required human action.

### Verification

- Unit tests for budget and stop-condition evaluators.
- Integration test for no-progress stop.

---

## Phase 8 — Skills + Anchor Files

**Purpose:** Improve loop context quality and reuse.

### Scope

- `loop_skills` and `loop_skill_usage` tables.
- Built-in skills: `review`, `fix-ci`, `test-debug`, `spec-write`, `verify`.
- Anchor file detection/validation:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `VISION.md`
  - `SPEC.md`
  - `PROGRESS.md`
- Context health reporting.

### Acceptance Criteria

- [ ] Loop definitions can reference skills.
- [ ] Skills resolve into claim prompts/tool policies server-side or prompt payloads.
- [ ] Anchor file validation warnings are shown in API/dashboard.
- [ ] Context health score is stored or derivable.

### Verification

- Unit tests for skill resolution and anchor validation.
- Dashboard/API inspection.

---

## Recommended First Execution Claim

Start with Phase 0, because explicit loops depend on correct claim semantics.

Create a Fluent Flow `spec` claim for this repo with message:

```text
Create an implementation plan for Phase 0 of Loop Engine v2: stabilize the current claim pipeline and test_verify bug fixes before explicit loop tables are added. Read docs/specs/2026-06-10-loop-engineering-product-architecture.md and docs/plans/2026-06-10-loop-engine-v2-phased-plan.md. Produce a focused plan under docs/plans/ with files, tasks, tests, acceptance criteria, and rollback notes. Do not implement code in the spec claim.
```

Then allow the existing `spec → build` auto-chain only if we want the runner to implement immediately. For safer phased rollout, create the spec claim with `payload.auto_chain = false`, review the plan, then trigger `build` explicitly.

## Immediate Recommendation

Use Fluent Flow itself for the next work item:

1. Dispatch a `spec` claim with `auto_chain: false` for Phase 0.
2. Review the generated implementation plan.
3. Dispatch a `build` claim only after the plan is acceptable.
4. Require tests before claiming Phase 0 complete.
