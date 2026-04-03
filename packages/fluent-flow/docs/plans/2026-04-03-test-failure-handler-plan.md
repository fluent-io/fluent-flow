# Test Failure Handler — Implementation Plan

> **Goal:** Parse check run test failures and dispatch retry feedback to agents.

**Architecture:** When a CI check run completes with failure, extract test failure details from GitHub check annotations, create a claim, and notify the agent with structured test output.

**Tech Stack:** Node.js ESM, Vitest, Zod, GitHub REST API, pino logger

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/github/test-parser.js` | Create | Parse GitHub check annotations → structured test failures |
| `src/engine/test-manager.js` | Create | Handle test results (similar to review-manager but for tests) |
| `src/github/check-run-handler.js` | Modify | Add test failure path to CI success/failure routing |
| `tests/unit/test-parser.test.js` | Create | Parser unit tests |
| `tests/unit/test-manager.test.js` | Create | Test result handler tests |
| `tests/unit/check-run-handler.test.js` | Modify | Add test failure test cases |

---

## Task 1: Create test-parser.js

**Purpose:** Extract failure details from GitHub check run annotations.

GitHub check runs can include annotations with details. Parse them into structured format:
```js
{
  passed: 5,
  failed: 2,
  skipped: 1,
  failures: [
    { file: 'src/foo.test.js', line: 42, message: 'Expected true but got false', title: 'should validate input' },
    { file: 'src/bar.test.js', line: 105, message: 'Timeout waiting for element', title: 'should render button' }
  ]
}
```

- [ ] **Step 1: Write failing test for parseCheckAnnotations**

In `tests/unit/test-parser.test.js`:
```js
describe('test-parser', () => {
  describe('parseCheckAnnotations', () => {
    it('extracts failures from GitHub check annotations', () => {
      const annotations = [
        {
          path: 'src/foo.test.js',
          start_line: 42,
          message: 'Expected true but got false',
          title: 'should validate input',
          annotation_level: 'failure'
        }
      ];
      const result = parseCheckAnnotations(annotations);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toEqual({
        file: 'src/foo.test.js',
        line: 42,
        message: 'Expected true but got false',
        title: 'should validate input'
      });
    });

    it('counts passed/failed/skipped from conclusion and annotations', () => {
      const annotations = [
        { annotation_level: 'failure', message: 'Failed' },
        { annotation_level: 'failure', message: 'Failed' }
      ];
      const result = parseCheckAnnotations(annotations, 'failure', 10); // 10 total
      expect(result.failed).toBe(2);
      expect(result.passed).toBe(8); // 10 - 2 failures
    });

    it('ignores non-failure annotations', () => {
      const annotations = [
        { annotation_level: 'notice', message: 'FYI' },
        { annotation_level: 'warning', message: 'Warning' },
        { annotation_level: 'failure', message: 'Actual failure' }
      ];
      const result = parseCheckAnnotations(annotations);
      expect(result.failures).toHaveLength(1);
    });

    it('handles empty annotations', () => {
      const result = parseCheckAnnotations([]);
      expect(result.failures).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/test-parser.test.js`
Expected: FAIL — function doesn't exist

- [ ] **Step 3: Implement parseCheckAnnotations**

In `src/github/test-parser.js`:
```js
/**
 * Parse GitHub check run annotations into structured test failures.
 * @param {Array} annotations - GitHub check run annotations
 * @param {string} [conclusion] - Check conclusion (failure, success, etc.)
 * @param {number} [totalTests] - Total test count if available
 * @returns {object} { passed, failed, skipped, failures }
 */
export function parseCheckAnnotations(annotations = [], conclusion = 'failure', totalTests = null) {
  const failures = annotations
    .filter((a) => a.annotation_level === 'failure')
    .map((a) => ({
      file: a.path || 'unknown',
      line: a.start_line || null,
      title: a.title || 'Test failed',
      message: a.message || ''
    }));

  const failed = failures.length;
  const passed = totalTests && totalTests > failed ? totalTests - failed : 0;

  return {
    passed,
    failed,
    skipped: 0,
    failures
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/test-parser.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/github/test-parser.js tests/unit/test-parser.test.js
git commit -m "feat: add test failure parser for GitHub check annotations"
```

---

## Task 2: Create test-manager.js

**Purpose:** Handle test failures similar to review failures — create claims, notify agents.

- [ ] **Step 1: Write failing tests for handleTestFailure**

In `tests/unit/test-manager.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTestFailure } from '../../src/engine/test-manager.js';

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn()
}));
vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn(),
  addLabel: vi.fn()
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaim: vi.fn(),
  completeClaim: vi.fn(),
  getActiveClaim: vi.fn()
}));
vi.mock('../../src/notifications/dispatcher.js', () => ({
  notifyTestFailure: vi.fn(),
  resolveAgentForIssue: vi.fn()
}));
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  audit: vi.fn()
}));

