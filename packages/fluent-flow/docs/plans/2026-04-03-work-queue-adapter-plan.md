# Work Queue Adapter System — Implementation Plan

> **Goal:** Create a pluggable work queue system where test failures (and other work items) are created as explicit state items, not notifications. Agents poll for work, see items in specific states, and act on them deterministically.

**Architecture:** Abstract work queue interface + GitHub Projects adapter (first implementation).

Test failures create "Test Failures" state items that agents must acknowledge and fix. Completely deterministic — no ambiguous notifications.

**Tech Stack:** Node.js ESM, Vitest, Zod, GitHub GraphQL API, pino logger

---

## Core Concept

Instead of:
```
Test fails → notify agent → agent somehow sees message → agent fixes
```

We do:
```
Test fails → create work item in "Test Failures" state → agent polls → agent sees explicit work → agent fixes
```

Agent sees:
```
Issue #42: Add user auth
├─ State: Test Failures
├─ PR: #105
├─ Failures: 2 tests failed
│  └─ src/auth.test.js:42 — should validate token
│  └─ src/auth.test.js:89 — should reject expired token
└─ Action: Update PR to fix tests
```

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/work-queue/adapter.js` | Create | Abstract adapter interface |
| `src/work-queue/adapters/github-projects.js` | Create | GitHub Projects implementation |
| `src/work-queue/index.js` | Create | Adapter registry + factory |
| `src/engine/test-manager.js` | Create | Handle test failures (uses adapter) |
| `src/github/test-parser.js` | Create | Parse test failure details |
| `tests/unit/adapter.test.js` | Create | Adapter interface tests |
| `tests/unit/github-projects-adapter.test.js` | Create | GitHub Projects adapter tests |
| `tests/unit/test-manager.test.js` | Create | Test manager tests |
| `src/github/check-run-handler.js` | Modify | Route test failures to test-manager |
| `src/config/schema.js` | Modify | Add work_queue config field |
| `config/defaults.yml` | Modify | Set default work queue adapter |

---

## Phases

### Phase 1: Work Queue Abstraction (Days 1-2)
Tasks 1-3: Define adapter interface, GitHub Projects adapter, registry

### Phase 2: Test Failure Handler (Days 3-4)
Tasks 4-5: Test parser, test manager using adapter

### Phase 3: Integration (Days 5)
Tasks 6-7: Route check runs, config, verification

---

## PHASE 1: Work Queue Abstraction

### Task 1: Define Adapter Interface

**File:** `src/work-queue/adapter.js`

- [ ] **Step 1: Write interface spec**

Create JSDoc-documented interface:
```js
/**
 * Work Queue Adapter Interface
 * Implementations handle creating, updating, and querying work items
 * (issues in specific states) across different platforms.
 */

/**
 * Create a work item for test failures.
 * @param {object} opts
 * @param {string} opts.owner - Repository owner
 * @param {string} opts.repo - Repository name
 * @param {number} opts.issueNumber - Linked GitHub issue number
 * @param {number} opts.prNumber - Pull request number
 * @param {string} opts.title - Work item title
 * @param {string} opts.description - Full description with failure details
 * @param {object} opts.testFailures - { passed, failed, failures: [] }
 * @returns {Promise<object>} Created work item with { id, state, url }
 */
export async function createTestFailureItem(opts) {
  throw new Error('Not implemented');
}

/**
 * Update a work item state.
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.issueNumber
 * @param {string} opts.fromState - Current state
 * @param {string} opts.toState - Target state (e.g., 'Test Failures' → 'Done')
 * @returns {Promise<void>}
 */
export async function updateWorkItemState(opts) {
  throw new Error('Not implemented');
}

/**
 * Get pending work items for an agent.
 * @param {string} agentId
 * @param {object} opts - Agent context
 * @returns {Promise<Array>} Work items with { issueNumber, state, testFailures, ... }
 */
