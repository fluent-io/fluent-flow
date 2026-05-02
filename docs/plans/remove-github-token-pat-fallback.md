# Plan: Remove GITHUB_TOKEN PAT Fallback

**Date:** 2026-05-02  
**Status:** Draft  
**Area:** Auth / GitHub API layer

---

## Root Cause Analysis

### The Bug

In `review-manager.js` lines 60 and 66, `getReviews()` and `dismissReview()` are called **without passing the `ctx` argument** (which contains `installation_id`). The call chain:

1. `dispatchReview()` has `owner`, `repo`, `prNumber` in scope
2. It calls `getReviews(owner, repo, prNumber)` — **no `ctx`**
3. `rest.js` → `resolveToken(undefined)` → no `installation_id` → falls back to `process.env.GITHUB_TOKEN`
4. PAT token is used → **401 on repos where the PAT doesn't have access**

The fix is simple: resolve `installationCtxForRepo(owner, repo)` and pass it as the last argument.

### Why the PAT Fallback Exists

The `GITHUB_TOKEN` PAT was the original auth mechanism before the GitHub App migration. `resolveToken()` was designed with a graceful fallback for the transition period. Now that all repos go through the App install flow (`installationCtxForRepo` joins `repos` → `provider_installations`), the PAT fallback is:

- **Silent** — no error, no warning, just a mysterious 401
- **Incorrect** — the PAT represents a user, not the app installation; scoped differently
- **Unnecessary** — every onboarded repo has an `installation_id` in the DB

### Systemic Problem

The PAT fallback pattern is duplicated in **4 files**:

| File | Line | Usage |
|------|------|-------|
| `providers/github/rest.js` | 20 | `resolveToken()` fallback |
| `providers/github/rest.js` | 31 | `githubRequest()` fallback |
| `providers/github/graphql.js` | 19 | `resolveToken()` fallback |
| `workers/outbound.js` | 20 | `resolveToken()` fallback |

And **11 callers** are missing `ctx`:

| File | Function(s) Missing `ctx` |
|------|---------------------------|
| `engine/review-manager.js` | `getReviews`, `dismissReview`, `addLabel` |
| `engine/pause-manager.js` | `addLabel`, `removeLabel`, `postComment` (×2) |
| `engine/state-machine.js` | `postComment` |
| `engine/test-manager.js` | `getPRsForCommit` |
| `notifications/dispatcher.js` | `getLinkedPR`, `getPR` |
| `notifications/transports/workflow.js` | `dispatchWorkflow` |
| `mcp/tools/commands.js` | `getFileExists`, `createFile` |
| `routes/agents.js` | `repoExists` |

---

## All Files That Need Changes

### Immediate Fix (Bug)

| File | Change |
|------|--------|
| `src/engine/review-manager.js` | Pass `ctx` to `getReviews`, `dismissReview`, `addLabel` |

### PAT Fallback Removal (This Plan)

| File | Change |
|------|--------|
| `src/providers/github/rest.js` | Remove `GITHUB_TOKEN` fallback from `resolveToken()` and `githubRequest()`. Throw when no `ctx` / `installation_id`. |
| `src/providers/github/graphql.js` | Remove `GITHUB_TOKEN` fallback from `resolveToken()`. Throw when no `ctx`. |
| `src/workers/outbound.js` | Remove `GITHUB_TOKEN` fallback from `resolveToken()`. Throw when no `installation_id` in queue row. |
| `src/engine/review-manager.js` | Resolve and pass `ctx` to `getReviews`, `dismissReview`, `addLabel` |
| `src/engine/pause-manager.js` | Resolve and pass `ctx` to `addLabel`, `removeLabel`, `postComment` |
| `src/engine/state-machine.js` | Resolve and pass `ctx` to `postComment` |
| `src/engine/test-manager.js` | Pass `ctx` to `getPRsForCommit` |
| `src/notifications/dispatcher.js` | Resolve and pass `ctx` to `getLinkedPR`, `getPR` |
| `src/notifications/transports/workflow.js` | Resolve and pass `ctx` to `dispatchWorkflow` |
| `src/mcp/tools/commands.js` | Resolve and pass `ctx` to `getFileExists`, `createFile` |
| `src/routes/agents.js` | Resolve and pass `ctx` to `repoExists` |