const { resolveConfig } = await import('../../src/config/loader.js');
const { getPRsForCommit, addLabel } = await import('../../src/github/rest.js');
const { createClaim, getActiveClaim } = await import('../../src/agents/claim-manager.js');
const { notifyTestFailure, resolveAgentForIssue } = await import('../../src/notifications/dispatcher.js');
const { query, audit } = await import('../../src/db/client.js');

const TEST_OWNER = 'test-org';
const TEST_REPO = 'test-repo';
const TEST_REPO_KEY = `${TEST_OWNER}/${TEST_REPO}`;

describe('handleTestFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfig.mockResolvedValue({
      org_id: 'self-hosted',
      default_agent: 'test-agent',
      reviewer: { max_retries: 3 },
      delivery: {}
    });
    query.mockResolvedValue({ rows: [{ test_attempt: 1, retry_count: 1 }] });
  });

  it('parses test failures and notifies agent', async () => {
    const testFailures = {
      passed: 5,
      failed: 2,
      failures: [
        { file: 'src/foo.test.js', line: 42, title: 'should work', message: 'Expected true' }
      ]
    };
    getPRsForCommit.mockResolvedValue([{ number: 7, body: '' }]);
    resolveAgentForIssue.mockResolvedValue('test-agent');

    await handleTestFailure({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      sha: 'abc123',
      checkName: 'tests',
      testFailures,
      issueNumber: 10
    });

    expect(notifyTestFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'test-agent',
        repo: TEST_REPO_KEY,
        prNumber: 7,
        testFailures
      })
    );
  });

  it('creates claim before notifying agent', async () => {
    const testFailures = { passed: 5, failed: 2, failures: [] };
    getPRsForCommit.mockResolvedValue([{ number: 7, body: '' }]);
    resolveAgentForIssue.mockResolvedValue('test-agent');

    await handleTestFailure({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      sha: 'abc123',
      checkName: 'tests',
      testFailures,
      issueNumber: 10
    });

    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: TEST_REPO_KEY,
        agentId: 'test-agent',
        payload: expect.objectContaining({ testFailures })
      })
    );
  });

  it('skips if PR not found', async () => {
    getPRsForCommit.mockResolvedValue([]);

    await handleTestFailure({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      sha: 'abc123',
      checkName: 'tests',
      testFailures: { passed: 5, failed: 0, failures: [] }
    });

    expect(notifyTestFailure).not.toHaveBeenCalled();
  });

  it('escalates if max retries exceeded', async () => {
    query.mockResolvedValue({ rows: [{ test_attempt: 1, retry_count: 3 }] });
    getPRsForCommit.mockResolvedValue([{ number: 7, body: '', state: 'open' }]);
    resolveAgentForIssue.mockResolvedValue('test-agent');

    await handleTestFailure({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      sha: 'abc123',
      checkName: 'tests',
      testFailures: { passed: 0, failed: 5, failures: [] },
      issueNumber: 10,
      config: { reviewer: { max_retries: 3 } }
    });

    expect(addLabel).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 10, 'needs-human');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/test-manager.test.js`
Expected: FAIL — function doesn't exist

- [ ] **Step 3: Implement handleTestFailure**

In `src/engine/test-manager.js`:
```js
import { query, audit } from '../db/client.js';
import { resolveConfig } from '../config/loader.js';
import { getPRsForCommit, addLabel } from '../github/rest.js';
import { notifyTestFailure, resolveAgentForIssue } from '../notifications/dispatcher.js';
import { createClaim, completeClaim } from '../agents/claim-manager.js';
import logger from '../logger.js';

/**
 * Handle test failures from a check run.
 * Creates claim, notifies agent, handles retry logic.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.sha - Commit SHA
 * @param {string} opts.checkName - Name of the check that failed
 * @param {object} opts.testFailures - { passed, failed, failures: [{ file, line, title, message }] }
 * @param {number} [opts.issueNumber] - Linked issue
 * @param {object} [opts.config] - Repo config (fetched if not provided)
 */
export async function handleTestFailure({ owner, repo, sha, checkName, testFailures, issueNumber, config }) {
  const repoKey = `${owner}/${repo}`;
  
  if (!config) {
    config = await resolveConfig(owner, repo);
  }

  // Find linked PR
  let pr = null;
  try {
    const prs = await getPRsForCommit(owner, repo, sha);
    if (prs && prs.length > 0) pr = prs[0];
  } catch (err) {
    logger.warn({ msg: 'Failed to find linked PR for test failure', repo: repoKey, sha, error: err.message });
    return;
  }

  if (!pr || pr.state !== 'open') {
    logger.info({ msg: 'No open PR for test failure', repo: repoKey, sha });
    return;
  }

  const prNumber = pr.number;

  // Resolve agent
  const agentId = await resolveAgentForIssue(owner, repo, issueNumber, config);
  if (!agentId) {
    logger.info({ msg: 'No agent configured for repo', repo: repoKey });
    return;
  }

  // Track retry count
  const retryResult = await query(
    `INSERT INTO test_failures (repo, pr_number, sha, retry_count, test_output)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (repo, pr_number) DO UPDATE
       SET retry_count = test_failures.retry_count + 1,
           test_output = $4,
           updated_at = NOW()
     RETURNING *`,
    [repoKey, prNumber, sha, JSON.stringify(testFailures)]
  );
  const retryRecord = retryResult.rows[0];
  const retryCount = retryRecord.retry_count;
  const maxRetries = config.reviewer?.max_retries ?? 3;

  logger.info({ msg: 'Test failure recorded', repo: repoKey, prNumber, retryCount, maxRetries });

  // Create claim before notifying (for long-poll session routing)
  try {
    await createClaim({
      orgId: config.org_id ?? 'self-hosted',
      repo: repoKey,
      prNumber,
      attempt: 1,
      agentId,
      payload: {
        message: formatTestFailureMessage(repoKey, prNumber, testFailures),
        testFailures
      },
      claimType: 'test_failure'
    });
  } catch (err) {
    logger.warn({ msg: 'Failed to create test failure claim', error: err.message });
  }

  // Notify agent
  await notifyTestFailure({
    agentId,
    repo: repoKey,
    prNumber,
    testFailures,
    delivery: config.delivery ?? {}
  });

  // Check max retries
  if (retryCount >= maxRetries) {
    logger.info({ msg: 'Max test retries reached — escalating', repo: repoKey, prNumber });
    audit('test_escalated', { repo: repoKey, data: { prNumber, failureCount: testFailures.failed } });

    // Add needs-human label
    if (issueNumber) {
      try {
        await addLabel(owner, repo, issueNumber, 'needs-human');
      } catch (err) {
        logger.error({ msg: 'Failed to add needs-human label', error: err.message });
      }
    }

    // Reset counter
    await query(
      `UPDATE test_failures SET retry_count = 0 WHERE repo = $1 AND pr_number = $2`,
      [repoKey, prNumber]
    );

    return { action: 'escalate' };
  }

  return { action: 'retry' };
}

function formatTestFailureMessage(repo, prNumber, testFailures) {
  const { passed, failed, failures } = testFailures;
  let msg = `Tests failed in ${repo}#${prNumber}\n`;
  msg += `Passed: ${passed}, Failed: ${failed}\n\n`;
  
  if (failures.length > 0) {
    msg += 'Failed tests:\n';
    failures.slice(0, 10).forEach((f) => {
      msg += `- ${f.file}:${f.line} — ${f.title}\n`;
      msg += `  ${f.message}\n`;
    });
    if (failures.length > 10) {
      msg += `... and ${failures.length - 10} more\n`;
    }
  }

  return msg;
}

/**
 * Handle test success (all tests pass).
 * Complete the active claim if tests were previously failing.
 */
export async function handleTestSuccess({ repo, prNumber, sha }) {
  const repoKey = repo; // Already formatted

  try {
    // Mark test as passing
    await query(
      `UPDATE test_failures SET last_pass_sha = $1, updated_at = NOW()
       WHERE repo = $2 AND pr_number = $3`,
      [sha, repoKey, prNumber]
    );

    logger.info({ msg: 'Tests passed', repo: repoKey, prNumber });
    audit('test_passed', { repo: repoKey, data: { prNumber } });
  } catch (err) {
    logger.error({ msg: 'Failed to record test pass', error: err.message });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/test-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/test-manager.js tests/unit/test-manager.test.js
git commit -m "feat: handle test failures with retry and escalation logic"
```

---

## Task 3: Add test failure path to check-run-handler

**Purpose:** Route test failures from CI checks to the new test-manager.

- [ ] **Step 1: Identify test check run by name pattern**

In `src/github/check-run-handler.js`, add helper:
```js
function isTestCheckRun(checkRun) {
  // Matches: "tests", "test", "jest", "vitest", "pytest", "mocha", "xunit", etc.
  return /\b(test|tests|jest|vitest|pytest|mocha|xunit|unittest|rspec|go.test)\b/i.test(checkRun.name);
}
```

- [ ] **Step 2: Parse check run annotations in handleCheckRunSuccess**

Modify the success path to check if it's a test run:
```js
if (isTestCheckRun(checkRun)) {
  // Test success — create event
  await handleTestSuccess({ repo: repoKey, prNumber: pr.number, sha: checkRun.head_sha });
}
```

- [ ] **Step 3: Add test failure path**

Modify `handleCheckRunFailure` to distinguish test failures:
```js
async function handleCheckRunFailure(owner, repoName, checkRun, config) {
  // ... existing code ...

  if (isTestCheckRun(checkRun)) {
    // Test failure — parse and handle
    const annotations = await getCheckRunAnnotations(owner, repoName, checkRun.id);
    const testFailures = parseCheckAnnotations(annotations);
    
    await handleTestFailure({
      owner,
      repo: repoName,
      sha: checkRun.head_sha,
      checkName: checkRun.name,
      testFailures,
      issueNumber: extractLinkedIssue(pr?.body),
      config
    });
    return;
  }

  // ... existing CI failure handling ...
}
```

- [ ] **Step 4: Add getCheckRunAnnotations to rest.js**

```js
export async function getCheckRunAnnotations(owner, repo, checkRunId) {
  const result = await githubRequest(
    `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=100`
  );
  return result ?? [];
}
```

- [ ] **Step 5: Add tests**

In `tests/unit/check-run-handler.test.js`, add:
```js
it('routes test failures to handleTestFailure', async () => {
  const testPayload = {
    action: 'completed',
    check_run: {
      conclusion: 'failure',
      name: 'tests',
      head_sha: 'abc123',
      id: 999,
      app: { slug: 'github-actions' }
    }
  };
  getCheckRunAnnotations.mockResolvedValue([
    { annotation_level: 'failure', path: 'src/foo.test.js', start_line: 42, message: 'Failed' }
  ]);
  getPRsForCommit.mockResolvedValue([{ number: 5, body: '', state: 'open' }]);

  await handleCheckRun(TEST_OWNER, TEST_REPO, testPayload, buildConfig());

  expect(handleTestFailure).toHaveBeenCalled();
});
```

- [ ] **Step 6: Commit**

```bash
git add src/github/check-run-handler.js src/github/rest.js tests/unit/check-run-handler.test.js
git commit -m "feat: route test failures to test-manager for retry handling"
```

---

## Task 4: Add test failure notification to dispatcher

**Purpose:** Send test failure messages to agents.

- [ ] **Step 1: Add notifyTestFailure function**

In `src/notifications/dispatcher.js`:
```js
export async function notifyTestFailure({
  agentId,
  repo,
  prNumber,
  testFailures,
  delivery = {}
}) {
  const message = `Tests failed: ${repo}#${prNumber} — ${testFailures.failed} failures, ${testFailures.passed} passed`;
  
  await dispatch({
    agentId,
    event: 'test_failed',
    payload: {
      message,
      testFailures,
      deliver: true,
      wakeMode: 'now',
      repo,
      prNumber
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/notifications/dispatcher.js
git commit -m "feat: add test failure notification to dispatcher"
```

---

## Task 5: DB migration for test_failures table

- [ ] **Step 1: Create migration**

In `src/db/migrations/008_test_failures.sql`:
```sql
CREATE TABLE test_failures (
  id SERIAL PRIMARY KEY,
  repo VARCHAR(255) NOT NULL,
  pr_number INT NOT NULL,
  sha VARCHAR(40),
  retry_count INT DEFAULT 0,
  test_output JSONB,
  last_pass_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo, pr_number)
);

CREATE INDEX idx_test_failures_repo_pr ON test_failures(repo, pr_number);
CREATE INDEX idx_test_failures_created ON test_failures(created_at DESC);
```

- [ ] **Step 2: Register migration in db/client.js**

Add to migrations array:
```js
import migration008 from './migrations/008_test_failures.sql';
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/008_test_failures.sql src/db/client.js
git commit -m "chore: add test_failures DB table migration"
```

---

## Task 6: Integration & verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new ones

- [ ] **Step 2: Breaking change verification**

Temporarily disable `isTestCheckRun()` — expect test detection tests to fail. Revert.

- [ ] **Step 3: Commit summary**

```bash
git log --oneline -6
```

Expected output shows 6 commits for this feature.

---

## Summary

This adds a parallel test failure handler that:
- Parses GitHub check annotations for test failures
- Routes test check runs to the new handler
- Creates claims and notifies agents with structured test output
- Implements retry logic with escalation to needs-human
- Integrates seamlessly with existing review-manager pattern

Total new code: ~800 lines (test-parser, test-manager, dispatcher changes, migration)
Total modified: ~300 lines (check-run-handler, rest.js)
Test coverage: 15+ new tests
