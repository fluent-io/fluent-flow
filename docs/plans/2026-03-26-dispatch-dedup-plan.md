# Dispatch Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate review dispatches when concurrent `check_run.completed` webhooks fire for the same commit SHA.

**Architecture:** Add `last_dispatch_sha` column to `review_retries`. Before dispatching in the automated check-run path, atomically claim the SHA via upsert. If the claim fails (same SHA already dispatched, or max retries reached), skip. Manual dispatch callers are unaffected.

**Tech Stack:** PostgreSQL (raw `pg`), Vitest, ESM

**Spec:** `docs/plans/2026-03-26-dispatch-dedup-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/db/migrations/004_dispatch_dedup.sql` | Add `last_dispatch_sha` column |
| Modify | `src/db/client.js:36` | Register migration `004_dispatch_dedup.sql` |
| Modify | `src/engine/review-manager.js` | Add `claimDispatch()`, update `resetRetries()` to clear `last_dispatch_sha` |
| Modify | `src/github/check-run-handler.js:96-158` | Replace read-then-dispatch with `claimDispatch` |
| Modify | `tests/helpers/mocks.js` | Add `last_dispatch_sha` to `makeRetryRecord` |
| Modify | `tests/unit/review-manager.test.js` | Add `claimDispatch` tests |
| Modify | `tests/unit/check-run-handler.test.js` | Update mock from `getRetryRecord` to `claimDispatch` |

---

### Task 1: Migration — Add `last_dispatch_sha` Column

**Files:**
- Create: `src/db/migrations/004_dispatch_dedup.sql`
- Modify: `src/db/client.js:36`

- [ ] **Step 1: Create the migration file**

```sql
ALTER TABLE review_retries ADD COLUMN IF NOT EXISTS last_dispatch_sha TEXT;
```

Write to `src/db/migrations/004_dispatch_dedup.sql`.

- [ ] **Step 2: Register the migration in `src/db/client.js`**

Change line 36 from:

```js
  const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql'];
```

to:

```js
  const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql', '004_dispatch_dedup.sql'];
```

- [ ] **Step 3: Verify the build passes**

Run: `npm run build` (or `npx tsc --noEmit` if no build script)
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/004_dispatch_dedup.sql src/db/client.js
git commit -m "feat: add last_dispatch_sha column migration"
```

---

### Task 2: Add `claimDispatch` to `review-manager.js` (TDD)

**Files:**
- Modify: `src/engine/review-manager.js`
- Modify: `tests/helpers/mocks.js`
- Modify: `tests/unit/review-manager.test.js`

- [ ] **Step 1: Update `makeRetryRecord` mock helper**

In `tests/helpers/mocks.js`, add `last_dispatch_sha` to `makeRetryRecord`:

```js
export function makeRetryRecord(overrides = {}) {
  return {
    id: 1,
    repo: TEST_REPO_KEY,
    pr_number: 7,
    retry_count: 1,
    last_issues: null,
    last_review_sha: 'abc123',
    last_dispatch_sha: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
```

- [ ] **Step 2: Write failing tests for `claimDispatch`**

Add to `tests/unit/review-manager.test.js`, after the existing `getRetryRecord` describe block. Import `claimDispatch` alongside existing imports:

```js
// Update the import line at the top of the file:
import { dispatchReview, handleReviewResult, getRetryRecord, claimDispatch } from '../../src/engine/review-manager.js';
```

Then add the test block:

```js
describe('claimDispatch', () => {
  it('returns record on first claim for a new PR (no prior retry row)', async () => {
    query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 0, last_dispatch_sha: 'sha1' })] });

    const result = await claimDispatch(TEST_REPO_KEY, 7, 'sha1', 3);

    expect(result).not.toBeNull();
    expect(result.retry_count).toBe(0);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('IS DISTINCT FROM'),
      [TEST_REPO_KEY, 7, 'sha1', 3],
    );
  });

  it('returns null when same SHA already claimed (duplicate)', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await claimDispatch(TEST_REPO_KEY, 7, 'sha1', 3);

    expect(result).toBeNull();
  });

  it('returns null when retry_count >= maxRetries', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await claimDispatch(TEST_REPO_KEY, 7, 'sha2', 3);

    expect(result).toBeNull();
  });

  it('returns record when SHA differs from previous claim', async () => {
    query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1, last_dispatch_sha: 'sha2' })] });

    const result = await claimDispatch(TEST_REPO_KEY, 7, 'sha2', 3);

    expect(result).not.toBeNull();
    expect(result.retry_count).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --reporter verbose tests/unit/review-manager.test.js`
Expected: FAIL — `claimDispatch` is not exported from review-manager.js

- [ ] **Step 4: Implement `claimDispatch` in `src/engine/review-manager.js`**

Add after the `getRetryRecord` function (before `resetRetries`):

```js
/**
 * Atomically claim a dispatch slot for a SHA. Returns the retry record if
 * the claim succeeds (new SHA or first dispatch), or null if the SHA was
 * already dispatched or max retries reached.
 *
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @param {string} sha - Commit SHA to claim
 * @param {number} maxRetries
 * @returns {Promise<object|null>}
 */
