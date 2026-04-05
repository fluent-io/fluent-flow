---
name: Implementation progress as of 2026-04-05
description: Session — worktree pipeline working end-to-end, 427 tests
type: project
---

**Test count:** 370 server + 57 runner = 427 tests, all green.

**Completed this session:**
1. READMEs: root, server, runner (with mermaid diagram, API examples, resilience docs)
2. PR #39: validate repos exist on GitHub before agent creation
3. PR #41: agent-agnostic claim routing (any available agent picks up work)
4. PR #42: deploy script
5. PR #43: runner pr_number field mismatch fix
6. PR #44: runner resilience (backoff, max failures) + worktree spec
7. PR #45: runner worktree management (clone/fetch/worktree-add/cleanup per claim)
8. PR #46: pass branch through notification payload for worktree checkout
9. Fixed review.yml workflow (env block placement + API key)
10. Full pipeline tested end-to-end with worktree isolation:
    - Review fails → claim created with branch → runner picks up → worktree created → Claude runs in worktree → worktree cleaned up → claim reported

**Runner dogfooding status:**
- Agent `ff-runner` registered, token id: 2
- Runner polls, picks up claims, creates worktrees, spawns Claude, cleans up
- Worktree path: `.fluent-flow/repos/{owner}/{repo}/.worktrees/pr-{N}-attempt-{A}/`
- Base clones persist for PR affinity reuse

**Deploy process:**
- Server: `ssh g10 'cd ~/fluent-flow && ./deploy.sh'`
- Runner: `cd packages/fluent-flow-runner && npm link` then restart
- DB: `docker exec fluent-flow-postgres-1 psql -U fluentflow -d fluentflow`

**Pending:**
- Task pipeline: spec → build → fix → test claim types and routing
- Prompt templates per claim_type
- Phase 2: API transport for cloud agents
- Admin UI for human operators
- GitHub App (server-side reviews)
- VS Code extension
