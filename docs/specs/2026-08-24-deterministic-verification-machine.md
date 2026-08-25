# Deterministic Verification Machine — Design Spec

**Date:** 2026-08-24
**Status:** Approved design, pre-implementation
**Supersedes:** the `test_verify` claim type (retired for new claims; historical rows untouched)
**Builds on:** claim pipeline reliability substrate (PRs #117, #118, #119, #121 — all merged)

---

## 1. Problem & thesis

LLMs write plausible code; nobody has a deterministic way to verify what they wrote. Fluent Flow's current verification is LLM-judged twice over: review verdicts are parsed from a `<!-- reviewer-result -->` marker echoed by the review agent, and fixes are "verified" by a `test_verify` claim that just asks an agent whether the tests pass. Both are opinions, not proofs.

**Thesis: LLMs propose, a deterministic machine disposes.**

The machine turns every fix into a red/green proof: tests are authored from *intent* against the *broken* state (before the fix exists), proven to fail, committed to the PR, and then required to pass — with every verdict traceable from requirement sentence to exit code. No LLM judgment anywhere in the verdict path.

## 2. Goals & non-goals

**Goals**

1. Every `review_fix` produced by Fluent Flow agents is verified by deterministic test execution, not agent self-report.
2. Verified tests accumulate on PR branches as permanent regression armor.
3. Verdicts are auditable: requirement → test → red evidence → green result, for every claim.
4. The fix agent cannot weaken, delete, or bypass its own gate.
5. Works for any test framework via adapters; JS/TS adapters ship first (web projects), other languages work immediately via explicit config at exit-code granularity.

**Non-goals (phase 1)**

- Server-side execution — BYOK stands; verification runs on runners in claim worktrees.
- Browser-based e2e verification (phase 2: app boot + Playwright).
- Verifying human-written PRs that never enter the Fluent Flow review chain (the design does not preclude it).
- Cross-repo verification, performance budgets, formal verification.
- Removing the LLM *review* verdict — it remains the loop's entry gate; this spec replaces the judgment *after* the fix.

## 3. Terminology

| Term | Meaning |
|------|---------|
| **verify claim** | New claim type `verify` with `payload.phase` ∈ `red` \| `green`. One type, two phases. |
| **EARS spec** | Requirements distilled from intent in [EARS notation](https://ieeexplore.ieee.org/document/8501293), committed as `.fluent-flow/verify/PR-<n>/spec.md`. |
| **manifest** | `manifest.json` mapping each requirement ID to its test files and run command. The LLM/determinism boundary: nothing downstream reads anything the LLM wrote except this file and the test files it references. |
| **red proof** | Every requirement's test fails *by assertion* at the base SHA. Crash/syntax/missing-dep failures do not count. |
| **matrix** | Traceability artifact: requirement → tests → red-at-base → green-at-head, plus suite totals and flake classification. Stored in `verification_results.matrix`. |
| **red base** | `red_base_sha` — the PR head SHA *as reviewed* (the broken state). Independence is enforced by git ordering: the fix does not exist when tests are authored. |

EARS sentence forms used in `spec.md`:

```
WHEN  <trigger>          THE SYSTEM SHALL <response>
WHILE  <state>           THE SYSTEM SHALL <response>
IF     <condition>       THEN THE SYSTEM SHALL <response>
WHERE  <feature included> THE SYSTEM SHALL <response>
                          THE SYSTEM SHALL <response>   (ubiquitous)
```

## 4. Chain lifecycle
Current: `review FAIL → review_fix → (CI green) → test_verify (LLM judges)`.

New:


```
CI green on PR head
 → review claim            (unchanged — LLM reviews; FAIL verdict + findings)
 → verify:red claim        (payload: findings, PR body, linked issue, red_base_sha = reviewed head_sha)
     authors EARS spec + tests AT red_base_sha, proves RED, pushes to PR branch
 → review_fix claim        (existing type; prompt gains immutability clause — §6.4)
     fix pushed → CI completes → check_run.completed webhook (existing trigger substrate)
 → verify:green claim      (ZERO LLM involvement)
     checks out fixed head, tamper-checks test files, runs full suite, emits matrix
 → PASS      → auto-merge (existing PASS behavior)
   FAIL      → review_fix attempt+1 (existing cap-10 loop)
   TAMPERED  → PR comment + notification, human escalation, loop halts
   SKIPPED   → loop continues without a verification gate (no framework detected/configured)
```

**Attempt numbering.** `attempt` remains the chain-wide monotonic counter (e.g. review 2 → verify:red 3 → review_fix 4 → verify:green 5). The phase lives in `payload.phase`; the existing unique index `(org_id, repo, pr_number, claim_type, attempt)` is unchanged and sufficient.

**Idempotency.** verify:green creation on `check_run.completed` keeps the existing guard shape: skip if a `verify` claim with `payload.phase='green'` already exists for this `head_sha`. verify:red creation on review FAIL is naturally idempotent per attempt (unique index).

**Green without red (suite-only mode).** If no verify:red exists for the PR (e.g. a manual fix predating the chain), verify:green still runs: full suite execution, matrix without the requirement/red columns, no tamper check. Coverage preserved; independence proof simply absent.

**test_verify retirement.** `ClaimTypeEnum` drops `test_verify`, adds `verify`. The column is plain text — historical rows are untouched. The check-run-handler's review_fix→test_verify path is replaced by review_fix→verify:green.

## 5. Runner verify pipeline

New module `packages/fluent-flow-runner/src/verify.js`. `handleWork` branches on `claim_type === 'verify'` and delegates; every other claim type is untouched.

### 5.1 Red phase

1. **Worktree at `red_base_sha`.** `prepareWorktree` gains a `ref` option (any commit-ish; today it hardcodes `origin/<branch>`). Detached HEAD is fine — authoring never pushes from this worktree.
2. **Framework detection** (deterministic, adapter-owned): lockfile + config-file presence + `package.json` scripts → `vitest` | `jest` | `node` | `playwright`. Overridable via `verification.framework` / `verification.command`. Undetectable and unconfigured → verdict `SKIPPED`, explanatory check-run, graceful loop continuation.
3. **Authoring** (the only LLM step): existing harness spawn machinery with a new prompt template. Input: intent (findings, PR body, linked issue), EARS forms, framework conventions, target test dirs, `max_requirements` cap. Output contract: write test files + `.fluent-flow/verify/PR-<n>/spec.md` + `manifest.json` (reqID → test file paths → framework → command). The prompt forbids reading any fix — at `red_base_sha` none exists to read; independence by construction.
4. **Install** (adapter-owned; default `npm ci`).
5. **RED proof** (deterministic): run the framework on *only the manifest's test files* with its JSON reporter. Validity per requirement: ≥1 test with assertion-failure status. Suite-level errors (collection failure, syntax error) → invalid red → authoring retry (≤ `authoring.retries`). A requirement still green-at-base after retries is dropped from the spec with a warning in the check-run output — it captured already-working behavior.
6. **Commit & push.** Second worktree at `origin/<branch>`; copy in *only* manifest-listed files (`rsync`-style additive copy; collisions impossible — authoring must use new file names, verified against the branch). Commit `test(verify): pin PR #<n> requirements (red)`. Push `git push origin HEAD:<branch>` (#119 detached-HEAD pattern). Record sha256 per test file in the claim result and in `manifest.json`.

### 5.2 Green phase (deterministic from the first instruction)

1. Worktree at the fixed `head_sha` (detached; no push needed).
2. **Tamper check**: every test file recorded in the red manifest must exist with an identical sha256. Modified or deleted → verdict `TAMPERED`.
3. **Install**, then **full suite run** (not only the new tests — regression included) with JSON reporter.
4. **Flake policy**: failed tests rerun up to `flake.retries` (default 2). Consistently failing = deterministic failure; passing on retry = flake (recorded; non-blocking unless `flake.blocking`).
5. **Matrix & verdict.** `PASS` iff all requirements green, full suite green modulo flake policy, no tamper. Report with the `verification` payload (§7.3).

### 5.3 Adapter interface

```js
// packages/fluent-flow-runner/src/verify-adapters/<framework>.js
export default {
  detect(worktreePath),        // → confidence + framework id, or null
  installCommand(worktreePath),// → e.g. ['npm','ci']
  testCommand(files, opts),    // → argv incl. JSON reporter flags; files=null for full suite
  parseResults(json),          // → [{ file, name, status: 'pass'|'assertion-fail'|'suite-error'|'skip', message }]
};
```

Phase 1 adapters: `vitest`, `jest`, `node` (node:test), plus `custom` (user-supplied `verification.command`; exit-code-only verdicts, no per-test matrix — works for any language today). `pytest`/`go` adapters are additive files later; the matrix schema does not change.

### 5.4 Reliability substrate reuse (mandatory)

Verify claims adopt #117/#118 semantics from day one:

- Heartbeat during authoring/install/suite runs (`client.heartbeat`, session + claim TTL extension) — verify:red easily exceeds the 15-min claim TTL otherwise.
- Results reported via `claim_id`; worktree/install failures report `failure_kind: 'transient'` (server re-dispatches); authoring exhaustion and assertion verdicts are terminal.
- Suite runs go through the hardened `execute()` (timeout SIGTERM→SIGKILL, stdout caps) with `timeouts_min.red` / `timeouts_min.green` (defaults 15/30) passed as a per-invocation timeout override.
- Harness error envelopes (`is_error: true`, exit 0) fail the claim — verified behavior exists in `health.js` / `parseHarnessResult`.

## 6. Server changes

### 6.1 Enums

- `packages/fluent-flow/src/config/provider-schema.js` `ClaimTypeEnum`: `['review', 'review_fix', 'verify', 'triage']`.
- `packages/fluent-flow-runner/src/prompts.js` `CLAIM_TYPES`: add `verify` (red template only; green is deterministic and has no prompt).
- `packages/fluent-flow/src/mcp/tools/tasks.js` `trigger_task` enum: add `verify`.

### 6.2 Chain wiring

`routes/runner.js :: handleClaimResult`:

- `review` + verdict `fail` → create `verify` claim (phase red) instead of `review_fix`. Payload: `{ phase: 'red', findings, red_base_sha: claim.head_sha, source_claim_id, branch }`.
- `verify` + phase red + completed → create `review_fix` (existing prompt, + §6.4 clause).
- `verify` + phase green + verdict `PASS` → existing auto-merge path.
- `verify` + phase green + verdict `FAIL` → `review_fix` attempt+1.
- `verify` + verdict `TAMPERED` → PR comment (outbound queue) + notification dispatch; **no chain**.

`providers/github/check-run-handler.js`: the review_fix-recently-completed + CI-pass branch that today creates `test_verify` creates `verify` (phase green) instead, keyed to `checkRun.head_sha`, referencing the red claim's manifest via `source_claim_id`. Keep the MAX-attempt computation (per-type attempts, idempotent on `(pr, head_sha, phase)`).

### 6.3 Result reporting

`ClaimResultSchema` gains:

```js
verification: z.object({
  phase: z.enum(['red', 'green']),
  framework: z.string(),
  verdict: z.enum(['PASS', 'FAIL', 'TAMPERED', 'SKIPPED']),
  matrix: VerifyMatrixSchema,        // §7.3
  red_base_sha: z.string().optional(),
  green_sha: z.string().optional(),
}).optional()
```

`handleClaimResult` persists it to `verification_results` (§7.1) on receipt.

### 6.4 review_fix prompt clause

Appended when a red manifest exists on the branch: the verifier's test files are immutable — modifying or deleting them fails verification by hash; your definition of done is those tests plus the existing suite passing.

### 6.5 Check-run output

Verify claims ride the existing check-run lifecycle (queued → in_progress → completed). Output summary renders the matrix: per-requirement line `REQ-3 WHEN cart empty … → red ✓ green ✓`, suite totals, flake notes, `SKIPPED`/`TAMPERED` explanations. Failed requirements become check-run annotations at the test-file path. Messages are repo-relative paths and test names only — no internal paths, env vars, or stack-trace dumps (CLAUDE.md security rules apply to GitHub surfaces).

## 7. Data model & artifacts

### 7.1 `verification_results` (migration 0010)

```sql
CREATE TABLE verification_results (
  id           integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  org_id       text NOT NULL REFERENCES orgs(id),
  claim_id     integer NOT NULL REFERENCES agent_claims(id),
  repo         text NOT NULL,
  pr_number    integer NOT NULL,
  phase        text NOT NULL,              -- 'red' | 'green'
  framework    text NOT NULL,              -- 'vitest' | 'jest' | 'node' | 'playwright' | 'custom'
  verdict      text NOT NULL,              -- 'PASS' | 'FAIL' | 'TAMPERED' | 'SKIPPED'
  matrix       jsonb NOT NULL,
  test_hashes  jsonb,                      -- [{ path, sha256 }] (red phase)
  red_base_sha text,
  green_sha    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verification_results_claim ON verification_results (claim_id);
CREATE INDEX idx_verification_results_pr    ON verification_results (org_id, repo, pr_number);
```

Drizzle definition in `packages/db/src/schema/workflow.ts` (alongside `test_failures`) with queries in `@fluent-flow/db`.

### 7.2 Committed PR-branch artifacts

```
.fluent-flow/verify/PR-<n>/spec.md        EARS requirements, human-reviewable
.fluent-flow/verify/PR-<n>/manifest.json  reqID → tests → framework → command + test hashes
<repo-conventional test dirs>/…           the tests
```

Commit message: `test(verify): pin PR #<n> requirements (red)`.

### 7.3 Zod schemas (`@fluent-flow/db`, exported)

```js
EarsRequirementSchema  = { id, form: enum('when','while','if','where','ubiquitous'), text }
VerifyManifestSchema   = { pr_number, requirements: [{ requirement: EarsRequirement, tests: [path], command }], test_hashes: [{ path, sha256 }] }
VerifyOutcomeSchema    = { status: enum('pass','assertion-fail','suite-error','skip'), message?, retries? }
VerifyMatrixSchema     = { requirements: [{ requirement: EarsRequirement,
                                            tests: [{ file, name, red?: VerifyOutcome, green?: VerifyOutcome }] }],
                           suite: { total, passed, failed, flaky, skipped } }
```

The claim-level `verdict` (§6.3) is derived from the matrix by the runner and stored once, on the result — not duplicated inside the matrix.

### 7.4 Config (`RepoConfigSchema.verification`, rides the existing config-cache system)

```yaml
verification:
  enabled: true
  framework: auto          # auto | vitest | jest | node | playwright | custom
  command: null            # required when framework: custom
  install_command: null    # default: npm ci
  flake:    { retries: 2, blocking: false }
  authoring:{ retries: 2, max_requirements: 25 }
  timeouts_min: { red: 15, green: 30 }
```

Zod: `VerificationConfigSchema` in `provider-schema.js`, `.optional()` on `RepoConfigSchema`.

## 8. Dashboard

Pipeline detail page gains a verification panel per `verify` claim: verdict badge, matrix table (requirement, EARS text, tests, red/green), flake list, link to `spec.md` / `manifest.json` on the branch. Reads `verification_results` directly (existing dashboard→DB pattern). No new pages.

## 9. Determinism & anti-gaming guarantees

| # | Guarantee | Mechanism |
|---|-----------|-----------|
| 1 | Tests verify intent, not the fix | Authored at `red_base_sha` — git ordering, not prompt discipline. |
| 2 | Every test is a real test | RED proof requires assertion failures; reporter JSON distinguishes assertion-fail from suite-error. |
| 3 | The fix can't weaken its own gate | Per-file sha256 at red time; green requires identical hashes; `TAMPERED` halts the loop. |
| 4 | Verdicts are process exits, not opinions | LLM output ends at `manifest.json`; everything downstream spawns processes and compares bytes. |
| 5 | Flakes ≠ signal | Failed-only reruns, consistent-fail = deterministic, pass-on-retry = flake (recorded, non-blocking by default). |
| 6 | No silent regression | Green runs the full suite. |
| 7 | Tests accumulate | Verified tests live on the PR branch; merged ⇒ permanent regression armor. |

## 10. Edge cases & failure semantics

| Case | Behavior |
|------|----------|
| Force-push during verify:red | Authoring pins to `red_base_sha` — safe. The push step re-checks `origin/<branch>` head; if it moved, rebase the additive commit (new files only; no conflict surface) and push. |
| Force-push before verify:green | Green runs at the *webhook's* `head_sha`; a head that no longer contains the manifest's test files → tamper check fails → `TAMPERED` → human. (Deleting the branch's own tests is indistinguishable from tampering by construction.) |
| PR closed mid-chain | Existing claim-dismiss/expiry machinery; no special handling. |
| No framework detected | `SKIPPED` verdict, explanatory check-run, loop continues ungated. |
| Authoring exhausted (still green-at-base) | Drop unsatisfiable requirements with a warning; proceed with the rest. All requirements unsatisfiable → verdict `FAIL` with explanation. |
| Suite exceeds timeout | Timeout kill (SIGTERM→SIGKILL); `failure_kind: 'transient'` re-dispatch per #118 semantics. |
| Same fix loop ×10 | Existing attempt cap; verify:green FAIL increments like any chain step. |
| Install failures | `transient` — network/registry hiccups re-dispatch; persistent failure exhausts retries → terminal `FAIL` with check-run note. |

## 11. Security

CLAUDE.md rules apply to all new user-visible surfaces (check-run output, PR comments, dashboard):

- Repo-relative test paths and test names only; no absolute paths, env vars, tokens, or internal hostnames.
- Framework crash output is summarized server-side; raw stack traces stay in runner logs.
- The runner pushes only manifest-listed files; the commit contains no runner metadata.
- `manifest.json` and `spec.md` are validated (Zod) before any execution — a malformed manifest is a terminal authoring failure, never executed.

## 12. Phasing

- **Phase 1 (this spec):** chain wiring, red/green pipeline, adapters (vitest/jest/node/custom), tamper + flake policy, matrix verdicts, `verification_results`, check-run output, dashboard panel, config. Retires `test_verify`.
- **Phase 2:** browser executor — adapter-orchestrated app boot + Playwright driving EARS WHEN-triggers; screenshot/trace evidence attached to the matrix; Gherkin as the human-readable expression of EARS requirements.
- **Phase 3 (optional):** OpenAPI contract layer for API-touching changes; property-based test extraction from EARS specs; `pytest`/`go test` adapters.

## 13. Testing strategy

- **Adapters:** detection fixtures per framework; reporter-JSON parsing against real vitest/jest/node output captures; red-validity classification (assertion-fail vs suite-error vs pass).
- **verify.js:** red proof, tamper check, flake classifier, matrix builder — with fake `execute()` following `tests/unit/reliability.test.js` patterns.
- **Server routes:** `handleClaimResult` chaining matrix (red→fix, green PASS→merge, FAIL→fix+1, TAMPERED→halt), `verification` payload persistence, check-run-handler idempotency on `(pr, head_sha, phase)` — following `tests/routes/runner-claim-result.test.js` patterns.
- **db:** migration + org-scoped queries for `verification_results`.
- **End-to-end dogfood:** this repo is a vitest monorepo — run the full chain on a synthetic bad PR before merge and record it in the PR template's verification field.

## 14. Open questions (non-blocking)

1. Should verify:red also gate standalone `build` claims (feature work), or stay review-chain-only in phase 1? — Stay review-chain-only; build-claim gating is a config flip once proven.
2. Matrix annotation density on very large suites — cap annotations at N failed requirements (GitHub caps annotations per check-run anyway; render top failures, link the rest).
3. When `flake.blocking: true`, do flaky pre-existing tests block unrelated fixes? — Yes by design; repos opting into strict mode accept that. Documented in config README.