export async function claimDispatch(repo, prNumber, sha, maxRetries) {
  const result = await query(
    `INSERT INTO review_retries (repo, pr_number, last_dispatch_sha)
     VALUES ($1, $2, $3)
     ON CONFLICT (repo, pr_number) DO UPDATE
       SET last_dispatch_sha = $3, updated_at = NOW()
       WHERE review_retries.last_dispatch_sha IS DISTINCT FROM $3
         AND review_retries.retry_count < $4
     RETURNING *`,
    [repo, prNumber, sha, maxRetries]
  );
  return result.rows[0] ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --reporter verbose tests/unit/review-manager.test.js`
Expected: All tests PASS, including all 4 new `claimDispatch` tests.

- [ ] **Step 6: Breaking change verification**

Temporarily change the `IS DISTINCT FROM` to `IS NOT DISTINCT FROM` in the SQL. Run:

Run: `npm test -- --reporter verbose tests/unit/review-manager.test.js`
Expected: `claimDispatch` tests FAIL (logic inverted).

Revert the change.

- [ ] **Step 7: Commit**

```bash
git add src/engine/review-manager.js tests/unit/review-manager.test.js tests/helpers/mocks.js
git commit -m "feat: add claimDispatch for atomic dispatch dedup"
```

---

### Task 3: Update `resetRetries` to Clear `last_dispatch_sha` (TDD)

**Files:**
- Modify: `src/engine/review-manager.js`
- Modify: `tests/unit/review-manager.test.js`

- [ ] **Step 1: Write failing test**

Add a new test inside a `describe('resetRetries')` block in `tests/unit/review-manager.test.js`. Import `resetRetries`:

```js
// Update the import line at the top:
import { dispatchReview, handleReviewResult, getRetryRecord, claimDispatch, resetRetries } from '../../src/engine/review-manager.js';
```

Then add:

```js
describe('resetRetries', () => {
  it('clears retry_count, last_issues, and last_dispatch_sha', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await resetRetries(TEST_REPO_KEY, 7);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('last_dispatch_sha = NULL'),
      [TEST_REPO_KEY, 7],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter verbose tests/unit/review-manager.test.js`
Expected: FAIL — the current `resetRetries` SQL does not include `last_dispatch_sha`.

- [ ] **Step 3: Update `resetRetries` in `src/engine/review-manager.js`**

Change the existing `resetRetries` function from:

```js
export async function resetRetries(repo, prNumber) {
  await query(
    `UPDATE review_retries SET retry_count = 0, last_issues = NULL, updated_at = NOW()
     WHERE repo = $1 AND pr_number = $2`,
    [repo, prNumber]
  );
}
```

to:

```js
export async function resetRetries(repo, prNumber) {
  await query(
    `UPDATE review_retries SET retry_count = 0, last_issues = NULL, last_dispatch_sha = NULL, updated_at = NOW()
     WHERE repo = $1 AND pr_number = $2`,
    [repo, prNumber]
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --reporter verbose tests/unit/review-manager.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/review-manager.js tests/unit/review-manager.test.js
git commit -m "fix: resetRetries clears last_dispatch_sha"
```

---

### Task 4: Wire `claimDispatch` into `check-run-handler.js` (TDD)

**Files:**
- Modify: `src/github/check-run-handler.js`
- Modify: `tests/unit/check-run-handler.test.js`

- [ ] **Step 1: Update test mocks — replace `getRetryRecord` with `claimDispatch`**

In `tests/unit/check-run-handler.test.js`, update the mock and imports:

Change the mock declaration from:

```js
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  getRetryRecord: vi.fn(),
}));
```

to:

```js
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  claimDispatch: vi.fn(),
}));
```

Change the import from:

```js
import { dispatchReview, getRetryRecord } from '../../src/engine/review-manager.js';
```

to:

```js
import { dispatchReview, claimDispatch } from '../../src/engine/review-manager.js';
```

- [ ] **Step 2: Update existing tests — CI success review dispatch block**

In the `handleCheckRun — CI success review dispatch` describe block, update the `beforeEach`:

Change from:

```js
  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });
```

to:

```js
  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    claimDispatch.mockResolvedValue({ retry_count: 0, last_issues: null });
  });
```

Update the test `'dispatches review when trigger_check matches'`:

```js
  it('dispatches review when trigger_check matches', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({
      owner: TEST_OWNER, repo: TEST_REPO, prNumber: 5, ref: 'main', attempt: 1,
    }));
  });
```

This test stays the same — it just verifies `dispatchReview` is called. The `claimDispatch` mock in `beforeEach` returns a successful claim.

Update `'skips dispatch when max retries reached'`:

```js
  it('skips dispatch when max retries reached', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    claimDispatch.mockResolvedValue(null);
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });
```

Update `'passes priorIssues and attempt from retry record'`:

```js
  it('passes priorIssues and attempt from retry record', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    const issues = [{ file: 'a.js', issue: 'bad' }];
    claimDispatch.mockResolvedValue({ retry_count: 1, last_issues: issues });
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, priorIssues: issues }));
  });
```

- [ ] **Step 3: Add new dedup-specific test**

Add inside the same `handleCheckRun — CI success review dispatch` describe block:

```js
  it('skips dispatch when claimDispatch returns null (duplicate SHA)', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });
    claimDispatch.mockResolvedValue(null);
    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);
    expect(dispatchReview).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Update fallback all-checks-pass tests**

In the `handleCheckRun — fallback all-checks-pass` describe block, update `beforeEach`:

Change from:

```js
  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });
```

to:

```js
  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    claimDispatch.mockResolvedValue({ retry_count: 0, last_issues: null });
  });
```

The three existing tests in this block (`dispatches when all check runs pass`, `waits when some checks are still pending`, `excludes review workflow runs`) remain unchanged — they verify the all-checks logic, not the claim path.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test -- --reporter verbose tests/unit/check-run-handler.test.js`
Expected: FAIL — `check-run-handler.js` still imports and calls `getRetryRecord`, but the mock now exports `claimDispatch`.

- [ ] **Step 6: Update `src/github/check-run-handler.js`**

Change the import (line 3) from:

```js
import { dispatchReview, getRetryRecord } from '../engine/review-manager.js';
```

to:

```js
import { dispatchReview, claimDispatch } from '../engine/review-manager.js';
```

Replace lines 136-153 (the retry record read, max retries check, attempt calculation, and dispatch) with:

```js
  const maxRetries = config.reviewer?.max_retries ?? 3;
  const claim = await claimDispatch(repoKey, pr.number, checkRun.head_sha, maxRetries);
  if (!claim) {
    logger.info({ msg: 'Skipping review dispatch — duplicate SHA or max retries', repo: repoKey, prNumber: pr.number, sha: checkRun.head_sha });
    return;
  }

  const priorIssues = claim.last_issues ?? [];
  const attempt = (claim.retry_count ?? 0) + 1;
  const issueNumber = extractLinkedIssue(pr.body);

  try {
    await dispatchReview({
      owner, repo: repoName, prNumber: pr.number,
      ref: pr.base?.ref ?? 'main', attempt, priorIssues, issueNumber,
    });
    logger.info({ msg: 'Review dispatched after CI pass', repo: repoKey, prNumber: pr.number, attempt, trigger: triggerCheck ?? 'all-checks' });
  } catch (err) {
    logger.error({ msg: 'Failed to dispatch review after CI pass', repo: repoKey, prNumber: pr.number, error: err.message });
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --reporter verbose tests/unit/check-run-handler.test.js`
Expected: All tests PASS.

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All 236+ tests PASS.

- [ ] **Step 9: Breaking change verification**

In `check-run-handler.js`, temporarily change `if (!claim)` to `if (claim)` (invert the guard). Run:

Run: `npm test -- --reporter verbose tests/unit/check-run-handler.test.js`
Expected: Multiple tests FAIL (dispatches when it shouldn't, skips when it shouldn't).

Revert the change.

- [ ] **Step 10: Commit**

```bash
git add src/github/check-run-handler.js tests/unit/check-run-handler.test.js
git commit -m "fix: use atomic claimDispatch to prevent duplicate review dispatches"
```

---

### Task 5: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Verify lint passes**

Run: `npm run lint` (if configured)
Expected: No errors.

- [ ] **Step 3: Verify build passes**

Run: `npm run build` (if configured)
Expected: No errors.