export async function getPendingWorkItems(agentId, opts) {
  throw new Error('Not implemented');
}

/**
 * Acknowledge a work item (agent has seen it).
 * @param {number} issueNumber
 * @returns {Promise<void>}
 */
export async function acknowledgeWorkItem(issueNumber) {
  throw new Error('Not implemented');
}
```

- [ ] **Step 2: Export base class**

```js
export class WorkQueueAdapter {
  constructor(config) {
    this.config = config;
  }

  async createTestFailureItem(opts) {
    throw new Error('createTestFailureItem not implemented');
  }

  async updateWorkItemState(opts) {
    throw new Error('updateWorkItemState not implemented');
  }

  async getPendingWorkItems(agentId, opts) {
    throw new Error('getPendingWorkItems not implemented');
  }

  async acknowledgeWorkItem(issueNumber) {
    throw new Error('acknowledgeWorkItem not implemented');
  }
}
```

- [ ] **Step 3: Write tests**

In `tests/unit/adapter.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { WorkQueueAdapter } from '../../src/work-queue/adapter.js';

describe('WorkQueueAdapter', () => {
  it('throws on unimplemented methods', async () => {
    const adapter = new WorkQueueAdapter({});
    
    await expect(() => adapter.createTestFailureItem({})).rejects.toThrow();
    await expect(() => adapter.updateWorkItemState({})).rejects.toThrow();
    await expect(() => adapter.getPendingWorkItems('agent')).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/work-queue/adapter.js tests/unit/adapter.test.js
git commit -m "feat: define work queue adapter interface"
```

---

### Task 2: Implement GitHub Projects Adapter

**File:** `src/work-queue/adapters/github-projects.js`

- [ ] **Step 1: Write failing test**

In `tests/unit/github-projects-adapter.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProjectsAdapter } from '../../src/work-queue/adapters/github-projects.js';

vi.mock('../../src/github/graphql.js', () => ({
  createProjectItem: vi.fn(),
  updateProjectItemState: vi.fn(),
  queryProjectItems: vi.fn()
}));

const { createProjectItem, updateProjectItemState, queryProjectItems } = 
  await import('../../src/github/graphql.js');

describe('GitHubProjectsAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new GitHubProjectsAdapter({
      projectNodeId: 'PVT_123',
      apiToken: 'token'
    });
    vi.clearAllMocks();
  });

  it('creates test failure item in GitHub Project', async () => {
    createProjectItem.mockResolvedValue({ id: 'item_123', state: 'Test Failures' });

    const result = await adapter.createTestFailureItem({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      prNumber: 105,
      title: 'Fix: Tests failed',
      description: 'Test failures...',
      testFailures: { passed: 5, failed: 2, failures: [] }
    });

    expect(result).toEqual({ id: 'item_123', state: 'Test Failures' });
    expect(createProjectItem).toHaveBeenCalledWith(
      expect.objectContaining({ projectNodeId: 'PVT_123' })
    );
  });

  it('updates item state from Test Failures to Done', async () => {
    await adapter.updateWorkItemState({
      issueNumber: 42,
      fromState: 'Test Failures',
      toState: 'Done'
    });

    expect(updateProjectItemState).toHaveBeenCalled();
  });

  it('queries pending test failure items for agent', async () => {
    queryProjectItems.mockResolvedValue([
      {
        issue_number: 42,
        state: 'Test Failures',
        pr_number: 105,
        test_failures: { failed: 2, passed: 5 }
      }
    ]);

    const items = await adapter.getPendingWorkItems('agent-id', {});

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('Test Failures');
  });
});
```

- [ ] **Step 2: Implement adapter**

```js
import { WorkQueueAdapter } from '../adapter.js';
import {
  createProjectItem,
  updateProjectItemState,
  queryProjectItems
} from '../../src/github/graphql.js';
import logger from '../../logger.js';

export class GitHubProjectsAdapter extends WorkQueueAdapter {
  constructor(config) {
    super(config);
    // config should have: projectNodeId, apiToken (or use GITHUB_TOKEN env)
  }

