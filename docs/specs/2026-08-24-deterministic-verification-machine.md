# Deterministic Verification Machine — Design Spec

**Date:** 2026-08-24 · **Revised:** 2026-08-25 after cross-provider review (Claude Opus 5, GPT-5.6-Sol; 44 findings, all verified against code — zero false positives)
**Status:** Approved design, pre-implementation
**Supersedes:** the `test_verify` claim type (deprecated; creation sites removed, historical rows and config values remain valid)
**Builds on:** claim pipeline reliability substrate (PRs #117, #118, #119, #121 — all merged)

---

## 1. Problem & thesis

LLMs write plausible code; nobody has a deterministic way to verify what they wrote. Fluent Flow's current verification is LLM-judged twice over: review verdicts are parsed from a `<!-- reviewer-result -->` marker, and fixes are "verified" by a `test_verify` claim that just asks an agent whether the tests pass. Both are opinions, not proofs.

**Thesis: LLMs propose, a deterministic machine disposes.**

The machine turns every fix into a red/green proof: tests are authored from *intent* against the *broken* state (before the fix exists), proven to fail, committed to the PR, and then required to pass. Honest scope: red/green is **behavioral evidence** — proof that pinned requirements hold, not proof that the fix is safe overall. Code-quality and safety review of the fix itself stays in the chain (§4).

## 2. Goals & non-goals

**Goals**

1. Every blocking fix produced by Fluent Flow agents is verified by deterministic test execution, not agent self-report.
2. Verified tests accumulate on PR branches as permanent regression armor.
3. Verdicts are auditable: finding → requirement → test → red evidence → green result.
4. The fix agent cannot weaken, delete, or bypass its own gate through any file it controls.
5. Works for any test framework via adapters; JS/TS adapters ship first; other languages run suite-only via explicit config.

**Non-goals (phase 1)**

- Server-side execution — BYOK stands; verification runs on runners in claim worktrees.
- Browser-based e2e (phase 2: app boot + Playwright; the config enum deliberately excludes `playwright` until then).
- Verifying human-written PRs outside the Fluent Flow review chain (design does not preclude it).
- Cross-repo verification, performance budgets, formal verification.
- Advisory fixes (non-blocking fix claims on review PASS) — they bypass verification in phase 1, documented in §4.
- Fork PRs — runner pushes require rights on the target repo; forks fail closed (§10).

## 3. Terminology

| Term | Meaning |
|------|---------|
| **verify claim** | Claim type `verify` with `payload.phase` ∈ `red` \| `green`. One type, two phases. |
| **EARS spec** | Requirements distilled from intent in [EARS notation](https://ieeexplore.ieee.org/document/8501293), committed as `.fluent-flow/verify/PR-<n>/red-<claim_id>/spec.md`. |
| **manifest** | `manifest.json` mapping each requirement ID to test files, dependency files (fixtures/config/helpers it relies on), and the framework id. **The LLM/determinism boundary**: nothing downstream reads anything the LLM wrote except this file and the files it references. The manifest declares *what* to run; the *command* is always built by a trusted adapter or comes from reviewed repo config — never from the LLM. |
| **red record** | The authoritative server-owned copy of the red result: manifest, per-file sha256 hashes, `artifact_sha` (the pushed red commit), framework, outcome. Stored in `verification_results` and inlined into the green claim payload. The branch copy of `manifest.json` is a human-readable artifact only — **no verification step ever trusts it**. |
| **red proof** | Every requirement's test fails *by assertion*, reproduced on 2 consecutive runs, at the base SHA. Crash/syntax/missing-dep failures do not count. |
| **matrix** | Traceability artifact: finding → requirement → tests → red-at-base → green-at-head, plus suite totals and flake classification. |
| **red base** | `red_base_sha` — the review's `commit_id` (the exact SHA the FAIL verdict was rendered against). Independence is enforced by git ordering: the fix does not exist when tests are authored. |
| **outcome** | `verification.outcome` ∈ `PASS` \| `FAIL` \| `TAMPERED` \| `SKIPPED`. Named "outcome" to avoid collision with the review-scoped `ClaimResultSchema.verdict` (`pass`/`fail`). |

EARS sentence forms used in `spec.md`:

```
WHEN  <trigger>           THE SYSTEM SHALL <response>
WHILE  <state>            THE SYSTEM SHALL <response>
IF     <condition>        THEN THE SYSTEM SHALL <response>
WHERE  <feature included> THE SYSTEM SHALL <response>
                           THE SYSTEM SHALL <response>   (ubiquitous)
```

## 4. Chain lifecycle

**Current:** `review FAIL → review_fix → (CI green) → test_verify (LLM judges) → re-review → PASS → auto-merge`.

**New** — verify spliced in before the fix; re-review retained after green:

```
CI green on PR head
 → review claim                (unchanged; FAIL verdict + structured findings)
 → verify:red claim            (sole creator: handleReviewResult FAIL branch, when verification.enabled)
     intent inlined server-side (findings, PR body, linked issue, red_base_sha = review commit_id)
     authors EARS spec + tests AT red_base_sha, proves RED (×2 reproduction), pushes [skip ci] commit
 → review_fix claim            (created only on red completion; prompt gains immutability clause §6.5)
     fix pushed → CI completes → check_run.completed webhook (existing trigger)
 → verify:green claim          (zero LLM involvement; server-inlined red record + config; exact claim linkage)
     tamper check (server-held hashes), manifest tests explicitly, then full suite, matrix + outcome
 → green PASS   → re-review (existing dispatchReview) → PASS → auto-merge (existing handleReviewResult path)
   green FAIL   → review_fix, next cycle
   TAMPERED     → PR comment + notification + needs-human label; loop halts
   SKIPPED      → skip_policy: allow_ungated (default) → re-review chain continues ungated
                              | require → needs-human escalation
                              | manual  → pause for human decision
```

**Chain coordinator.** All review-result transitions route through one idempotent path. The FAIL branch of `handleReviewResult` (`review-manager.js`) becomes the **sole** creator of `verify:red` (it already has findings, `reviewSha`, `headBranch`, org resolution). The duplicate `review FAIL → review_fix` edge in `handleClaimResult` is **removed**. Advisory fix claims (PASS path) are unchanged and unverified in phase 1.

**Attempt allocation.** Chain-wide sequence: `nextChainAttempt(orgId, repo, pr)` = `MAX(attempt)` across **all** claim types for the PR + 1, allocated in a retry loop (unique-index conflict → recompute; never silently no-op — exhaustion of allocation retries fails loudly). The per-type MAX computation in `check-run-handler.js` is replaced. **Fix-loop cap** is enforced on *review_fix iterations per PR* (count of completed review_fix claims, cap 10, configurable) — separate from `MAX_RETRY_ATTEMPTS`, which governs transient re-dispatch only. Dashboard `getPipelineDetail` drops its `MAX(attempt)` filter and returns the full chain ordered by sequence.

**Idempotency & binding.**
- One green per fixed SHA: migration 0010 adds `CREATE UNIQUE INDEX ... ON agent_claims (org_id, repo, pr_number, head_sha) WHERE claim_type = 'verify' AND payload->>'phase' = 'green'` — race-proof without read-then-write.
- Green creation follows exact linkage: `review_fix.payload.source_claim_id` → its red claim → red record. The existing any-review_fix-within-2-hours window is replaced.
- `pull_request.synchronize` (new head push) marks still-pending green claims for older head SHAs as superseded (cancelled).
- Auto-merge fires only from the re-review PASS path (existing code). The residual race — a push between re-review dispatch and merge — is pre-existing behavior; a `head.sha` equality check before `enablePullRequestAutoMerge` is a phase-1 hardening item.

**SKIPPED policy.** `verification.skip_policy` ∈ `allow_ungated` (default — preserves today's behavior: loops without a detectable framework continue and merge as they do now) | `require` (SKIPPED escalates to human) | `manual` (SKIPPED pauses). Rationale recorded: defaulting to `require` would stall every unconfigured repo's existing loop; raising the bar is an explicit per-repo opt-in.

**test_verify deprecation.** No creation site produces `test_verify` anymore. The value stays in all three enums (`provider-schema.js`, `db/src/schemas/repo-config.ts`, runner `CLAIM_TYPES` removed instead — runner rejects unknown types as terminal, see §5.5) as **accepted-deprecated** so stored `repo_configs.claim_types` arrays keep validating; active `test_verify` claims drain naturally; removal lands in a later migration once none remain. The three enum copies are aligned in the same pass (`mcp/tools/tasks.js` gains `verify`, keeps `test_verify` deprecated).

## 5. Runner verify pipeline

New module `packages/fluent-flow-runner/src/verify.js`. `handleWork` branches on `claim_type === 'verify'`; all other types untouched.

### 5.1 Red phase

1. **Worktree at `red_base_sha`.** `prepareWorktree` gains `ref` (commit-ish) and `name` (purpose suffix) options; worktree path becomes `pr-<n>-claim-<claim_id>` (+ `-push` for the second worktree) — claim-scoped, collision-free across phases and re-dispatches. Fetch is explicit: `git fetch origin <sha>` with fallback to `git fetch origin`; SHA unreachable after 2 transient retries → outcome `SKIPPED` with explanation (never a crash).
2. **Framework + package-manager detection** (deterministic, adapter-owned): lockfile (`package-lock`/`pnpm-lock`/`yarn.lock`) + config-file presence + `package.json` scripts + monorepo package root (nearest lockfile ancestor). Overridable via config. Undetectable and unconfigured → `SKIPPED` (red phase), skip_policy applies.
3. **Authoring** (the only LLM step): existing harness machinery, new prompt. Input: server-inlined intent (findings, PR body, linked issue), EARS forms, framework conventions, test dirs, `max_requirements`. Output contract: test files + `spec.md` + `manifest.json` (requirements ↔ test paths ↔ dependency files ↔ framework id — **no commands**). Every blocking finding must map to ≥1 requirement (`source_finding_id` in the manifest); requirements are validated against server-inlined findings — an omitted or dropped blocking finding escalates rather than silently passing.
4. **Install** (adapter-owned per package manager; `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable`).
5. **RED proof** (deterministic): run the adapter's command over only the manifest's test files, JSON reporter. Validity per requirement: ≥1 test with assertion-failure status, **reproduced on 2 consecutive runs** (kills flaky-at-red). Suite-level errors (collection/syntax) → invalid red → authoring retry (≤ `authoring.retries`). Requirements still green-at-base after retries are dropped **with an explicit unverified-findings list** in the result; if any *blocking* finding ends up without a red-proven requirement → red outcome `FAIL` with explanation.
6. **Commit & push.** Second worktree (`-push`) at `origin/<branch>`; copy in only manifest-listed files; assert `git status --porcelain` shows **only added** entries (anything else fails the claim — this enforces no-overwrite, resolving the base-vs-branch tree mismatch). Commit `test(verify): pin PR #<n> requirements (red) [skip ci]`. Push `git push origin HEAD:<branch>` (#119 pattern). Record sha256 of every test + dependency file, and the pushed `artifact_sha`.

### 5.2 Green phase (deterministic from the first instruction)

1. Worktree at the fixed `head_sha` (name-scoped, detached).
2. **Tamper check** against the **server-inlined red record** (never the branch copy): every recorded test + dependency file (framework config, setup files, fixtures, helpers the manifest declared) must exist with an identical sha256. Modified, deleted, or added-surrounding-mocks → outcome `TAMPERED`.
3. **Install**, then **manifest tests explicitly** (adapter command, JSON reporter): every pinned test must pass; skips/missing count as failure; a newly pinned test that flakes is **blocking** (contradiction with "all requirements green" is resolved in favor of the requirement).
4. **Full suite run** (regression included). Pre-existing suite flakes follow `flake.retries`/`flake.blocking` as before.
5. **Matrix & outcome**: `PASS` iff all requirements green (blocking-flake rule above), full suite green modulo flake policy, no tamper. Reported with the full `verification` payload (§6.4).

### 5.3 Adapter interface

```js
// packages/fluent-flow-runner/src/verify-adapters/<framework>.js
export default {
  detect(worktreePath),         // → { id, packageManager, root } | null
  installCommand(root, pm),     // → argv
  testCommand({ files, root }), // → argv incl. JSON reporter flags; files=null → full suite
  parseResults(json),           // → [{ file, name, status: 'pass'|'assertion-fail'|'suite-error'|'skip', message }]
};
```

Phase 1 adapters: `vitest`, `jest`, `node`. Each publishes its **classification table** — which reporter fields map to `assertion-fail` vs `suite-error` — as part of the adapter contract and its tests. `custom` (repo-config `command`, argv array + cwd, owner-authored and reviewed in-repo) is **suite-only**: no per-test parsing, no red proof — red phase yields `SKIPPED` and `skip_policy` governs. `playwright` joins in phase 2.

### 5.4 Failure taxonomy & reliability substrate (mandatory)

Verify claims adopt #117/#118 semantics from day one: heartbeat during authoring/install/suite runs; results via `claim_id`; suite runs through hardened `execute()` with per-invocation timeouts (`timeouts_min.red` / `.green`); harness `is_error` envelopes fail the claim (envelope parser lives in `fluent-flow-runner/src/runner.js`).

Failure kinds, per step:

| Step | transient (re-dispatch ≤ cap) | terminal |
|------|-------------------------------|----------|
| worktree/fetch | network, unreachable-SHA (×2) | — |
| install | first failure | **repeated identical install failure (×2) — malformed lockfile repeats forever** |
| authoring | harness infra errors | malformed manifest, path violations, blocking-finding omission, retries exhausted |
| suite run | timeout (×2 — a deterministic hang repeats) | assertion outcomes (FAIL/TAMPERED/SKIPPED are outcomes, not failures) |

Re-dispatch exhaustion resolves the check run with a terminal explanation (extend `redispatchClaim` cap handling to emit it — today it returns null silently). **Verify claims always report `status: 'completed'`** with `verification.outcome` for assertion-level results; `status: 'failed'` + `failure_kind` is reserved for infrastructure. Server chaining reads `verification.outcome` exclusively.

### 5.5 Capability negotiation

Runners advertise `supported_claim_types` in `register` session meta (legacy default: all pre-verify types). `claimPendingWork` filters pending claims by the session's advertised set, so an older published runner never picks up `verify` claims. Independently, the runner classifies unknown `claim_type` as **terminal** (not transient) — no silent retry burn.

## 6. Server changes

### 6.1 Chain coordinator (`review-manager.js`)

- FAIL branch: instead of creating `review_fix`, create `verify` (phase red) when the resolved config enables verification; else `review_fix` as today. Red payload inlines: structured findings (with stable finding IDs), PR body, linked issue, `red_base_sha = review.commit_id`, resolved verification config snapshot, `branch`.
- `handleClaimResult` verify branch (all transitions idempotent, see §6.4 durability):
  - red `PASS` → create `review_fix` (payload gains `source_claim_id` → red claim).
  - red `SKIPPED`/`FAIL`/exhausted → `review_fix` ungated + check-run note (loop must not dead-end; regression from today's always-fix behavior is unacceptable).
  - green `PASS` → `dispatchReview` (re-review, existing) — auto-merge then fires from the existing re-review PASS path.
  - green `FAIL` → `review_fix`, next cycle (fix-iteration cap governs).
  - any `TAMPERED` → PR comment (outbound queue) + notification + `needs-human`; **no chain**.
  - green `SKIPPED` → skip_policy: `allow_ungated` → `dispatchReview`; `require` → needs-human; `manual` → pause record.

### 6.2 Green creation (`check-run-handler.js`)

Replaces the test_verify block: on CI success, follow the exact `review_fix.payload.source_claim_id` → red claim → **load its `verification_results` row and inline the red record** (manifest, hashes, artifact_sha, framework) into the new green claim's payload. Idempotency via the partial unique index (§4); on conflict, return immediately (no fall-through to review dispatch). All Fluent Flow-owned check runs are excluded from CI-trigger processing on **both** success and failure paths (replace the name-regex `isReviewCheckRun` with an app-slug/owner check for our own check runs) — a completing `Fluent Flow — verify` check must never re-enter dispatch.

### 6.3 Check-run lifecycle (scoped in, not "riding")

- Verify claims get real check runs: `onClaimDispatched` creates the check run **synchronously for verify claims** (bypassing the outbound queue, or via a queue completion callback) and writes back the true GitHub check-run id — the existing queue path stores the queue-row id in `check_run_external_id`, which breaks every later update.
- `onClaimStarted` is wired: called from `claimPendingWork` on successful claim.
- `onClaimResolved(client, claim, { conclusion, output })` is called from `handleClaimResult` for verify claims with a rendered matrix summary; failed requirements become annotations at repo-relative test paths (capped; GitHub limits annotations per check run).

### 6.4 Result reporting & durability

`ClaimResultSchema` gains (Zod, validated on receipt — the natural trust boundary):

```js
verification: z.object({
  phase: z.enum(['red', 'green']),
  framework: z.string(),                      // 'vitest' | 'jest' | 'node' | 'custom'
  outcome: z.enum(['PASS', 'FAIL', 'TAMPERED', 'SKIPPED']),
  matrix: VerifyMatrixSchema.nullable(),       // null for SKIPPED
  manifest: VerifyManifestSchema.optional(),   // red phase: the canonical record
  test_hashes: z.array(HashEntry).optional(),  // red phase
  artifact_sha: z.string().optional(),         // red phase: pushed commit
  red_base_sha: z.string().optional(),
  green_sha: z.string().optional(),
}).optional()
```

Persistence is transactional with finalize: one DB transaction completes the claim and upserts `verification_results` (`UNIQUE(claim_id)`); chain creation follows with idempotency keys. The claim-expiry worker's replay sweep processes completed verify claims lacking a successor (DB error between finalize and chain must not strand the loop); a redelivery that finds the claim already resolved **re-derives the transition** instead of returning early.

### 6.5 review_fix prompt clause

Appended when a red record exists: the verifier's test files *and declared dependency files* (fixtures, config, helpers listed in the manifest) are immutable — modification, deletion, or mocking-around them fails verification by hash; definition of done is those tests plus the existing suite passing.

### 6.6 Enums

`provider-schema.js` and `db/src/schemas/repo-config.ts`: `['review', 'review_fix', 'verify', 'triage', 'test_verify']` (last value deprecated-accepted). `mcp/tools/tasks.js`: adds `verify`. Runner `prompts.js`: adds `verify` (red template only); runner rejects `test_verify` as terminal-deprecated.

## 7. Data model & artifacts

### 7.1 Migration 0010

```sql
CREATE TABLE verification_results (
  id           integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  org_id       text NOT NULL REFERENCES orgs(id),
  claim_id     integer NOT NULL UNIQUE REFERENCES agent_claims(id) ON DELETE CASCADE,
  repo         text NOT NULL,
  pr_number    integer NOT NULL,
  phase        text NOT NULL CHECK (phase IN ('red','green')),
  framework    text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('PASS','FAIL','TAMPERED','SKIPPED')),
  matrix       jsonb,                            -- null for SKIPPED; carries schema_version
  test_hashes  jsonb,
  artifact_sha text,
  red_base_sha text,
  green_sha    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verification_results_pr ON verification_results (org_id, repo, pr_number);

CREATE UNIQUE INDEX idx_agent_claims_verify_green_per_sha
  ON agent_claims (org_id, repo, pr_number, head_sha)
  WHERE claim_type = 'verify' AND payload->>'phase' = 'green';
```

`ON DELETE CASCADE` keeps the dashboard's manual `DELETE FROM agent_claims` (agent deletion) working.

### 7.2 Committed PR-branch artifacts (versioned per red cycle)

```
.fluent-flow/verify/PR-<n>/red-<claim_id>/spec.md        EARS requirements, human-reviewable
.fluent-flow/verify/PR-<n>/red-<claim_id>/manifest.json  human-readable copy — never trusted by the machine
<repo-conventional test dirs>/…                          the tests
```

Red commits carry `[skip ci]` so the intentionally failing suite neither reddens required checks nor trips `handleTestFailure`; the app-slug exclusion in §6.2 is defense in depth.

### 7.3 Schema placement

Zod schemas live in `@fluent-flow/db` for **server-side validation on receipt**; the runner package carries dependency-free copies (documented duplication — the published CLI must not depend on `pg`/drizzle).

### 7.4 Config (in `src/config/schema.js` — the YAML-facing schema; snapshotted into claim payloads)

```yaml
verification:
  enabled: true
  framework: auto            # auto | vitest | jest | node | custom
  command: null              # argv array + cwd; required for custom; owner-authored
  skip_policy: allow_ungated # allow_ungated | require | manual
  flake:     { retries: 2, blocking: false }
  authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 }
  timeouts_min: { red: 15, green: 30 }
```

Added to `DefaultsConfigSchema`, `RepoConfigSchema` (repo override), and `MergedConfigSchema`; resolved server-side at claim creation and snapshotted into the claim payload — the runner never fetches config (no endpoint exists).

## 8. Dashboard

`getPipelineDetail` returns all claims ordered by chain sequence (drop the `MAX(attempt)` subquery) and left-joins `verification_results` by claim id. Pipeline detail gains a verification panel: outcome badge, matrix table (finding → requirement → tests → red/green), flake list, unverified-findings list, artifact links. `pipeline-stage.tsx` / `claim-type-badge.tsx` gain `verify` entries (red/green variants); `test_verify` label retained for history.

## 9. Guarantees (corrected scope)

| # | Guarantee | Mechanism |
|---|-----------|-----------|
| 1 | Tests verify intent, not the fix | Authored at `red_base_sha`; fix is dispatched only after red completes. |
| 2 | Every test is a real test | Assertion-fail at base ×2 reproductions; adapter classification tables distinguish assertion-fail from suite-error. |
| 3 | The fix can't weaken its own gate through files it controls | Server-held hashes over tests + declared fixtures/config/helpers; green never reads branch `manifest.json`; manifest tests run explicitly; new-test flakes are blocking. |
| 4 | Verdicts are process exits, not opinions | LLM output ends at the manifest; commands come only from trusted adapters or reviewed config. |
| 5 | Coverage is complete | Every blocking finding maps to a red-proven requirement or escalates. |
| 6 | No silent regression | Green runs the full suite. |
| 7 | Tests accumulate | Verified tests land on the PR branch. |
| — | **Not guaranteed** | Overall fix safety/code quality — that is the re-review's job; red/green is behavioral evidence for pinned requirements. |

## 10. Edge cases & failure semantics

| Case | Behavior |
|------|----------|
| Force-push during red | Authoring pins to `red_base_sha`; push worktree rebases the additive commit onto the new head (added-files-only assertion still enforced); unreachable base SHA → ×2 transient → `SKIPPED`. |
| Force-push before green | Green binds to the webhook's `head_sha`; partial unique index prevents duplicates; `synchronize` cancels stale greens; a head lacking the red artifacts → tamper check fails → `TAMPERED`. |
| Second red cycle for same PR | Artifacts versioned `red-<claim_id>`; prior cycle's tests are part of the suite the next green runs. |
| Fork PRs | Runner cannot push to fork heads by design → red push fails → terminal `SKIPPED` with explanation (`allow_forks: false` default). |
| Red commit CI | `[skip ci]` + Fluent Flow check-run exclusion; no `test_failures` work items from red commits. |
| PR closed mid-chain | Existing dismiss/expiry machinery. |
| Deterministic install failure / hang | Repeats ×2 → terminal (§5.4 taxonomy); check run resolved with explanation. |
| Re-dispatch cap hit | Terminal outcome + check-run note (no silent null). |
| Abandoned red (fix never succeeds) | Fix-iteration cap → needs-human escalation (existing label/pause machinery); red tests remain on branch as documentation of pinned-but-unmet requirements. |
| Matrix rendering of adversarial content | §11 sanitization applies. |

## 11. Security

Beyond the v1 rules, on all user-visible surfaces (check-run output, PR comments, dashboard):

- **Path safety:** manifest/test paths are repo-relative, normalized (`^[A-Za-z0-9._\-/]+$`, no leading `/`, no `..`); the runner enforces `realpath` containment inside the worktree before any copy/hash/execute — symlink escape attempts are terminal failures, surfaced generically.
- **No LLM-authored execution:** commands are adapter-built or owner-configured argv; the manifest carries no command strings.
- **Rendered-field sanitization:** length caps, control-character stripping, secret-pattern redaction, path normalization applied server-side to every string rendered from results; raw framework output stays runner-side.
- **Git credential hygiene:** all git stdout/stderr crossing to results/comments is redacted (`x-access-token:***@`); prefer `http.extraHeader`/credential-helper over URL-embedded tokens (existing worktree.js behavior noted).
- **Env inheritance:** verify subprocesses inherit the runner env (needed for harness auth); the adapter/command allowlist is the mitigation surface — `custom` commands are repo-reviewed content.

## 12. Phasing

- **Phase 1 (this spec):** chain coordinator + transitions, red/green pipeline, adapters (vitest/jest/node + custom suite-only), server-owned red records, tamper + flake + taxonomy, check-run plumbing (real ids, exclusions), durability (transactional persist, replay sweep), capability negotiation, migration 0010, dashboard chain view + panel, config system.
- **Phase 2:** Playwright adapter + app boot; screenshot/trace evidence; Gherkin expression of EARS.
- **Phase 3 (optional):** OpenAPI contract layer; property-based extraction; pytest/go adapters; advisory-fix verification.

## 13. Testing strategy

- **Adapters:** detection fixtures (lockfiles, monorepo roots); reporter parsing against captured real vitest/jest/node JSON; classification tables as contract tests.
- **verify.js:** red proof (×2 reproduction), tamper check (incl. dependency-file mutations, added mocks), blocking-flake rule, added-files-only assertion, path containment, taxonomy transitions — fake `execute()` per `tests/unit/reliability.test.js` patterns.
- **Server:** coordinator transitions (full red/green × PASS/FAIL/SKIPPED/TAMPERED/exhausted matrix), idempotent replay (re-derive, no early-return strand), green partial-index races, exact claim linkage, check-run exclusion filter, capability filter in `claimPendingWork`.
- **db:** migration, cascades, org-scoped queries, dashboard chain query.
- **Dogfood:** run the full chain on a synthetic bad PR in this repo (vitest monorepo) before merge; record in the PR template's verification field.

## 14. Open questions (non-blocking, defaults chosen)

1. Advisory fixes unverified in phase 1 — they merge today without verification either; revisiting is phase 3.
2. `head.sha === verified SHA` guard before auto-merge — hardening item inside phase 1 re-review path.
3. Phase 2 evidence retention policy (traces/screenshots) — storage bounds TBD.
