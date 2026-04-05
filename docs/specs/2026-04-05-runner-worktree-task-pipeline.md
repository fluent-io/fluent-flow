# Runner Worktree Management + Task Pipeline

## Problem

The runner spawns agents without repo context. The agent runs in whatever directory the runner started in, with no access to the PR branch. It can't find files to fix, doesn't know which branch to push to, and leaves no clean state for the next task.

Additionally, the system only handles one task type (`review_fix`). The broader pipeline — spec, build, fix, test — has no routing or prompt differentiation.

## Design

### Worktree Lifecycle

When the runner picks up a claim, it prepares a worktree before spawning the agent:

1. Resolve the work directory: `--cwd` flag or process cwd
2. Create `.fluent-flow/repos/{owner}/{repo}/` if no base clone exists
3. `git clone` the repo into the base directory (skip if already cloned)
4. `git fetch origin` to get latest refs
5. `git worktree add .worktrees/pr-{prNumber}-attempt-{attempt} origin/{branch}` to create an isolated checkout on the PR branch
6. Set `cwd` to the worktree path, spawn the agent
7. After the agent exits (success or failure), `git worktree remove` the worktree directory
8. Keep the base clone for PR affinity reuse across claims

Directory structure:

```
.fluent-flow/
  repos/
    fluent-io/
      fluent-flow/                        ← base clone (persistent)
        .worktrees/
          pr-40-attempt-3/                ← worktree (ephemeral, per claim)
```

The base clone is never modified directly. All agent work happens in worktrees. Worktrees are always cleaned up after the agent exits, regardless of success or failure.

### Git Authentication

The runner needs to clone and fetch repos. Authentication uses the same mechanism the agent would use to push — typically SSH keys or a Git credential helper already configured on the machine. The runner does not manage Git credentials.

### Task Types

Extend `claim_type` to represent pipeline stages. Each claim type has a distinct prompt template that tells the agent what to do.

| claim_type | Trigger | Agent behavior |
|---|---|---|
| `spec` | Manual via admin UI or MCP tool | Create spec and plan files in `docs/specs/` and `docs/plans/` |
| `build` | Automatic after spec is marked complete | Implement code following the spec/plan docs |
| `review_fix` | Automatic on review failure (existing) | Fix PR review findings, add tests for those findings including e2e tests |
| `test_verify` | Automatic after fix agent pushes and CI passes | Scan tests, verify they cover the review findings, validate correctness |

### Task Pipeline

The task types form a state machine. Each stage triggers the next:

```
spec (manual trigger)
  ↓
build (auto after spec complete)
  ↓
PR pushed → CI runs
  ↓
CI passes → automated review
  ↓
PASS → auto-merge
FAIL → review_fix claim created
  ↓
fix agent pushes → CI runs
  ↓
CI passes → test_verify claim created
  ↓
test agent verifies → triggers re-review
  ↓
PASS → auto-merge
FAIL → back to review_fix (up to max retries → escalate to human)
```

### Prompt Templates

Each `claim_type` maps to a prompt template. The runner resolves the template based on `claim_type` from the claim payload. The `agent_type` (claude-code, codex, aider) determines which binary to spawn — it does not affect the prompt.

Templates include:
- The claim payload (review feedback, spec requirements, test context)
- The repo and PR context (owner, repo, PR number, branch)
- Role-specific instructions (e.g. "only modify files in docs/" for spec agents)

Templates are defined in the runner package, not the server. The server sends the claim type and payload; the runner decides how to prompt the agent.

### Server Changes

#### New claim type triggers

**`test_verify`**: The `check-run-handler.js` already detects test check runs via `isTestCheckRun()` and has `handleTestSuccess()`/`handleTestFailure()`. After a fix agent pushes and CI passes, create a `test_verify` claim instead of immediately dispatching a re-review. The re-review happens after the test agent completes.

**`spec` and `build`**: Triggered via MCP tools or Admin API. The server creates claims with `claim_type: 'spec'` or `claim_type: 'build'`. No webhook trigger — these are manual or follow-on. When a `spec` claim completes successfully (agent reports `completed`), the server automatically creates a `build` claim for the same repo and PR.

#### Claim type in poll handler

The `claimPendingWork` query already returns `claim_type` in the claim payload. No changes needed — the runner receives the claim type and routes accordingly.

### Runner Changes

#### Worktree manager

New module: `src/worktree.js`

```
prepareWorktree({ workDir, repo, prNumber, attempt, branch })
  → { worktreePath, cleanup }

cleanup()
  → git worktree remove, delete directory
```

#### Prompt resolver

New module: `src/prompts.js`

Maps `claim_type` to a prompt template. Takes the claim payload and returns the formatted prompt string passed to the agent binary.

#### Updated run loop

```
poll → receive claim
  → prepareWorktree (clone/fetch/worktree add)
  → resolvePrompt (claim_type → template → formatted prompt)
  → resolveCommand (agent_type → binary)
  → spawn agent with cwd = worktree path
  → agent exits
  → cleanup worktree
  → report claim result
  → resume polling
```

### Database Changes

None. `claim_type` is already a TEXT field on `agent_claims`. No migration needed.

### What Stays the Same

- Agent registration, tokens, sessions, polling — unchanged
- `agent_type` meaning — the tool/harness (claude-code, codex, aider), not the role
- Agent-agnostic routing — any available runner picks up any claim type
- PR body marker override — still works
- Claim lifecycle (pending → claimed → completed/failed/expired) — unchanged

### Interaction with GitHub App (future)

When the GitHub App replaces PAT-based auth, the server performs reviews server-side. The task pipeline and worktree management are runner-side concerns — unaffected by how reviews are triggered.

### Interaction with Admin UI (future)

The Admin UI will expose:
- Manual spec trigger (create `spec` claim for a repo)
- Pipeline status view (which stage each PR is in)
- Claim history and agent activity

## Verification

1. Runner picks up a `review_fix` claim, creates worktree on PR branch, agent runs in worktree, worktree cleaned up after
2. Runner picks up a second claim for the same repo — reuses base clone, creates new worktree
3. Agent exits with failure — worktree is still cleaned up
4. Runner restart — base clone persists, new worktrees created for new claims
5. `test_verify` claim created after fix push + CI pass
6. Test agent runs in worktree, scans tests, reports result
7. After test_verify completes, re-review is triggered
8. `spec` claim created via MCP tool, agent creates docs in worktree
9. After spec complete, `build` claim auto-created
