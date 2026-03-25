# VS Code Extension for Fluent Flow

## Problem

Claude Code has no way to automatically receive and act on review feedback. The review posts on the PR, but Claude Code is an interactive CLI — not a long-running server that can receive webhooks.

## Solution

A VS Code extension that bridges Fluent Flow and Claude Code:

1. **Background polling** — polls `get_pending_actions` (MCP or REST API) on an interval
2. **Native notifications** — shows VS Code notifications when reviews fail, pauses need attention, or resumes arrive
3. **One-click fix** — sends review feedback + diff context to Claude Code, which fixes issues and pushes
4. **State sidebar** — shows which issues are in which state, what's paused, what's awaiting human

## User flow

```
PR opened → Fluent Flow reviews → extension shows "3 blocking issues on PR #5"
→ click "Fix" → Claude Code gets the issues + diff context → pushes fixes
→ Fluent Flow re-reviews after CI passes (check_run.completed) → pass → auto-merge
```

## Architecture

```
VS Code Extension
├── Polling service (background, configurable interval)
│   └── Calls GET /api/review/retries/:owner/:repo/:pr or MCP get_pending_actions
├── Notification provider
│   └── VS Code notification API with action buttons
├── Sidebar view (TreeDataProvider)
│   └── Issues grouped by state (In Progress, In Review, Awaiting Human)
└── Claude Code integration
    └── Sends structured prompt with review feedback to Claude Code CLI
```

## Configuration

```json
{
  "fluentFlow.url": "https://flow.getonit.io",
  "fluentFlow.token": "",
  "fluentFlow.agentId": "claude-code",
  "fluentFlow.pollInterval": 30000
}
```

## Open questions

- Should the extension use MCP protocol directly or REST API?
- How to integrate with Claude Code — CLI invocation, VS Code extension API, or shared MCP server?
- Should it support multiple repos simultaneously?
- Notification granularity — per-issue or batched summary?