### Test Files

| File | Change |
|------|--------|
| `tests/providers/github/rest.test.js` | Add tests for missing-ctx error |
| `tests/engine/review-manager.test.js` | Verify ctx is passed through |
| New: `tests/providers/github/no-pat-fallback.test.js` | Cross-cutting tests |
| New: `tests/engine/pause-manager-ctx.test.js` | Verify ctx passthrough |
| New: `tests/notifications/dispatcher-ctx.test.js` | Verify ctx passthrough |

### README Files

| File | Change |
|------|--------|
| `packages/fluent-flow/README.md` | Update auth section: remove PAT references |
| `packages/fluent-flow/src/engine/README.md` | Note auth context requirement |
| `packages/fluent-flow/src/providers/github/` (implicit) | Document ctx-first pattern |

---

## TDD Approach — Tests First

### Phase 1: Error-on-Missing-Auth Tests

**Test: `rest.js` rejects calls without installation context**

```js
// tests/providers/github/no-pat-fallback.test.js

describe('resolveToken: no PAT fallback', () => {
  it('throws when ctx is undefined (no installation_id)', async () => {
    await expect(resolveToken(undefined)).rejects.toThrow(/installation_id required/);
  });

  it('throws when ctx has no installation_id', async () => {
    await expect(resolveToken({})).rejects.toThrow(/installation_id required/);
  });

  it('throws when ctx.installation_id is null', async () => {
    await expect(resolveToken({ installation_id: null })).rejects.toThrow(/installation_id required/);
  });

  it('returns installation token when installation_id is provided', async () => {
    const token = await resolveToken({ installation_id: 123 });
    expect(token).toBe('installation-token-xyz');
    expect(getInstallationToken).toHaveBeenCalledWith(123);
  });
});

describe('githubRequest: no PAT fallback', () => {
  it('throws when no token and no GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(githubRequest('/repos/foo/bar')).rejects.toThrow(/auth token required/);
  });
});
```

**Expected behavior:** All GitHub API calls without a valid installation context fail loudly with a clear error message like `"GitHub API call requires installation_id — pass ctx with { installation_id }"`. No silent PAT fallback.

### Phase 2: Caller Context Propagation Tests

**Test: `review-manager.js` passes ctx to all GitHub calls**

```js
it('passes installation context to getReviews and dismissReview', async () => {
  mockGetReviews.mockResolvedValueOnce([
    { id: 99, state: 'CHANGES_REQUESTED', body: '<!-- reviewer-result: {} -->' },
  ]);

  await dispatchReview({ owner: 'fluent-io', repo: 'fluent-flow', prNumber: 42, ref: 'main' });

  expect(mockGetReviews).toHaveBeenCalledWith('fluent-io', 'fluent-flow', 42, expect.objectContaining({ installation_id: 99 }));
  expect(mockDismissReview).toHaveBeenCalledWith('fluent-io', 'fluent-flow', 42, 99, 'Superseded by new review', expect.objectContaining({ installation_id: 99 }));
});
```

**Test: `pause-manager.js` passes ctx to all GitHub calls**

```js
it('passes installation context to addLabel, postComment', async () => {
  // recordPause should resolve ctx via installationCtxForRepo and pass it
  // to addLabel and postComment
});
```

**Test: `dispatcher.js` passes ctx to getLinkedPR and getPR**

```js
it('resolveAgentForIssue passes installation context to GitHub API calls', async () => {
  // Should resolve ctx and pass to getLinkedPR and getPR
});
```

### Phase 3: Outbound Worker Tests

**Test: `outbound.js` throws on missing installation_id**