  async createTestFailureItem({
    owner,
    repo,
    issueNumber,
    prNumber,
    title,
    description,
    testFailures
  }) {
    const { passed, failed, failures } = testFailures;

    // Format failure details for project item body
    let body = `## Test Failures\n\n`;
    body += `PR: #${prNumber}\n`;
    body += `Passed: ${passed} | Failed: ${failed}\n\n`;
    
    if (failures.length > 0) {
      body += `### Failed Tests\n`;
      failures.slice(0, 5).forEach((f) => {
        body += `- **${f.title}** (${f.file}:${f.line})\n`;
        body += `  ${f.message}\n`;
      });
      if (failures.length > 5) {
        body += `... and ${failures.length - 5} more\n`;
      }
    }

    body += `\n---\n*Action: Update PR #${prNumber} to fix failing tests.*`;

    try {
      const item = await createProjectItem({
        projectNodeId: this.config.projectNodeId,
        issueNumber,
        title: `Fix: ${title}`,
        description: body,
        state: 'Test Failures'
      });

      logger.info({ msg: 'Created test failure item in project', issueNumber, itemId: item.id });
      return item;
    } catch (err) {
      logger.error({ msg: 'Failed to create project item', error: err.message });
      throw err;
    }
  }

  async updateWorkItemState({ issueNumber, fromState, toState }) {
    try {
      await updateProjectItemState({
        projectNodeId: this.config.projectNodeId,
        issueNumber,
        fromState,
        toState
      });

      logger.info({ msg: 'Updated work item state', issueNumber, fromState, toState });
    } catch (err) {
      logger.error({ msg: 'Failed to update project item state', error: err.message });
      throw err;
    }
  }

  async getPendingWorkItems(agentId, opts = {}) {
    try {
      const items = await queryProjectItems({
        projectNodeId: this.config.projectNodeId,
        states: ['Test Failures', 'In Progress'],
        limit: 50
      });

      // Filter to items assigned to agent or unassigned
      return items.filter((item) => !item.assignee_id || item.assignee_id === agentId);
    } catch (err) {
      logger.error({ msg: 'Failed to query project items', error: err.message });
      return [];
    }
  }

