# MCP Server

Model Context Protocol server for AI agent integration. Mounts on the existing Express app at `POST /mcp` using Streamable HTTP transport (stateless).

## Architecture

```
handler.js    — Express route handler, creates stateless transport per request
server.js     — McpServer factory, registers all tools
auth.js       — Bearer token middleware (MCP_AUTH_TOKEN env var)
tools/
  queries.js  — Read-only tools wrapping engine query functions
  commands.js — Write tools wrapping engine command functions
  pending.js  — get_pending_actions (the key polling query)
```

Each tool wraps an existing engine function — no duplicated logic. All tool calls are logged via `audit()`.

## Tools

### Query tools

| Tool | Wraps | Purpose |
|------|-------|---------|
| `get_pending_actions` | Custom SQL query | Poll for review failures, pauses, resumes assigned to this agent |
| `get_current_state` | `getCurrentState()` | Issue workflow state |
| `get_transition_history` | `getTransitionHistory()` | Full audit trail |
| `get_retry_record` | `getRetryRecord()` | PR review retry status |
| `get_active_pause` | `getActivePause()` | Current pause details |
| `get_config` | `resolveConfig()` | Repo configuration |

### Command tools

| Tool | Wraps | Purpose |
|------|-------|---------|
| `execute_transition` | `executeTransition()` | Move issue between states (validates rules) |
| `dispatch_review` | `dispatchReview()` | Trigger automated code review |
| `record_pause` | `recordPause()` | Pause issue for human attention |
| `process_resume` | `processResume()` | Resume paused issue |

All tools require `agent_id`. Command tools use `triggerType: 'mcp'` for audit trail differentiation.

## `get_pending_actions`

The key tool that replaces push notifications. Queries three sources:

1. **Review failures** — `review_retries` where agent is default for the repo (via config_cache)
2. **Active pauses** — `pauses` where `resumed_at IS NULL` and `agent_id` matches
3. **Unacknowledged resumes** — `pauses` where resumed with instructions but `resume_acknowledged_at IS NULL`

Resumed items are auto-acknowledged on query (idempotent polling).

## Connection

```bash
claude mcp add --transport http fluent-flow https://flow.getonit.io/mcp \
  --header "Authorization: Bearer $FLUENT_FLOW_MCP_TOKEN"
```

## Auth

Set `MCP_AUTH_TOKEN` env var. If not set, endpoint accepts unauthenticated requests (dev mode).
