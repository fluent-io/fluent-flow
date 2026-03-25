# Review Dispatch Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move review dispatch from `pull_request.opened` to `check_run.completed` (CI-gated), and auto-dismiss stale reviews when new reviews are dispatched.

**Architecture:** The check-run handler gains a success path that dispatches reviews after CI passes, using a configurable `trigger_check` name with a fallback to all-checks-pass. `dispatchReview` dismisses prior Fluent Flow reviews before dispatching new ones. The `pull_request` webhook handler no longer dispatches reviews.

**Tech Stack:** Node.js ESM, Vitest, Zod, GitHub REST API, pino logger

**Spec:** `docs/plans/2026-03-25-review-dispatch-redesign.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config/schema.js` | Modify | Add `trigger_check` field to ReviewerConfigSchema |
| `src/github/rest.js` | Modify | Add `getCheckRunsForCommit`, `getReviews`, `dismissReview` helpers |
| `src/github/check-run-handler.js` | Modify | Add CI success path: dispatch review when trigger check passes |
| `src/engine/review-manager.js` | Modify | Dismiss stale reviews before dispatching new ones; update stale comment |
| `src/routes/webhook.js` | Modify | Remove review dispatch from opened/reopened/synchronize; export `extractLinkedIssue` |
| `tests/unit/schema.test.js` | Modify | Add trigger_check validation tests (direct + merged config) |
| `tests/unit/check-run-handler.test.js` | Modify | Add success path tests |
| `tests/unit/review-manager.test.js` | Modify | Add dismiss tests |
| `tests/unit/webhook-handler.test.js` | Modify | Remove/update existing dispatch assertions; add no-dispatch tests |

---

### Task 1: Add `trigger_check` to schema

**Files:**
- Modify: `src/config/schema.js:8-15`
- Test: `tests/unit/schema.test.js`

- [ ] **Step 1: Write failing test for trigger_check**

In `tests/unit/schema.test.js`, add to the existing `ReviewerConfigSchema` describe block:

```js
it('accepts optional trigger_check string', () => {
  const result = ReviewerConfigSchema.parse({ trigger_check: 'lint-and-test' });
  expect(result.trigger_check).toBe('lint-and-test');
});

it('defaults trigger_check to undefined when not provided', () => {
  const result = ReviewerConfigSchema.parse({});
  expect(result.trigger_check).toBeUndefined();
});

it('trigger_check flows through merged config', () => {
  const result = validateMergedConfig({
    reviewer: { enabled: true, trigger_check: 'ci' },
    states: ['Backlog', 'Done'],
  });
  expect(result.reviewer.trigger_check).toBe('ci');
});
```

Note: `ReviewerConfigSchema` is not currently exported. You'll need to export it from `schema.js` — add it to the existing exports (`validateDefaults`, `validateRepoConfig`, `validateMergedConfig`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/schema.test.js`
Expected: FAIL — `trigger_check` is stripped by Zod (not in schema)

- [ ] **Step 3: Add trigger_check to ReviewerConfigSchema**

In `src/config/schema.js`, add to the `ReviewerConfigSchema` object (after line 14):

```js
trigger_check: z.string().optional(),
```

Export the schema:

```js
export { ReviewerConfigSchema };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/schema.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.js tests/unit/schema.test.js
git commit -m "feat: add trigger_check to reviewer config schema"
```

---

### Task 2: Add REST helpers

**Files:**
- Modify: `src/github/rest.js`
- Test: (tested via integration in later tasks — these are thin wrappers around `githubRequest`)

- [ ] **Step 1: Add `getCheckRunsForCommit`**

In `src/github/rest.js`, add after `getPRsForCommit`:

```js
/**
 * Get check runs for a commit.
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @returns {Promise<Array>} Array of check run objects
 */
export async function getCheckRunsForCommit(owner, repo, sha) {
  const result = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/check-runs`);
  return result.check_runs ?? [];
}
```

- [ ] **Step 2: Add `getReviews`**

```js
/**
 * List reviews on a pull request.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<Array>} Array of review objects
 */
export async function getReviews(owner, repo, prNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
}
```

- [ ] **Step 3: Add `dismissReview`**

```js
/**
 * Dismiss a pull request review.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} reviewId
 * @param {string} message
 */
export async function dismissReview(owner, repo, prNumber, reviewId, message) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
    method: 'PUT',
    body: JSON.stringify({ message }),
  });
}
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All tests pass (no existing tests depend on these new functions yet)

- [ ] **Step 5: Commit**

```bash
git add src/github/rest.js
git commit -m "feat: add getCheckRunsForCommit, getReviews, dismissReview REST helpers"
```