```js
it('throws when queue row has no installation_id', async () => {
  const row = { installation_id: null, kind: 'comment', payload: {...} };
  await expect(dispatch(row)).rejects.toThrow(/installation_id required/);
});
```

---

## Implementation Steps

### Step 1: Immediate Hotfix — Pass ctx in review-manager.js (PR #1)

**Scope:** Just the review-manager bug fix. Minimal, safe, ships today.

1. In `dispatchReview()`, resolve `installationCtxForRepo(owner, repo)` before the stale-review-dismiss block (line ~57)
2. Pass the resolved `ctx` to `getReviews(owner, repo, prNumber, ctx)` and `dismissReview(owner, repo, prNumber, review.id, 'Superseded by new review', ctx)`
3. In `handleReviewResult()`, resolve ctx and pass to `addLabel(owner, repo, issueNumber, 'needs-human', ctx)` (line ~282)
4. Update existing test to verify ctx passthrough

**Risk:** Low. `installationCtxForRepo` returns `undefined` for unonboarded repos, and the existing `resolveToken` still falls back to PAT — so no regression. But now onboarded repos will use the correct installation token.

### Step 2: Make resolveToken Throw on Missing ctx (PR #2)

**Scope:** Remove the silent fallback. Make auth failures loud.

1. In `rest.js`, change `resolveToken()`:
   ```js
   async function resolveToken(ctx) {
     if (ctx?.installation_id) {
       return getInstallationToken(ctx.installation_id);
     }
     throw new Error('GitHub API call requires installation_id — pass ctx with { installation_id }');
   }
   ```

2. In `rest.js`, change `githubRequest()` to **not** fall back to `GITHUB_TOKEN`:
   ```js
   async function githubRequest(path, options = {}, token) {
     if (!token) {
       throw new Error('GitHub API call requires auth token — no token provided and no PAT fallback');
     }
     // ... rest unchanged
   }
   ```

3. In `graphql.js`, same change to `resolveToken()`

4. In `outbound.js`, same change to `resolveToken()`

5. Add tests from Phase 1 above

6. Run all existing tests — they should pass because mocks provide installation tokens

**Risk:** Medium. Any code path that previously relied on the PAT fallback will now throw. This is **intentional** — we want to surface these.

### Step 3: Fix All Callers Missing ctx (PR #2, same PR as Step 2)

**Scope:** Propagate installation context to every GitHub API call site.

For each caller, the pattern is:
1. Resolve `installationCtxForRepo(owner, repo)` at the top of the function (or receive ctx as parameter)
2. Pass ctx as the last argument to every `rest.js` / `graphql.js` function call

**Detailed changes per file:**

#### `engine/review-manager.js`
- `dispatchReview()`: Already calls `installationCtxForRepo` later for `onClaimDispatched`. **Move it up** before the stale-review block, reuse the result.
- `handleReviewResult()`: Add `installationCtxForRepo(owner, repo)` and pass to `addLabel`.

#### `engine/pause-manager.js`
- `recordPause()`: Add `const ctx = await installationCtxForRepo(owner, repo)` and pass to `addLabel` and `postComment`.
- `processResume()`: Same pattern, pass ctx to `removeLabel` and `postComment`.

#### `engine/state-machine.js`
- `attemptTransitionToDone()`: Add ctx resolution, pass to `postComment`.

#### `engine/test-manager.js`
- `handleTestFailure()`: Needs `ctx` parameter — but it's called from `check-run-handler.js` which already has ctx. **Add `ctx` to the function signature** and pass to `getPRsForCommit`. Update the caller.

#### `notifications/dispatcher.js`
- `resolveAgentForIssue()`: Add `const ctx = await installationCtxForRepo(owner, repo)` and pass to `getLinkedPR` and `getPR`. Note: this function already has `owner`, `repo`, and `config` params.

#### `notifications/transports/workflow.js`
- `send()`: Need installation context. The agent config may have `installation_id` or it can be resolved from the repo. **Add installation_id resolution from the DB** using the repo from payload. Alternative: require agent configs to include `installation_id`.

