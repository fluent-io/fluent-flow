# Runner Worktree Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Runner creates a git worktree per claim so agents work in an isolated checkout on the PR branch, not in the runner's main directory.

**Architecture:** New `src/worktree.js` module handles clone/fetch/worktree-add/cleanup. `runner.js` calls it in `handleWork` before spawning the agent, sets `cwd` to the worktree path, and cleans up after. Directory structure: `.fluent-flow/repos/{owner}/{repo}/` for base clones, `.worktrees/pr-{N}-attempt-{A}/` for ephemeral worktrees.

**Tech Stack:** Node.js, ESM, `node:child_process` (execFile for git commands), Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| Create: `packages/fluent-flow-runner/src/worktree.js` | Clone repo, fetch, create worktree, cleanup worktree |
| Modify: `packages/fluent-flow-runner/src/runner.js` | Call worktree manager in `handleWork`, pass worktree path as `cwd` |
| Create: `packages/fluent-flow-runner/tests/unit/worktree.test.js` | Unit tests for worktree module |
| Modify: `packages/fluent-flow-runner/tests/unit/runner.test.js` | Tests for worktree integration in handleWork |

---

### Task 1: Create worktree module — `prepareWorktree`

**Files:**
- Create: `packages/fluent-flow-runner/src/worktree.js`
- Create: `packages/fluent-flow-runner/tests/unit/worktree.test.js`

- [ ] **Step 1: Write failing test — prepareWorktree clones and creates worktree**

Create `packages/fluent-flow-runner/tests/unit/worktree.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  mkdirSync: (...args) => mockMkdirSync(...args),
}));

const { prepareWorktree } = await import('../../src/worktree.js');

describe('worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (typeof opts === 'function') { opts(null, '', ''); return; }
      cb(null, '', '');
    });
  });

  describe('prepareWorktree', () => {
    it('clones repo when base clone does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'git', ['clone', 'https://github.com/fluent-io/fluent-flow.git', expect.stringContaining('fluent-flow')],
        expect.anything(),
        expect.any(Function)
      );
    });

    it('skips clone when base clone exists', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'clone');
      expect(cloneCalls).toHaveLength(0);
    });

    it('fetches latest before creating worktree', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const fetchCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'fetch');
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('creates worktree and returns path + cleanup function', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      const result = await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      expect(result.worktreePath).toContain('pr-40-attempt-1');
      expect(typeof result.cleanup).toBe('function');

      const worktreeCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'worktree' && c[1][1] === 'add');
      expect(worktreeCalls).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/worktree.test.js`
Expected: FAIL — `prepareWorktree` is not exported

- [ ] **Step 3: Implement `prepareWorktree`**

Create `packages/fluent-flow-runner/src/worktree.js`:

```js
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Promisified execFile.
 */
function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Prepare a git worktree for a claim.
 * Clones the repo if not already cloned, fetches latest, creates a worktree on the PR branch.
 *
 * @param {object} opts
 * @param {string} opts.workDir — base working directory (cwd or --cwd flag)
 * @param {string} opts.repo — "owner/repo"
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {string} opts.branch — PR branch name
 * @returns {Promise<{ worktreePath: string, cleanup: () => Promise<void> }>}
 */
export async function prepareWorktree({ workDir, repo, prNumber, attempt, branch }) {
  const [owner, name] = repo.split('/');
  const baseDir = join(workDir, '.fluent-flow', 'repos', owner, name);
  const worktreeName = `pr-${prNumber}-attempt-${attempt}`;
  const worktreePath = join(baseDir, '.worktrees', worktreeName);

  // 1. Clone if base repo doesn't exist
  if (!existsSync(join(baseDir, '.git'))) {
    mkdirSync(baseDir, { recursive: true });
    await exec('git', ['clone', `https://github.com/${repo}.git`, baseDir]);
  }

  // 2. Fetch latest
  await exec('git', ['fetch', 'origin'], { cwd: baseDir });

  // 3. Create worktree
  mkdirSync(join(baseDir, '.worktrees'), { recursive: true });
  await exec('git', ['worktree', 'add', worktreePath, `origin/${branch}`], { cwd: baseDir });

  // 4. Return path and cleanup function
  return {
    worktreePath,
    cleanup: async () => {
      try {
        await exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: baseDir });
      } catch {
        // Best effort — worktree may already be removed
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/worktree.test.js`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow-runner/src/worktree.js packages/fluent-flow-runner/tests/unit/worktree.test.js
git commit -m "feat: add worktree module for isolated claim execution"
```

---

### Task 2: Add cleanup test

**Files:**
- Modify: `packages/fluent-flow-runner/tests/unit/worktree.test.js`

- [ ] **Step 1: Write failing test — cleanup removes worktree**

Add to the `describe('prepareWorktree')` block in `worktree.test.js`:

```js
  it('cleanup removes the worktree', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p.endsWith('.git')) return true;
      return false;
    });

    const { cleanup } = await prepareWorktree({
      workDir: '/work',
      repo: 'fluent-io/fluent-flow',
      prNumber: 40,
      attempt: 1,
      branch: 'fix/something',
    });

    await cleanup();

    const removeCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'worktree' && c[1][1] === 'remove');
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][1]).toContain('pr-40-attempt-1');
  });

  it('cleanup does not throw if worktree already removed', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p.endsWith('.git')) return true;
      return false;
    });

    const { cleanup } = await prepareWorktree({
      workDir: '/work',
      repo: 'fluent-io/fluent-flow',
      prNumber: 40,
      attempt: 1,
      branch: 'fix/something',
    });

    // Make the remove call fail
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (typeof opts === 'function') { opts(new Error('not a worktree')); return; }
      cb(new Error('not a worktree'));
    });

    await expect(cleanup()).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/worktree.test.js`
Expected: PASS — cleanup tests should pass since implementation already handles this

- [ ] **Step 3: Commit**

```bash
git add packages/fluent-flow-runner/tests/unit/worktree.test.js
git commit -m "test: add worktree cleanup tests"
```

---

### Task 3: Integrate worktree into runner `handleWork`

**Files:**
- Modify: `packages/fluent-flow-runner/src/runner.js`
- Modify: `packages/fluent-flow-runner/tests/unit/runner.test.js`

- [ ] **Step 1: Write failing test — handleWork uses worktree when repo and branch are provided**

Add to `packages/fluent-flow-runner/tests/unit/runner.test.js`. First add the mock at the top with the other mocks:

```js
const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({
  prepareWorktree: (...args) => mockPrepareWorktree(...args),
}));
```

Then add the test:

```js
  describe('worktree integration', () => {
    it('creates worktree and runs agent in worktree cwd', async () => {
      const mockCleanup = vi.fn().mockResolvedValue();
      mockPrepareWorktree.mockResolvedValueOnce({
        worktreePath: '/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/pr-40-attempt-1',
        cleanup: mockCleanup,
      });
      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix the bug',
            repo: 'fluent-io/fluent-flow',
            pr_number: 40,
            attempt: 1,
            branch: 'fix/something',
            agentType: 'claude-code',
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockPrepareWorktree).toHaveBeenCalledWith(expect.objectContaining({
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      }));

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2].cwd).toBe('/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/pr-40-attempt-1');

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('cleans up worktree even if agent fails', async () => {
      const mockCleanup = vi.fn().mockResolvedValue();
      mockPrepareWorktree.mockResolvedValueOnce({
        worktreePath: '/work/.fluent-flow/repos/o/r/.worktrees/pr-1-attempt-1',
        cleanup: mockCleanup,
      });
      mockSpawn.mockReturnValueOnce(fakeProcess(1));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix', repo: 'o/r', pr_number: 1, attempt: 1, branch: 'fix/x', agentType: 'claude-code',
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('skips worktree when branch is not provided', async () => {
      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix', repo: 'o/r', pr_number: 1, attempt: 1, agentType: 'claude-code',
            // no branch field
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockPrepareWorktree).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner.test.js`
Expected: FAIL — `handleWork` doesn't call `prepareWorktree`

- [ ] **Step 3: Update `handleWork` to use worktree**

In `packages/fluent-flow-runner/src/runner.js`, add import at the top:

```js
import { prepareWorktree } from './worktree.js';
```

Replace the `handleWork` function:

```js
  async function handleWork(work) {
    activeWork = work;
    const { message, repo, attempt } = work;
    const prNumber = work.prNumber ?? work.pr_number;
    const branch = work.branch;

    log.info('Work received', { repo, prNumber, attempt, branch, event: work.event });

    let cmd;
    try {
      cmd = resolveCommand({
        agentType: work.agentType ?? 'claude-code',
        prompt: message,
        transportCommand: work.transportCommand,
      });
    } catch (err) {
      log.error('Failed to resolve command', { error: err.message });
      await client.reportClaim({ status: 'failed', repo, pr_number: prNumber, attempt });
      activeWork = null;
      return;
    }

    // Prepare worktree if branch is provided
    let worktreeCleanup = null;
    let agentCwd = cwd ?? process.cwd();
    if (branch && repo) {
      try {
        const wt = await prepareWorktree({
          workDir: cwd ?? process.cwd(),
          repo,
          prNumber,
          attempt,
          branch,
        });
        agentCwd = wt.worktreePath;
        worktreeCleanup = wt.cleanup;
        log.info('Worktree ready', { worktreePath: agentCwd });
      } catch (err) {
        log.error('Failed to prepare worktree', { error: err.message });
        await client.reportClaim({ status: 'failed', repo, pr_number: prNumber, attempt });
        activeWork = null;
        return;
      }
    }

    let exitCode;
    try {
      exitCode = await execute(cmd, agentCwd);
    } catch (err) {
      log.error('Agent process error', { error: err.message });
      exitCode = 1;
    }

    // Always clean up worktree
    if (worktreeCleanup) {
      try {
        await worktreeCleanup();
        log.info('Worktree cleaned up');
      } catch (err) {
        log.warn('Failed to clean up worktree', { error: err.message });
      }
    }

    const status = exitCode === 0 ? 'completed' : 'failed';
    log.info('Agent finished', { repo, prNumber, attempt, exitCode, status });

    try {
      await client.reportClaim({ status, repo, pr_number: prNumber, attempt });
    } catch (err) {
      log.error('Failed to report claim', { error: err.message });
    }

    activeWork = null;
  }
```

Also update the `execute` function to accept a `cwdOverride` parameter:

```js
  function execute(cmd, cwdOverride) {
    return new Promise((resolve, reject) => {
      log.info('Executing agent command', { command: cmd.shell ?? cmd.bin });

      const baseOpts = { cwd: cwdOverride ?? cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] };

      const proc = cmd.shell
        ? spawn(cmd.shell, [], {
            ...baseOpts,
            shell: true,
            env: buildIsolatedEnv(cmd.env),
          })
        : spawn(cmd.bin, cmd.args, { ...baseOpts, shell: false });

      activeProcess = proc;

      proc.stdout.on('data', (data) => {
        log.debug('agent:stdout', { data: data.toString().trimEnd() });
      });

      proc.stderr.on('data', (data) => {
        log.debug('agent:stderr', { data: data.toString().trimEnd() });
      });

      proc.on('close', (code) => {
        activeProcess = null;
        resolve(code ?? 1);
      });

      proc.on('error', (err) => {
        activeProcess = null;
        reject(err);
      });
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner.test.js`
Expected: PASS — all tests including new worktree integration tests

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow-runner/src/runner.js packages/fluent-flow-runner/tests/unit/runner.test.js
git commit -m "feat: integrate worktree into runner handleWork"
```

---

### Task 4: Server sends branch in claim payload

**Files:**
- Modify: `packages/fluent-flow/src/engine/review-manager.js`
- Modify: `packages/fluent-flow/src/routes/runner.js`
- Modify: `packages/fluent-flow/tests/unit/review-manager.test.js`

- [ ] **Step 1: Write failing test — claim payload includes branch**

Add to `packages/fluent-flow/tests/unit/review-manager.test.js` in the `claim integration` describe block:

```js
  it('includes branch in claim payload', async () => {
    query.mockResolvedValueOnce({ rows: [makeRetryRecord({ retry_count: 1 })] });
    query.mockResolvedValue({ rows: [] });
    createClaim.mockResolvedValueOnce({ id: 1 });

    await handleReviewResult({
      ...baseOpts,
      result: { status: 'FAIL', blocking: [{ file: 'x.js', line: 1, issue: 'bug' }], advisory: [], attempt: 1 },
      headBranch: 'fix/something',
    });

    expect(createClaim).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ branch: 'fix/something' }),
    }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/review-manager.test.js -t "includes branch"`
Expected: FAIL — `handleReviewResult` doesn't pass `branch` in payload

- [ ] **Step 3: Update `handleReviewResult` to include branch**

In `packages/fluent-flow/src/engine/review-manager.js`, update the `createClaim` call to include `branch` in the payload:

Find the `createClaim` call in the FAIL path and add `branch` to the payload object:

```js
    await createClaim({
      orgId: config.org_id ?? 'self-hosted',
      repo: repoKey,
      prNumber,
      attempt,
      agentId: explicitAgent,
      payload: {
        message: formatRichMessage({ repo: repoKey, prNumber, attempt, blocking, advisory }),
        issues: allIssues,
        onFailure: config.reviewer?.on_failure,
        branch: headBranch,
      },
    });
