# Fluent Flow Memory Index

- [user_victor.md](user_victor.md) — Victor's role, workflow style, and relationship to getonit agent
- [project_vision.md](project_vision.md) — Product framing: deterministic quality gate, MCP + webhook dual interface, agent-agnostic
- [project_agent_roles.md](project_agent_roles.md) — Agent roles: spec, build, fix, test — each with distinct worktree behavior
- [project_onboarding.md](project_onboarding.md) — Repo onboarding: org webhook, config on default branch, onboard_repo tool, trigger_check
- [project_ci_gated_reviews.md](project_ci_gated_reviews.md) — CI-gated dispatch, trigger_check, auto-dismiss, dogfooding
- [project_logging.md](project_logging.md) — Pino structured logging: timestamps, LOG_LEVEL, SigNoz-ready
- [project_bugs.md](project_bugs.md) — Three bugs found and fixed in commit 23883ff
- [project_pause_enforcement.md](project_pause_enforcement.md) — PR #8: stale retry cleanup on PR close + pause enforcement
- [project_dispatch_dedup.md](project_dispatch_dedup.md) — Race condition fix: atomic claimDispatch prevents duplicate review dispatches
- [session_progress.md](session_progress.md) — Latest session: full pipeline tested, runner worktree + agent roles next
- [feedback_tdd_workflow.md](feedback_tdd_workflow.md) — TDD preferences: Red/Green/Refactor with breaking-change verification
- [feedback_pr_approval.md](feedback_pr_approval.md) — Never create PRs or branches without explicit approval first
- [feedback_no_subagents.md](feedback_no_subagents.md) — No subagent execution: crashes machine, always use inline
- [reference_deployment.md](reference_deployment.md) — Deployment URLs, MCP endpoint, OpenClaw setup tasks
- [reference_fluent_hive.md](reference_fluent_hive.md) — fluent-hive repo: Next.js monorepo using Fluent Flow for reviews