---

### Task 3: Auto-dismiss stale reviews in `dispatchReview`

**Files:**
- Modify: `src/engine/review-manager.js:20-45`
- Modify: `tests/unit/review-manager.test.js`

- [ ] **Step 1: Update mocks in review-manager.test.js**

The `rest.js` mock needs the new functions. Update the existing mock (around line 14):

```js
vi.mock('../../src/github/rest.js', () => ({
  dispatchWorkflow: vi.fn(),
  addLabel: vi.fn(),
  getReviews: vi.fn(),
  dismissReview: vi.fn(),
}));
```

Add the imports after the mocks:

```js
import { getReviews, dismissReview } from '../../src/github/rest.js';
```

- [ ] **Step 2: Write failing tests for dismiss behavior**

Add a new describe block in `review-manager.test.js`:

```js
describe('dispatchReview — dismiss stale reviews', () => {
  beforeEach(() => {
    resolveConfig.mockResolvedValue(buildConfig());
    getActivePause.mockResolvedValue(null);
    getReviews.mockResolvedValue([]);
  });

  it('dismisses prior CHANGES_REQUESTED reviews with reviewer-result marker', async () => {
    getReviews.mockResolvedValue([
      { id: 101, state: 'CHANGES_REQUESTED', body: 'Bad code <!-- reviewer-result: {"status":"FAIL"} -->' },
      { id: 102, state: 'APPROVED', body: 'LGTM <!-- reviewer-result: {"status":"PASS"} -->' },
      { id: 103, state: 'CHANGES_REQUESTED', body: 'Human review — no marker' },
    ]);

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7 });

    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 7, 101, 'Superseded by new review');
  });

  it('continues dispatch if dismissReview fails', async () => {
    getReviews.mockResolvedValue([
      { id: 101, state: 'CHANGES_REQUESTED', body: '<!-- reviewer-result: {"status":"FAIL"} -->' },
    ]);
    dismissReview.mockRejectedValue(new Error('403 Forbidden'));

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7 });

    expect(dispatchWorkflow).toHaveBeenCalled();
  });

  it('does not error when no prior reviews exist', async () => {
    getReviews.mockResolvedValue([]);

    await dispatchReview({ owner: TEST_OWNER, repo: TEST_REPO, prNumber: 7 });

    expect(dismissReview).not.toHaveBeenCalled();
    expect(dispatchWorkflow).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/review-manager.test.js`
Expected: FAIL — `getReviews` and `dismissReview` not called by dispatchReview yet

- [ ] **Step 4: Implement dismiss logic in dispatchReview**

In `src/engine/review-manager.js`, add import for the new REST helpers (update existing import):

```js
import { dispatchWorkflow, addLabel, getReviews, dismissReview } from '../github/rest.js';
```

Add dismiss logic in `dispatchReview`, after the pause check (line 35) and before the `dispatchWorkflow` call (line 38):

```js
  // Dismiss prior Fluent Flow reviews before dispatching new one
  try {
    const reviews = await getReviews(owner, repo, prNumber);
    const staleReviews = reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED' && r.body?.includes('<!-- reviewer-result:')
    );
    for (const review of staleReviews) {
      try {
        await dismissReview(owner, repo, prNumber, review.id, 'Superseded by new review');
        logger.info({ msg: 'Dismissed stale review', repo: repoKey, prNumber, reviewId: review.id });
      } catch (err) {
        logger.warn({ msg: 'Failed to dismiss stale review', repo: repoKey, prNumber, reviewId: review.id, error: err.message });
      }
    }
  } catch (err) {
    logger.warn({ msg: 'Failed to fetch reviews for dismiss', repo: repoKey, prNumber, error: err.message });
  }
```

- [ ] **Step 5: Update stale comment in review-manager.js**

Around line 169-171, the comment says "The pull_request.synchronize handler will dispatch a fresh review." Update to:

```js
  // The check_run.completed handler will dispatch a fresh review with last_issues
  // as prior context when CI passes after the agent pushes new commits.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/review-manager.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/engine/review-manager.js tests/unit/review-manager.test.js
git commit -m "feat: auto-dismiss stale Fluent Flow reviews before dispatching new review"
```

---

### Task 4: Add CI success path to check-run handler

**Files:**
- Modify: `src/github/check-run-handler.js`
- Modify: `tests/unit/check-run-handler.test.js`

- [ ] **Step 1: Update mocks in check-run-handler.test.js**

Add new mocks for the functions the handler will need. The existing test already mocks `notifications/dispatcher.js`, `rest.js`, and `db/client.js`. Add these additional mocks and update the existing `rest.js` mock:

```js
vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  getRetryRecord: vi.fn(),
}));
```

Update the existing `rest.js` mock to include the new function:

```js
vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn(),
  getCheckRunsForCommit: vi.fn(),
}));
```

Add imports after the existing mocks (keep existing `resolveAgentId`, `dispatch` imports):

```js
import { dispatchReview, getRetryRecord } from '../../src/engine/review-manager.js';
import { getPRsForCommit, getCheckRunsForCommit } from '../../src/github/rest.js';
```

- [ ] **Step 2: Write failing tests for trigger_check path**

```js
describe('handleCheckRun — CI success review dispatch', () => {
  const successPayload = {
    action: 'completed',
    check_run: {
      conclusion: 'success',
      name: 'lint-and-test',
      head_sha: 'abc123',
      app: { slug: 'github-actions' },
    },
  };

  const prObj = { number: 5, title: 'feat: stuff', body: 'PR body', base: { ref: 'main' } };

  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });

  it('dispatches review when trigger_check matches', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      prNumber: 5,
      ref: 'main',
      attempt: 1,
    }));
  });

  it('ignores when trigger_check does not match', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'e2e-tests' } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('ignores review workflow check runs', async () => {
    const reviewPayload = {
      action: 'completed',
      check_run: {
        conclusion: 'success',
        name: 'review / Automated Code Review',
        head_sha: 'abc123',
        app: { slug: 'github-actions' },
      },
    };
    const config = buildConfig({ reviewer: { enabled: true } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, reviewPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('skips dispatch when max retries reached', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    getRetryRecord.mockResolvedValue({ retry_count: 3, last_issues: [] });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('passes priorIssues and attempt from retry record', async () => {
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test', max_retries: 3 } });
    const issues = [{ file: 'a.js', issue: 'bad' }];
    getRetryRecord.mockResolvedValue({ retry_count: 1, last_issues: issues });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2,
      priorIssues: issues,
    }));
  });

  it('extracts ref from PR base branch', async () => {
    getPRsForCommit.mockResolvedValue([{ ...prObj, base: { ref: 'develop' } }]);
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ ref: 'develop' }));
  });

  it('ignores when reviewer is disabled', async () => {
    const config = buildConfig({ reviewer: { enabled: false } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('ignores non-success conclusions (cancelled, timed_out)', async () => {
    const cancelledPayload = {
      action: 'completed',
      check_run: { conclusion: 'cancelled', name: 'lint-and-test', head_sha: 'abc123', app: { slug: 'github-actions' } },
    };
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, cancelledPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('uses first open PR when multiple PRs linked to same commit', async () => {
    const pr1 = { number: 5, title: 'PR 1', body: 'body', base: { ref: 'main' } };
    const pr2 = { number: 8, title: 'PR 2', body: 'body', base: { ref: 'develop' } };
    getPRsForCommit.mockResolvedValue([pr1, pr2]);
    const config = buildConfig({ reviewer: { enabled: true, trigger_check: 'lint-and-test' } });

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5, ref: 'main' }));
  });
});
```

- [ ] **Step 3: Write failing tests for fallback (all-checks-pass) path**

```js
describe('handleCheckRun — fallback all-checks-pass', () => {
  const successPayload = {
    action: 'completed',
    check_run: {
      conclusion: 'success',
      name: 'lint-and-test',
      head_sha: 'abc123',
      app: { slug: 'github-actions' },
    },
  };

  const prObj = { number: 5, title: 'feat: stuff', body: 'PR body', base: { ref: 'main' } };

  beforeEach(() => {
    getPRsForCommit.mockResolvedValue([prObj]);
    getRetryRecord.mockResolvedValue(null);
  });

  it('dispatches when all check runs pass (no trigger_check set)', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'typecheck', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    ]);

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalled();
  });

  it('waits when some checks are still pending', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'typecheck', status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } },
    ]);

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).not.toHaveBeenCalled();
  });

  it('excludes review workflow runs from all-checks query', async () => {
    const config = buildConfig({ reviewer: { enabled: true } });
    getCheckRunsForCommit.mockResolvedValue([
      { name: 'lint-and-test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { name: 'review / Automated Code Review', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
    ]);

    await handleCheckRun(TEST_OWNER, TEST_REPO, successPayload, config);

    expect(dispatchReview).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/check-run-handler.test.js`
Expected: FAIL — success path not implemented

- [ ] **Step 5: Implement CI success path in check-run-handler.js**

Update imports in `src/github/check-run-handler.js`:

```js
import { resolveAgentId, dispatch } from '../notifications/dispatcher.js';
import { getPRsForCommit, getCheckRunsForCommit } from './rest.js';
import { dispatchReview, getRetryRecord } from '../engine/review-manager.js';
import { audit } from '../db/client.js';
import logger from '../logger.js';
```

Add helper function to detect review workflow check runs:

```js
/**
 * Check if a check run belongs to the review workflow.
 * @param {object} checkRun
 * @returns {boolean}
 */
function isReviewCheckRun(checkRun) {
  return checkRun.app?.slug === 'github-actions' && /\breview\b/i.test(checkRun.name);
}
```

Rewrite `handleCheckRun` to handle both failure and success:

```js
export async function handleCheckRun(owner, repoName, payload, config) {
  const { action, check_run: checkRun } = payload;

  if (action !== 'completed') return;

  if (checkRun.conclusion === 'failure') {
    await handleCheckRunFailure(owner, repoName, checkRun, config);
    return;
  }

  if (checkRun.conclusion === 'success' || checkRun.conclusion === 'neutral') {
    await handleCheckRunSuccess(owner, repoName, checkRun, config);
  }
}
```

Extract existing failure logic into `handleCheckRunFailure` (keep current behavior unchanged).

Add new `handleCheckRunSuccess`:

```js
async function handleCheckRunSuccess(owner, repoName, checkRun, config) {
  if (!config.reviewer?.enabled) return;
  if (isReviewCheckRun(checkRun)) return;

  const triggerCheck = config.reviewer?.trigger_check;
  const repoKey = `${owner}/${repoName}`;

  if (triggerCheck) {
    // Specific check name configured — only dispatch if it matches
    if (checkRun.name !== triggerCheck) return;
  } else {
    // Fallback — wait for all check runs to pass
    try {
      const allChecks = await getCheckRunsForCommit(owner, repoName, checkRun.head_sha);
      const ciChecks = allChecks.filter((c) => !isReviewCheckRun(c));
      const allPassed = ciChecks.every(
        (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'neutral')
      );
      if (!allPassed) {
        logger.info({ msg: 'Not all checks passed yet, waiting', repo: repoKey, sha: checkRun.head_sha });
        return;
      }
    } catch (err) {
      logger.error({ msg: 'Failed to query check runs for fallback', repo: repoKey, error: err.message });
      return;
    }
  }

  // Find linked PR
  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha);
    if (prs && prs.length > 0) {
      pr = prs[0];
    }
  } catch (err) {
    logger.warn({ msg: 'Failed to find linked PR for review dispatch', repo: repoKey, sha: checkRun.head_sha, error: err.message });
    return;
  }

  if (!pr) {
    logger.info({ msg: 'No linked PR for check run, skipping review', repo: repoKey, sha: checkRun.head_sha });
    return;
  }

  // Check max retries
  const maxRetries = config.reviewer?.max_retries ?? 3;
  const retryRecord = await getRetryRecord(repoKey, pr.number);
  const retryCount = retryRecord?.retry_count ?? 0;

  if (retryCount >= maxRetries) {
    logger.info({ msg: 'Skipping review dispatch — max retries reached', repo: repoKey, prNumber: pr.number, retryCount, maxRetries });
    return;
  }

  const priorIssues = retryRecord?.last_issues ?? [];
  const attempt = retryCount + 1;
  const issueNumber = extractLinkedIssue(pr.body);

  try {
    await dispatchReview({
      owner,
      repo: repoName,
      prNumber: pr.number,
      ref: pr.base?.ref ?? 'main',
      attempt,
      priorIssues,
      issueNumber,
    });
    logger.info({ msg: 'Review dispatched after CI pass', repo: repoKey, prNumber: pr.number, attempt, trigger: triggerCheck ?? 'all-checks' });
  } catch (err) {
    logger.error({ msg: 'Failed to dispatch review after CI pass', repo: repoKey, prNumber: pr.number, error: err.message });
  }
}
```

`extractLinkedIssue` is defined in `webhook.js` but not exported. Export it from webhook.js (add to the existing export on line 411) and import in check-run-handler:

```js
import { extractLinkedIssue } from '../routes/webhook.js';
```

In `src/routes/webhook.js`, update the export line at the bottom to include it:

```js
export { handlePullRequest, handleIssues, handleIssueComment, extractLinkedIssue };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/check-run-handler.test.js`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/github/check-run-handler.js tests/unit/check-run-handler.test.js
git commit -m "feat: dispatch reviews on CI success via check-run handler"
```

---

### Task 5: Remove review dispatch from webhook handler

**Files:**
- Modify: `src/routes/webhook.js:125-244`
- Modify: `tests/unit/webhook-handler.test.js`

- [ ] **Step 1: Update existing tests and add new no-dispatch tests**

The following existing tests assert `dispatchReview` WAS called and must be removed or inverted:
- `"passes issueNumber to dispatchReview"` (opened path) — remove or change to assert `not.toHaveBeenCalled()`
- `"passes issueNumber from PR body to dispatchReview"` (synchronize path) — remove
- Any `synchronize` tests that assert `getRetryRecord` was called — remove

Also add `getRetryRecord` not-called assertion to the synchronize test. Add explicit tests:

```js
it('opened does not dispatch review (CI-gated)', async () => {
  const config = buildConfig({ reviewer: { enabled: true } });
  const payload = makePRPayload('opened');

  await handlePullRequest(TEST_OWNER, TEST_REPO, payload, config);

  expect(dispatchReview).not.toHaveBeenCalled();
});

it('reopened does not dispatch review (CI-gated)', async () => {
  const config = buildConfig({ reviewer: { enabled: true } });
  const payload = makePRPayload('reopened');

  await handlePullRequest(TEST_OWNER, TEST_REPO, payload, config);

  expect(dispatchReview).not.toHaveBeenCalled();
});

it('synchronize does not dispatch review or read retry record (CI-gated)', async () => {
  const config = buildConfig({ reviewer: { enabled: true } });
  const payload = makePRPayload('synchronize');

  await handlePullRequest(TEST_OWNER, TEST_REPO, payload, config);

  expect(dispatchReview).not.toHaveBeenCalled();
  expect(getRetryRecord).not.toHaveBeenCalled();
});
```

Note: You'll need to check the existing test file for the helper function that creates PR payloads (likely a `makePRPayload` or inline payload construction). Follow the existing pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/webhook-handler.test.js`
Expected: FAIL — dispatchReview is still called in opened/synchronize handlers

- [ ] **Step 3: Remove dispatch from opened/reopened**

In `src/routes/webhook.js`, in the `case 'opened': case 'reopened':` block (lines 125-160), remove the entire `if (config.reviewer?.enabled)` block (lines 146-158). Keep the state transition to "In Review".

- [ ] **Step 4: Remove dispatch and retry logic from synchronize**

In the `case 'synchronize':` block (lines 221-244), remove the entire block body. Replace with an empty case or a comment:

```js
    case 'synchronize': {
      // Review dispatch moved to check_run.completed handler (CI-gated)
      break;
    }
```

- [ ] **Step 5: Clean up unused imports**

Remove `getRetryRecord` from the import of `review-manager.js` in webhook.js (line 8) if it's no longer used elsewhere in the file. Check if `dispatchReview` is still referenced anywhere in the file — if not, remove that import too.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/webhook-handler.test.js`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/routes/webhook.js tests/unit/webhook-handler.test.js
git commit -m "refactor: remove review dispatch from pull_request webhook handler"
```

---

### Task 6: Update docs and config

**Files:**
- Modify: `config/defaults.yml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add trigger_check comment to defaults.yml**

In `config/defaults.yml`, add to the reviewer section:

```yaml
reviewer:
  enabled: true
  model: "claude-haiku"
  max_retries: 3
  diff_limit_kb: 65
  severity_tiers: true
  # trigger_check: "lint-and-test"  # check run name that gates review dispatch (omit for all-checks-pass fallback)
```

- [ ] **Step 2: Update README.md per-repo config example**

In the "Per-Repo Override" section, add `trigger_check` to the example:

```yaml
reviewer:
  enabled: false
  max_retries: 5
  trigger_check: "ci"            # Check run name that triggers review (omit to wait for all checks)
```

- [ ] **Step 3: Update CLAUDE.md test count**

Run `npm test` and update the test count in CLAUDE.md.

- [ ] **Step 4: Commit**

```bash
git add config/defaults.yml README.md CLAUDE.md
git commit -m "docs: add trigger_check config and update test count"
```

---

### Task 7: Integration verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Breaking change verification**

In `src/github/check-run-handler.js`, temporarily change the `isReviewCheckRun` function to always return `false`. Run tests — expect the "ignores review workflow check runs" test to fail. Revert.

- [ ] **Step 3: Breaking change verification 2**

In `src/engine/review-manager.js`, temporarily remove the dismiss logic. Run tests — expect "dismisses prior CHANGES_REQUESTED reviews" test to fail. Revert.

- [ ] **Step 4: Final commit message**

No commit needed — just verification.