```

Also update the function signature to accept `headBranch`:

Find `export async function handleReviewResult({` and add `headBranch` to the destructured params.

- [ ] **Step 4: Update webhook handler to pass headBranch**

In `packages/fluent-flow/src/routes/webhook.js`, the `handlePullRequestReview` function calls `handleReviewResult`. Update the call to pass `headBranch: pr.head.ref`:

```js
      await handleReviewResult({
        owner,
        repo,
        prNumber,
        issueNumber,
        result,
        reviewSha: pr.head.sha,
        agentId,
        headBranch: pr.head.ref,
      });
```

Also update the `/api/review/result` route in `packages/fluent-flow/src/routes/review.js` to pass `headBranch` if available in the request body.

- [ ] **Step 5: Update poll handler to include branch in work payload**

In `packages/fluent-flow/src/routes/runner.js`, the `claimPendingWork` return already includes the full payload. The `branch` field will flow through from the claim payload. Verify the work response construction spreads the payload:

```js
      respond({
        work: {
          repo: pendingClaim.repo,
          pr_number: pendingClaim.pr_number,
          attempt: pendingClaim.attempt,
          claim_id: pendingClaim.id,
          ...payload,  // branch is inside payload
        },
      });
```

This already works — `branch` is in the payload object which gets spread into the work response.

- [ ] **Step 6: Run tests to verify**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/review-manager.test.js`
Expected: PASS

Run: `cd packages/fluent-flow && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/fluent-flow/src/engine/review-manager.js packages/fluent-flow/src/routes/webhook.js packages/fluent-flow/src/routes/review.js packages/fluent-flow/tests/unit/review-manager.test.js
git commit -m "feat: include PR branch in claim payload for worktree checkout"
```

---

### Task 5: Full verification and PR

- [ ] **Step 1: Run all server tests**

```bash
cd packages/fluent-flow && npx vitest run
```

Expected: All tests pass

- [ ] **Step 2: Run all runner tests**

```bash
cd packages/fluent-flow-runner && npx vitest run
```

Expected: All tests pass (except pre-existing cli.test.js syntax error)

- [ ] **Step 3: Commit plan**

```bash
git add docs/plans/2026-04-05-runner-worktree-plan.md
git commit -m "docs: add runner worktree implementation plan"
```

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin feat/runner-worktree
gh pr create --title "feat: runner worktree management" --body "## Summary
- Runner creates git worktrees per claim — agents work in isolated PR branch checkouts
- Worktrees cleaned up after agent exits (success or failure)
- Base clones persist for PR affinity reuse
- Server includes PR branch name in claim payload
- Falls back to cwd when branch not provided

Spec: docs/specs/2026-04-05-runner-worktree-task-pipeline.md
Plan: docs/plans/2026-04-05-runner-worktree-plan.md

## Test plan
- [ ] Worktree: clone, skip-clone, fetch, create, cleanup, error handling
- [ ] Runner: worktree integration, cleanup on failure, skip when no branch
- [ ] Server: branch in claim payload
- [ ] Full test suites pass"
```