  async acknowledgeWorkItem(issueNumber) {
    // GitHub Projects doesn't have explicit "acknowledge", so this is a no-op
    logger.info({ msg: 'Acknowledged work item', issueNumber });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run tests/unit/github-projects-adapter.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/work-queue/adapters/github-projects.js tests/unit/github-projects-adapter.test.js
git commit -m "feat: implement GitHub Projects work queue adapter"
```

---

### Task 3: Adapter Registry & Factory

**File:** `src/work-queue/index.js`

- [ ] **Step 1: Create registry**

```js
import { GitHubProjectsAdapter } from './adapters/github-projects.js';
import logger from '../logger.js';

const ADAPTERS = {
  'github-projects': GitHubProjectsAdapter
};

/**
 * Get work queue adapter instance.
 * @param {string} type - Adapter type (github-projects, linear, jira, etc.)
 * @param {object} config - Adapter-specific config
 * @returns {WorkQueueAdapter}
 */
export function getAdapter(type, config) {
  const AdapterClass = ADAPTERS[type];

  if (!AdapterClass) {
    throw new Error(`Unknown work queue adapter: ${type}`);
  }

  logger.info({ msg: 'Loaded work queue adapter', type });
  return new AdapterClass(config);
}

/**
 * Register a new adapter.
 * @param {string} type
 * @param {class} AdapterClass
 */
export function registerAdapter(type, AdapterClass) {
  ADAPTERS[type] = AdapterClass;
  logger.info({ msg: 'Registered work queue adapter', type });
}

export { WorkQueueAdapter } from './adapter.js';
```

- [ ] **Step 2: Write tests**

```js
import { describe, it, expect } from 'vitest';
import { getAdapter, registerAdapter } from '../../src/work-queue/index.js';
import { WorkQueueAdapter } from '../../src/work-queue/adapter.js';

describe('Work Queue Registry', () => {
  it('loads github-projects adapter', () => {
    const adapter = getAdapter('github-projects', { projectNodeId: 'test' });
    expect(adapter).toBeInstanceOf(WorkQueueAdapter);
  });

  it('throws on unknown adapter type', () => {
    expect(() => getAdapter('unknown', {})).toThrow('Unknown work queue adapter');
  });

  it('registers custom adapter', () => {
    class CustomAdapter extends WorkQueueAdapter {}
    registerAdapter('custom', CustomAdapter);

    const adapter = getAdapter('custom', {});
    expect(adapter).toBeInstanceOf(CustomAdapter);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/work-queue/index.js tests/unit/work-queue-registry.test.js
git commit -m "feat: add work queue adapter registry and factory"
```

---

## PHASE 2: Test Failure Handler

### Task 4: Test Failure Parser

**File:** `src/github/test-parser.js`

- [ ] **Step 1: Write tests for parseCheckAnnotations**

```js
import { describe, it, expect } from 'vitest';
import { parseCheckAnnotations } from '../../src/github/test-parser.js';

describe('parseCheckAnnotations', () => {
  it('extracts test failures from GitHub check annotations', () => {
    const annotations = [
      {
        path: 'src/foo.test.js',
        start_line: 42,
        title: 'should validate input',
        message: 'Expected true but got false',
        annotation_level: 'failure'
      },
      {
        path: 'src/bar.test.js',
        start_line: 105,
        title: 'should render button',
        message: 'Timeout waiting for element',
        annotation_level: 'failure'
      }
    ];

    const result = parseCheckAnnotations(annotations);

    expect(result.failed).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toEqual({
      file: 'src/foo.test.js',
      line: 42,
      title: 'should validate input',
      message: 'Expected true but got false'
    });
  });

  it('ignores non-failure annotations', () => {
    const annotations = [
      { annotation_level: 'notice', message: 'Info' },
      { annotation_level: 'warning', message: 'Warning' },
      { annotation_level: 'failure', message: 'Real failure' }
    ];

    const result = parseCheckAnnotations(annotations);
    expect(result.failures).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement parser**

```js
/**
 * Parse GitHub check run annotations into structured test failures.
 * @param {Array} annotations - GitHub check annotations
 * @returns {object} { passed, failed, skipped, failures }
 */
export function parseCheckAnnotations(annotations = []) {
  const failures = annotations
    .filter((a) => a.annotation_level === 'failure')
    .map((a) => ({
      file: a.path || 'unknown',
      line: a.start_line || null,
      title: a.title || 'Test failed',
      message: a.message || ''
    }));

  return {
    passed: 0,  // We don't get this from annotations, computed later
    failed: failures.length,
    skipped: 0,
    failures
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/github/test-parser.js tests/unit/test-parser.test.js
git commit -m "feat: add test failure parser for check annotations"
```

---

### Task 5: Test Manager Using Adapter

**File:** `src/engine/test-manager.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTestFailure } from '../../src/engine/test-manager.js';

vi.mock('../../src/work-queue/index.js', () => ({
  getAdapter: vi.fn()
}));
vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn()
}));
vi.mock('../../src/github/rest.js', () => ({
  getPRsForCommit: vi.fn()
}));

const { getAdapter } = await import('../../src/work-queue/index.js');
const { resolveConfig } = await import('../../src/config/loader.js');
const { getPRsForCommit } = await import('../../src/github/rest.js');

describe('handleTestFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveConfig.mockResolvedValue({
      work_queue: { type: 'github-projects', projectNodeId: 'PVT_123' },
      default_agent: 'test-agent'
    });
  });

  it('creates work item for test failures using adapter', async () => {
    const mockAdapter = {
      createTestFailureItem: vi.fn().mockResolvedValue({ id: 'item_123' })
    };
    getAdapter.mockReturnValue(mockAdapter);
    getPRsForCommit.mockResolvedValue([{ number: 105, body: '', state: 'open' }]);

    const testFailures = {
      passed: 5,
      failed: 2,
      failures: [
        { file: 'src/foo.test.js', line: 42, title: 'should work', message: 'Failed' }
      ]
    };

    await handleTestFailure({
      owner: 'test-org',
      repo: 'test-repo',
      sha: 'abc123',
      checkName: 'tests',
      testFailures,
      issueNumber: 42
    });

    expect(getAdapter).toHaveBeenCalledWith('github-projects', { projectNodeId: 'PVT_123' });
    expect(mockAdapter.createTestFailureItem).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        prNumber: 105,
        testFailures
      })
    );
  });
});
```

- [ ] **Step 2: Implement handleTestFailure**

```js
import { resolveConfig } from '../config/loader.js';
import { getAdapter } from '../work-queue/index.js';
import { getPRsForCommit, addLabel } from '../github/rest.js';
import logger from '../logger.js';
import { query, audit } from '../db/client.js';

/**
 * Handle test failures by creating a work item in the configured queue.
 */
export async function handleTestFailure({
  owner,
  repo,
  sha,
  checkName,
  testFailures,
  issueNumber,
  config
}) {
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
    logger.warn({ msg: 'Failed to find linked PR for test failure', repo: repoKey, error: err.message });
    return;
  }

  if (!pr || pr.state !== 'open') {
    logger.info({ msg: 'No open PR for test failure', repo: repoKey });
    return;
  }

  // Get work queue adapter
  const { type: adapterType, ...adapterConfig } = config.work_queue ?? { type: 'github-projects', projectNodeId: config.project_id };
  const adapter = getAdapter(adapterType, adapterConfig);

  // Create work item
  try {
    const workItem = await adapter.createTestFailureItem({
      owner,
      repo,
      issueNumber,
      prNumber: pr.number,
      title: `Tests failed in ${checkName}`,
      description: `${testFailures.failed} test(s) failed, ${testFailures.passed} passed.`,
      testFailures
    });

    logger.info({ msg: 'Created test failure work item', repo: repoKey, issueNumber, itemId: workItem.id });
    audit('test_failure_work_item_created', { repo: repoKey, data: { issueNumber, itemId: workItem.id } });

    // Track attempt
    await query(
      `INSERT INTO test_failures (repo, pr_number, sha, retry_count, test_output, work_item_id)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (repo, pr_number) DO UPDATE
         SET retry_count = test_failures.retry_count + 1, test_output = $4, work_item_id = $5
       RETURNING *`,
      [repoKey, pr.number, sha, JSON.stringify(testFailures), workItem.id]
    );
  } catch (err) {
    logger.error({ msg: 'Failed to create test failure work item', repo: repoKey, error: err.message });
    throw err;
  }
}

/**
 * Handle test success — update work item state to Done.
 */
export async function handleTestSuccess({ owner, repo, sha, issueNumber, config }) {
  const repoKey = `${owner}/${repo}`;

  if (!config) {
    config = await resolveConfig(owner, repo);
  }

  const { type: adapterType, ...adapterConfig } = config.work_queue ?? { type: 'github-projects', projectNodeId: config.project_id };
  const adapter = getAdapter(adapterType, adapterConfig);

  try {
    await adapter.updateWorkItemState({
      issueNumber,
      fromState: 'Test Failures',
      toState: 'Done'
    });

    logger.info({ msg: 'Updated test failure item to Done', repo: repoKey, issueNumber });
    audit('test_failure_resolved', { repo: repoKey, data: { issueNumber } });
  } catch (err) {
    logger.warn({ msg: 'Failed to update test failure item state', error: err.message });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/engine/test-manager.js tests/unit/test-manager.test.js
git commit -m "feat: implement test failure handler using work queue adapter"
```

---

## PHASE 3: Integration

### Task 6: Route Check Runs to Test Manager

**File:** `src/github/check-run-handler.js` (modify)

- [ ] **Step 1: Add test check detection**

```js
function isTestCheckRun(checkRun) {
  return /\b(test|tests|jest|vitest|pytest|mocha|xunit|unittest|rspec)\b/i.test(checkRun.name);
}
```

- [ ] **Step 2: Route test failures to test-manager**

In `handleCheckRunFailure`:
```js
if (isTestCheckRun(checkRun)) {
  const annotations = await getCheckRunAnnotations(owner, repoName, checkRun.id);
  const testFailures = parseCheckAnnotations(annotations);
  
  await handleTestFailure({
    owner,
    repo: repoName,
    sha: checkRun.head_sha,
    checkName: checkRun.name,
    testFailures,
    issueNumber: extractLinkedIssue(pr?.body)
  });
  return;
}
```

- [ ] **Step 3: Handle test success**

In `handleCheckRunSuccess`:
```js
if (isTestCheckRun(checkRun)) {
  await handleTestSuccess({
    owner,
    repo: repoName,
    sha: checkRun.head_sha,
    issueNumber: extractLinkedIssue(pr?.body)
  });
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

- [ ] **Step 5: Write tests and commit**

```bash
git add src/github/check-run-handler.js src/github/rest.js tests/...
git commit -m "feat: route test failures through work queue adapter"
```

---

### Task 7: Config & Verification

**File:** `src/config/schema.js`, `config/defaults.yml` (modify)

- [ ] **Step 1: Add work_queue config schema**

In `schema.js`:
```js
const WorkQueueConfigSchema = z.object({
  type: z.enum(['github-projects', 'linear', 'jira']).default('github-projects'),
  projectNodeId: z.string().optional()  // For GitHub Projects
});

export const DefaultsConfigSchema = z.object({
  work_queue: WorkQueueConfigSchema.optional(),
  // ... rest of schema
});
```

- [ ] **Step 2: Add to defaults.yml**

```yaml
work_queue:
  type: github-projects
  # projectNodeId: PVT_xxx  # Set per-repo in .github/fluent-flow.yml
```

- [ ] **Step 3: Create DB migration**

`src/db/migrations/008_test_failures.sql`:
```sql
CREATE TABLE test_failures (
  id SERIAL PRIMARY KEY,
  repo VARCHAR(255) NOT NULL,
  pr_number INT NOT NULL,
  sha VARCHAR(40),
  retry_count INT DEFAULT 0,
  test_output JSONB,
  work_item_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo, pr_number)
);

CREATE INDEX idx_test_failures_repo_pr ON test_failures(repo, pr_number);
CREATE INDEX idx_test_failures_created ON test_failures(created_at DESC);
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: All tests pass, 322 + ~40 new tests

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.js config/defaults.yml src/db/migrations/008_test_failures.sql
git commit -m "chore: add work queue config and test failures table"
```

---

## Summary

This creates a **pluggable work queue system** where:

✅ Test failures create explicit work items in GitHub Projects (or any adapter)
✅ Agents poll for work via MCP `get_pending_actions` 
✅ Agents see "Test Failures" state items — deterministic work
✅ Tests pass → item moves to "Done" automatically
✅ Designed for future adapters (Linear, Jira, custom systems)

**Code added:**
- `src/work-queue/` — adapter interface + registry
- `src/work-queue/adapters/github-projects.js` — GitHub implementation
- `src/engine/test-manager.js` — test failure handler
- `src/github/test-parser.js` — annotation parser
- Tests: ~50 new test cases

**Code modified:**
- `src/github/check-run-handler.js` — route to test-manager
- `src/config/schema.js` — work queue config
- `config/defaults.yml` — default adapter type

**Total effort:** 3-5 days
**No notifications** — just deterministic state transitions in the project board