#### `mcp/tools/commands.js`
- `onboard_repo` tool: The MCP server doesn't inherently have installation context. Options:
  - Require `installation_id` as a parameter to the MCP tool
  - Resolve from DB via `installationCtxForRepo`
  - The second option is cleaner since MCP tools already have `owner/repo`

#### `routes/agents.js`
- `validateRepos()`: Called during agent creation. Need installation context. Since this is a route handler, extract `installation_id` from the DB or require it in the request. Likely use `installationCtxForRepo` for each repo being validated.

### Step 4: Remove GITHUB_TOKEN from Environment (PR #3)

**Scope:** Clean up. After Steps 2-3 are verified in prod.

1. Remove `GITHUB_TOKEN` from `.env`, Docker Compose, and deployment configs
2. Remove `GITHUB_TOKEN` references from documentation
3. Verify no runtime errors in logs

### Step 5: DRY Improvements (Optional, PR #4)

**Scope:** Reduce boilerplate of resolving ctx at every call site.

Options:
1. **Factory pattern:** Create a `createGitHubClient(installation_id)` that returns bound functions that don't need ctx
2. **Async context (AsyncLocalStorage):** Set the installation context at the webhook handler level, auto-resolve in rest.js
3. **Middleware pattern:** Each engine function receives a `ctx` object as first param, passed through the call chain

Recommendation: **Option 1 (factory)** is the simplest and most explicit. Create a helper:

```js
// src/providers/github/client.js
export async function createClient(owner, repo) {
  const ctx = await installationCtxForRepo(owner, repo);
  if (!ctx) throw new Error(`No installation found for ${owner}/${repo}`);
  return {
    getReviews: (owner, repo, prNumber) => rest.getReviews(owner, repo, prNumber, ctx),
    postComment: (owner, repo, issueNumber, body) => rest.postComment(owner, repo, issueNumber, body, ctx),
    // ... etc
  };
}
```

This reduces each call site from:
```js
const ctx = await installationCtxForRepo(owner, repo);
await getReviews(owner, repo, prNumber, ctx);
await dismissReview(owner, repo, prNumber, id, msg, ctx);
```
To:
```js
const client = await createClient(owner, repo);
await client.getReviews(owner, repo, prNumber);
await client.dismissReview(owner, repo, prNumber, id, msg);
```

This is a larger refactor and can be done incrementally after the critical fix.

---

## Validation Steps

### Per-PR Validation

1. **Unit tests pass:** `npx vitest run` in `packages/fluent-flow`
2. **New tests added:** Auth error tests, ctx propagation tests
3. **No regressions:** All existing tests continue to pass
4. **Manual smoke test:**
   - Push to a PR on an onboarded repo
   - Verify `getReviews` and `dismissReview` use installation token (check logs for `getInstallationToken` calls)
   - Verify no 401 errors in logs
5. **Error case test:**
   - Call a GitHub API function for a repo that isn't onboarded
   - Verify it throws with clear error message, not a silent PAT fallback → 401

### Final Validation (After Step 4)

1. Remove `GITHUB_TOKEN` env var from the running service
2. Restart the service
3. Verify all webhook flows still work (PR create, check_run, review dispatch, pause/resume)
4. Verify MCP tools still work (onboard_repo, execute_transition)
5. Check logs for any auth-related errors

---

## Hierarchical README Updates Needed

| README | Update |
|--------|--------|
| `packages/fluent-flow/README.md` | Update auth architecture section — remove PAT references, document installation-token-only flow |
| `packages/fluent-flow/src/engine/README.md` | Add note about auth context requirement for engine functions |
| `packages/fluent-flow/src/providers/github/` (needs README) | Document the ctx-first API contract |

---

## ROADMAP.md Entry

Add to "In Flight" section:

```
| #XX | auth | Remove GITHUB_TOKEN PAT fallback — make installation_id mandatory for all GitHub API calls |
```
