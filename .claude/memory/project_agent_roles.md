---
name: Agent role design direction
description: Agent roles (spec, build, fix, test) are separate from agent_type (claude-code, codex, aider)
type: project
---

Two distinct concepts:
- **agent_type** — the AI tool/harness: `claude-code`, `codex`, `devin`, `aider`, `custom`
- **agent role** — what kind of work: spec, build, fix, test

A claude-code agent could be a fix agent or a spec agent. Roles define behavior:
- **Spec agents** — create specs and plans in `docs/specs/` and `docs/plans/`
- **Build agents** — implement code following spec/plan docs
- **Fix agents** — fix PR review findings, create tests (including e2e) for findings
- **Test agents** — validate fix agent findings

All agents create a worktree per claim and clean up after themselves.

Existing `claim_type` field on `agent_claims` (`review_fix`, `issue_work`) may be the right place to route work to the correct role.

**How to apply:** Runner worktree management is prerequisite. Then role determines prompt template and working behavior. Spec before implementing.
