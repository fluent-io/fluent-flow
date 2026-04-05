---
name: Fluent Flow product vision
description: Product framing — commercial quality gate for AI agents, multi-agent orchestration, MCP + webhook dual interface, admin UI planned
type: project
---

**What:** Config-driven GitHub workflow orchestrator. Deterministic state machine manages the review→fix loop for AI coding agents. Agents only read/write code — they never decide what step comes next.

**The loop:** PR pushed → automated review (Claude) → FAIL: agent notified with issues → agent pushes fix → re-review → repeat up to N times → escalate to human if still failing → PASS: auto-merge.

**Agent interface:** Two protocols:
- **MCP** (primary for AI agents) — Claude Code, Cursor connect natively. Agents poll `get_pending_actions` for work.
- **Webhook** (push for non-MCP agents) — OpenClaw, legacy agents. HTTP POST to agent's URL.
- Both route notifications to the specific agent that created the PR via `<!-- fluent-flow-agent: id -->` marker.

**Commercial direction:** Victor plans to sell Fluent Flow as a product companies integrate into their dev pipelines. Human developers and operators need to configure repos through an admin UI — not just YAML files.

**Why:** Target customers are companies, not just individual developers. Self-service config is essential for adoption.

**How to apply:** Features should support both agent-agnostic orchestration AND human operator experience. Admin UI is a key product surface.

**Deployed at:** flow.getonit.io (Docker, Postgres, port 3847)

**Open source:** MIT license, fluent-io/fluent-flow. Branch protection on main.
