# Rich Review Failure Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make review failure notifications actionable by including full issue details in the webhook `message` field and allowing per-repo control of the agent's AI model/thinking level.

**Architecture:** Two isolated changes: (1) `formatRichMessage` formats blocking/advisory issues into a prompt string, (2) `on_failure` config block passes `model`/`thinking` through the existing webhook payload. Both flow through the existing `notifyReviewFailure` → `dispatch` → transport pipeline.

**Tech Stack:** Zod (config validation), Vitest (tests), ESM imports, raw `pg` queries

**Spec:** `docs/superpowers/specs/2026-03-22-rich-review-notifications-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config/schema.js` | Modify | Add `OnFailureSchema`, add `on_failure` to `ReviewerConfigSchema` |
| `src/notifications/dispatcher.js` | Modify | Add `formatRichMessage`, update `notifyReviewFailure` signature/payload |
| `src/engine/review-manager.js` | Modify | Pass `on_failure` from config to `notifyReviewFailure` |
| `config/defaults.yml` | Modify | Add commented-out `on_failure` block |
| `config/README.md` | Modify | Document `on_failure` config |
| `src/notifications/README.md` | Modify | Document rich message format |
| `tests/unit/schema.test.js` | Modify | Add `on_failure` validation tests |
| `tests/unit/dispatcher.test.js` | Modify | Add rich message + `on_failure` forwarding tests |
| `tests/unit/review-manager.test.js` | Modify | Verify `on_failure` passed to `notifyReviewFailure` |

---

### Task 1: Schema — Add `on_failure` to `ReviewerConfigSchema`

**Files:**
- Modify: `src/config/schema.js:3-9`
- Test: `tests/unit/schema.test.js`

- [ ] **Step 1: Write failing tests for `on_failure` validation**

Add to `tests/unit/schema.test.js` inside the `validateDefaults` describe block:

```javascript
it('accepts on_failure with model and thinking', () => {
  const result = validateDefaults({
    reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
  });
  expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'high' });
});

it('accepts on_failure with only model', () => {
  const result = validateDefaults({
    reviewer: { on_failure: { model: 'claude-sonnet-4-6' } },
  });
  expect(result.reviewer.on_failure.model).toBe('claude-sonnet-4-6');
  expect(result.reviewer.on_failure.thinking).toBeUndefined();
});

it('accepts on_failure with only thinking', () => {
  const result = validateDefaults({
    reviewer: { on_failure: { thinking: 'medium' } },
  });
  expect(result.reviewer.on_failure.thinking).toBe('medium');
});

it('rejects invalid thinking level in on_failure', () => {
  expect(() => validateDefaults({
    reviewer: { on_failure: { thinking: 'extreme' } },
  })).toThrow();
});

it('defaults on_failure to undefined when not provided', () => {
  const result = validateDefaults({});
  expect(result.reviewer.on_failure).toBeUndefined();
});
```

Add to the `validateRepoConfig` describe block:

```javascript
it('accepts partial reviewer override with on_failure', () => {
  const result = validateRepoConfig({
    reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'low' } },
  });
  expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'low' });
});
```

Add to the `validateMergedConfig` describe block:

```javascript
it('preserves on_failure through merged config', () => {
  const result = validateMergedConfig({
    reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
  });
  expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'high' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/schema.test.js`
Expected: FAIL — `on_failure` is not recognized by the schema (Zod strips unknown keys)

- [ ] **Step 3: Add `OnFailureSchema` to `src/config/schema.js`**

Add before `ReviewerConfigSchema` (after line 2):

```javascript
const OnFailureSchema = z.object({
  model: z.string().optional(),
  thinking: z.enum(['low', 'medium', 'high']).optional(),
});
```

Update `ReviewerConfigSchema` to add `on_failure`:

```javascript
const ReviewerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-haiku'),
  max_retries: z.number().int().min(0).max(10).default(3),
  diff_limit_kb: z.number().int().min(1).max(512).default(65),
  severity_tiers: z.boolean().default(true),
  on_failure: OnFailureSchema.optional(),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/schema.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.js tests/unit/schema.test.js
git commit -m "feat: add on_failure config to ReviewerConfigSchema"
```

---

### Task 2: Dispatcher — Rich message formatting and `on_failure` forwarding

**Files:**
- Modify: `src/notifications/dispatcher.js:69-80`
- Test: `tests/unit/dispatcher.test.js`

- [ ] **Step 1: Write failing tests for `formatRichMessage`**

