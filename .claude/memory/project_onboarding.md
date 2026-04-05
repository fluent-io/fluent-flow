---
name: Repo onboarding and webhook architecture
description: How repos connect to Fluent Flow — org webhook, config on default branch, onboard_repo MCP tool, workflow split
type: project
---

Fluent Flow uses an org-level GitHub webhook (not a GitHub App) + a PAT for API access. The webhook covers all repos in the org automatically.

**Config must be on the default branch.** `.github/fluent-flow.yml` is fetched from the default branch by the config loader. If it only exists on a feature branch, Fluent Flow falls back to global defaults.

**Workflow architecture:**
- `review.yml` — reusable workflow in fluent-flow repo (the engine, `workflow_call`)
- `pr-review.yml` — thin caller in each client repo (`workflow_dispatch`, passes secrets explicitly)
- Split needed because dual triggers in one file broke org secret access

**`onboard_repo` MCP tool** (PR #11) — creates `.github/fluent-flow.yml` and `.github/workflows/pr-review.yml` on the default branch. Won't work on repos with branch protection — need to PR instead. The caller workflow references `review.yml` (not the old `pr-review.yml` name).

**Onboarded repos:**
- `fluent-io/fluent-flow` — default_agent: claude-code, trigger_check: test
- `fluent-io/fluent-hive` — default_agent: claude-code (needs pr-review.yml updated to reference review.yml, and trigger_check added)

**How to apply:** When onboarding a new repo, use the MCP tool or PR the config files. Always set `trigger_check` for production repos.
