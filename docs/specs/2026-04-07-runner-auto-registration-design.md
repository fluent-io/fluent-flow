# Runner Auto-Registration Design

## Problem

Launching the runner locally requires 3 manual steps: register agent (curl), generate token (curl), copy/paste token to CLI. Tokens are only shown once — if lost, a new one must be generated. No credential persistence exists.

## Design

### Credentials File

`~/.fluent-flow/credentials.json` stores agent tokens keyed by agent ID:

```json
{
  "agents": {
    "ff-runner": {
      "server": "http://flow.fluenthive.io",
      "token": "ff_5d9a1bbab...",
      "agent_type": "claude-code",
      "created_at": "2026-04-07T12:00:00Z"
    },
    "hive-runner": {
      "server": "http://flow.fluenthive.io",
      "token": "ff_abc123...",
      "agent_type": "claude-code",
      "created_at": "2026-04-07T14:00:00Z"
    }
  },
  "default_agent": "ff-runner"
}
```

### CLI Changes

**New flags:**
- `--agent` (optional) — agent ID to use. If omitted, uses `default_agent` from credentials file
- `--mcp-auth-token` (optional) — bootstrap token for first-run registration. Also reads from `MCP_AUTH_TOKEN` env var

**Modified flags:**
- `--token` becomes optional (backward compat — if provided, used directly, skips credential lookup)

**Priority:**
1. `--token` provided → use directly (backward compat, no credentials file needed)
2. No `--token` → load credentials for `--agent` (or `default_agent`)
3. No credentials found → bootstrap with MCP_AUTH_TOKEN

### Bootstrap Flow

On first run (no saved credentials for the agent):

1. Read MCP_AUTH_TOKEN from `--mcp-auth-token` flag or `MCP_AUTH_TOKEN` env var
2. Call `POST /api/agents` with `{ id: agentId, agent_type: "claude-code", transport: "long_poll" }` — if agent already exists, this is a no-op (idempotent)
3. Call `POST /api/agents/{agentId}/tokens` with `{ label: "auto-{hostname}" }` to generate a token
4. Save credentials to `~/.fluent-flow/credentials.json`
5. Start polling with the new token

Subsequent runs skip steps 2-4 and use the saved token directly.

### Files to Create/Modify

| File | Action | Responsibility |
|---|---|---|
| `packages/fluent-flow-runner/src/credentials.js` | Create | Read/write credentials file, lookup by agent ID |
| `packages/fluent-flow-runner/tests/unit/credentials.test.js` | Create | Tests for credentials module |
| `packages/fluent-flow-runner/src/bootstrap.js` | Create | Auto-register agent + generate token using MCP_AUTH_TOKEN |
| `packages/fluent-flow-runner/tests/unit/bootstrap.test.js` | Create | Tests for bootstrap flow |
| `packages/fluent-flow-runner/bin/fluent-flow-runner.js` | Modify | Add --agent, --mcp-auth-token flags, integrate credential lookup |
| `packages/fluent-flow-runner/src/client.js` | Modify | Add admin API methods (registerAgent, generateToken) |

### Agent Type Default

When bootstrapping, `agent_type` defaults to `claude-code`. This can be overridden with a future `--agent-type` flag if needed, but YAGNI for now.

### Verification

1. First run with `--agent ff-runner --server http://flow.fluenthive.io` and `MCP_AUTH_TOKEN` in env → credentials file created, runner starts polling
2. Second run with `--agent ff-runner --server http://flow.fluenthive.io` (no MCP_AUTH_TOKEN) → reads saved token, starts polling
3. Run with `--token ff_... --server http://flow.fluenthive.io` → backward compat, no credentials file touched
4. Run with `--agent hive-runner --server http://flow.fluenthive.io` → second agent bootstrapped and saved alongside first