Add to `tests/unit/dispatcher.test.js`. First, update the import to include `formatRichMessage`:

```javascript
import {
  extractAgentId,
  resolveAgentId,
  dispatch,
  notifyReviewFailure,
  notifyPause,
  notifyResume,
  notifyPRMerged,
  formatRichMessage,
} from '../../src/notifications/dispatcher.js';
```

Add a new describe block:

```javascript
describe('formatRichMessage', () => {
  it('formats blocking issues with fix suggestions', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 7, attempt: 2,
      blocking: [
        { file: 'src/foo.ts', line: 42, issue: 'Missing null check', fix: 'Add if (!x) return' },
      ],
      advisory: [],
    });
    expect(msg).toContain('Review FAILED: owner/repo#7 (attempt 2)');
    expect(msg).toContain('1 blocking issue(s)');
    expect(msg).toContain('Fix the following blocking issues');
    expect(msg).toContain('- src/foo.ts:42 — Missing null check');
    expect(msg).toContain('> Fix: Add if (!x) return');
  });

  it('formats advisory issues with suggestions', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 7, attempt: 1,
      blocking: [],
      advisory: [
        { file: 'src/bar.ts', line: 10, issue: 'Could use const', suggestion: 'Change let to const' },
      ],
    });
    expect(msg).toContain('0 blocking issue(s)');
    expect(msg).not.toContain('Fix the following blocking issues');
    expect(msg).toContain('Advisory (non-blocking):');
    expect(msg).toContain('- src/bar.ts:10 — Could use const');
    expect(msg).toContain('> Suggestion: Change let to const');
  });

  it('formats both blocking and advisory issues', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 3, attempt: 2,
      blocking: [
        { file: 'a.js', line: 1, issue: 'Bug', fix: 'Fix it' },
        { file: 'b.js', line: 2, issue: 'Error' },
      ],
      advisory: [
        { file: 'c.js', line: 3, issue: 'Style', suggestion: 'Rename' },
      ],
    });
    expect(msg).toContain('2 blocking issue(s)');
    expect(msg).toContain('- a.js:1 — Bug');
    expect(msg).toContain('> Fix: Fix it');
    expect(msg).toContain('- b.js:2 — Error');
    expect(msg).not.toContain('> Fix: undefined');
    expect(msg).toContain('Advisory (non-blocking):');
    expect(msg).toContain('- c.js:3 — Style');
  });

  it('returns summary only when no issues', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
      blocking: [], advisory: [],
    });
    expect(msg).toBe('Review FAILED: owner/repo#1 (attempt 1) — 0 blocking issue(s)');
  });

  it('handles undefined blocking and advisory', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
    });
    expect(msg).toContain('Review FAILED: owner/repo#1 (attempt 1)');
  });

  it('omits fix/suggestion line when field is absent', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
      blocking: [{ file: 'x.js', line: 5, issue: 'Problem' }],
      advisory: [{ file: 'y.js', line: 10, issue: 'Note' }],
    });
    expect(msg).toContain('- x.js:5 — Problem');
    expect(msg).not.toContain('> Fix:');
    expect(msg).toContain('- y.js:10 — Note');
    expect(msg).not.toContain('> Suggestion:');
  });
});
```

- [ ] **Step 2: Write failing tests for updated `notifyReviewFailure`**

Update the existing `notifyReviewFailure` test and add new ones inside the existing `describe('notifyReviewFailure')` block:

Replace the existing test:

```javascript
it('dispatches review_failed event with rich message', async () => {
  const mockSend = vi.fn();
  getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
  getTransport.mockReturnValue({ send: mockSend });

  await notifyReviewFailure({
    agentId: 'getonit',
    repo: 'owner/repo',
    prNumber: 7,
    attempt: 2,
    issues: [
      { severity: 'blocking', file: 'x.js', line: 10, issue: 'SQL injection', fix: 'Use parameterized queries' },
      { severity: 'advisory', file: 'y.js', line: 5, issue: 'naming', suggestion: 'Use camelCase' },
    ],
  });

  const payload = mockSend.mock.calls[0][1];
  expect(payload.event).toBe('review_failed');
  expect(payload.message).toContain('Review FAILED: owner/repo#7 (attempt 2)');
  expect(payload.message).toContain('- x.js:10 — SQL injection');
  expect(payload.message).toContain('> Fix: Use parameterized queries');
  expect(payload.message).toContain('- y.js:5 — naming');
  expect(payload.wakeMode).toBe('now');
  expect(payload.prNumber).toBe(7);
  expect(payload.attempt).toBe(2);
  // Structured issues array still present
  expect(payload.issues).toHaveLength(2);
});

it('forwards on_failure model and thinking to payload', async () => {
  const mockSend = vi.fn();
  getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
  getTransport.mockReturnValue({ send: mockSend });

  await notifyReviewFailure({
    agentId: 'getonit',
    repo: 'owner/repo',
    prNumber: 7,
    attempt: 1,
    issues: [{ severity: 'blocking', file: 'x.js', line: 1, issue: 'bug' }],
    onFailure: { model: 'claude-sonnet-4-6', thinking: 'high' },
  });

  const payload = mockSend.mock.calls[0][1];
  expect(payload.model).toBe('claude-sonnet-4-6');
  expect(payload.thinking).toBe('high');
});

it('omits model and thinking when on_failure is undefined', async () => {
  const mockSend = vi.fn();
  getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
  getTransport.mockReturnValue({ send: mockSend });

  await notifyReviewFailure({
    agentId: 'getonit',
    repo: 'owner/repo',
    prNumber: 7,
    attempt: 1,
    issues: [],
  });

  const payload = mockSend.mock.calls[0][1];
  expect(payload).not.toHaveProperty('model');
  expect(payload).not.toHaveProperty('thinking');
});

it('omits model when only thinking is set in on_failure', async () => {
  const mockSend = vi.fn();
  getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
  getTransport.mockReturnValue({ send: mockSend });

  await notifyReviewFailure({
    agentId: 'getonit',
    repo: 'owner/repo',
    prNumber: 7,
    attempt: 1,
    issues: [],
    onFailure: { thinking: 'medium' },
  });

  const payload = mockSend.mock.calls[0][1];
  expect(payload).not.toHaveProperty('model');
  expect(payload.thinking).toBe('medium');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/dispatcher.test.js`
Expected: FAIL — `formatRichMessage` not exported, message format doesn't match

- [ ] **Step 4: Implement `formatRichMessage` and update `notifyReviewFailure`**

In `src/notifications/dispatcher.js`, add `formatRichMessage` before `notifyReviewFailure` and update the function:

```javascript
/**
 * Format review issues into a rich message string for the agent prompt.
 * @param {object} opts
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {Array} [opts.blocking]
 * @param {Array} [opts.advisory]
 * @returns {string}
 */
export function formatRichMessage({ repo, prNumber, attempt, blocking = [], advisory = [] }) {
  const summary = `Review FAILED: ${repo}#${prNumber} (attempt ${attempt}) — ${blocking.length} blocking issue(s)`;

  if (blocking.length === 0 && advisory.length === 0) return summary;

  const lines = [summary, ''];

  if (blocking.length > 0) {
    lines.push('Fix the following blocking issues and push your changes:', '');
    for (const b of blocking) {
      lines.push(`- ${b.file}:${b.line} — ${b.issue}`);
      if (b.fix) lines.push(`  > Fix: ${b.fix}`);
    }
  }

  if (advisory.length > 0) {
    if (blocking.length > 0) lines.push('');
    lines.push('Advisory (non-blocking):', '');
    for (const a of advisory) {
      lines.push(`- ${a.file}:${a.line} — ${a.issue}`);
      if (a.suggestion) lines.push(`  > Suggestion: ${a.suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Notify an agent that a review failed.
 */
export async function notifyReviewFailure({ agentId, repo, prNumber, attempt, issues, onFailure, delivery = {} }) {
  const blocking = issues?.filter(i => i.severity === 'blocking') ?? [];
  const advisory = issues?.filter(i => i.severity === 'advisory') ?? [];
  const message = formatRichMessage({ repo, prNumber, attempt, blocking, advisory });
  await dispatch({
    agentId,
    event: 'review_failed',
    payload: {
      message, wakeMode: 'now', deliver: true,
      repo, prNumber, attempt, issues,
      ...(onFailure?.model && { model: onFailure.model }),
      ...(onFailure?.thinking && { thinking: onFailure.thinking }),
      ...delivery,
    },
  });
}
```

Remove the old `notifyReviewFailure` function (lines 69-80).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dispatcher.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/notifications/dispatcher.js tests/unit/dispatcher.test.js
git commit -m "feat: rich message formatting and on_failure forwarding in review notifications"
```

---

### Task 3: Review Manager — Pass `on_failure` config through

**Files:**
- Modify: `src/engine/review-manager.js:126-136`
- Test: `tests/unit/review-manager.test.js`

- [ ] **Step 1: Write failing test for `on_failure` passthrough**

Add to `tests/unit/review-manager.test.js` inside the `describe('FAIL')` block:

```javascript
it('passes on_failure from config to notifyReviewFailure', async () => {
  resolveConfig.mockResolvedValue(buildConfig({
    reviewer: { enabled: true, max_retries: 3, on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
  }));
  query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
  query.mockResolvedValue({ rows: [] });

  await handleReviewResult({ ...baseOpts, result: failResult });

  expect(notifyReviewFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      onFailure: { model: 'claude-sonnet-4-6', thinking: 'high' },
    }),
  );
});

it('passes undefined onFailure when on_failure not configured', async () => {
  query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
  query.mockResolvedValue({ rows: [] });

  await handleReviewResult({ ...baseOpts, result: failResult });

  expect(notifyReviewFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      onFailure: undefined,
    }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/review-manager.test.js`
Expected: FAIL — `onFailure` not present in the call

- [ ] **Step 3: Update `handleReviewResult` to pass `on_failure`**

In `src/engine/review-manager.js`, update the `notifyReviewFailure` call (around line 128):

```javascript
  if (resolvedAgent) {
    await notifyReviewFailure({
      agentId: resolvedAgent,
      repo: repoKey,
      prNumber,
      attempt,
      issues: allIssues,
      onFailure: config.reviewer?.on_failure,
      delivery: config.delivery ?? {},
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/review-manager.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/review-manager.js tests/unit/review-manager.test.js
git commit -m "feat: pass on_failure config to review failure notifications"
```

---

### Task 4: Clean up dead code

**Files:**
- Modify: `src/engine/review-manager.js:14-23`

- [ ] **Step 1: Remove unused `getOrCreateRetryRecord` function**

Delete the `getOrCreateRetryRecord` function (lines 14-23 of `src/engine/review-manager.js`). It is defined but never called or exported.

- [ ] **Step 2: Run all tests to confirm nothing breaks**

Run: `npx vitest run`
Expected: All 165+ tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/engine/review-manager.js
git commit -m "refactor: remove unused getOrCreateRetryRecord function"
```

---

### Task 5: Documentation

**Files:**
- Modify: `config/defaults.yml`
- Modify: `config/README.md`
- Modify: `src/notifications/README.md`

- [ ] **Step 1: Add commented-out `on_failure` to `config/defaults.yml`**

Add after `severity_tiers: true` (line 6):

```yaml
  # on_failure:                 # forwarded to agent when review fails
  #   model: claude-sonnet-4-6  # AI model the agent should use for fixes
  #   thinking: high            # thinking level: low, medium, high
```

- [ ] **Step 2: Update `config/README.md`**

In the "Per-repo config" section, update the example YAML block to include `on_failure`:

```yaml
project_id: "PVT_xxx"        # GitHub Project v2 ID
default_agent: "my-agent"     # Default agent for this repo
reviewer:
  max_retries: 5              # Override default
  on_failure:                 # Forwarded to agent when review fails
    model: claude-sonnet-4-6  # AI model for fix attempts
    thinking: high            # Thinking level: low, medium, high
```

- [ ] **Step 3: Update `src/notifications/README.md`**

Update the `notifyReviewFailure` row description in the table and add a section after "Notification functions":

```markdown
## Review failure message format

`notifyReviewFailure` builds a rich `message` string with full issue details so agents can act on the review feedback. The message includes:

- Summary line with repo, PR number, attempt, and blocking count
- Blocking issues with file path, line number, description, and fix suggestion
- Advisory issues with file path, line number, description, and suggestion

The `on_failure` config (`reviewer.on_failure` in `.github/fluent-flow.yml`) forwards `model` and `thinking` fields to the agent's webhook payload, allowing per-repo control of which AI model processes the fix.
```

- [ ] **Step 4: Commit**

```bash
git add config/defaults.yml config/README.md src/notifications/README.md
git commit -m "docs: document on_failure config and rich review message format"
```

---

### Task 6: Full test suite verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS (165 existing + new tests)

- [ ] **Step 2: Run the build**

Run: `npm run build` (if applicable, otherwise skip)

- [ ] **Step 3: Verify no lint errors**

Run: `npm run lint` (if applicable, otherwise skip)
