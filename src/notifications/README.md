# Notifications

Agent-agnostic notification dispatcher. Routes wake notifications to the correct agent via pluggable transports.

## Architecture

```
dispatcher.js       — resolveAgentId, dispatch, notify* functions
transports/
  index.js          — transport registry (getTransport by name)
  webhook.js        — HTTP POST transport
  workflow.js       — GitHub Actions workflow_dispatch transport
```

## How it works

1. **Agent identity** is resolved per-notification via `resolveAgentId({ prBody, config })`:
   - PR body marker: `<!-- fluent-flow-agent: agent-id -->` (highest priority)
   - `config.default_agent` (per-repo config)
   - `config.agent_id` (legacy backward compat)

2. **Agent config** is looked up from the agent registry (`config/agents.yml`) via `getAgentConfig(agentId)` in `src/config/agents.js`.

3. **Transport** is selected based on the agent's `transport` field and called with a standardized payload.

## Notification functions

| Function | Event | Wake mode |
|----------|-------|-----------|
| `notifyReviewFailure` | `review_failed` | `now` |
| `notifyPause` | `paused` | `next-heartbeat` |
| `notifyResume` | `resumed` | `now` |
| `notifyPRMerged` | `pr_merged` | `now` |

All functions build a human-readable message + structured payload, then call `dispatch()`.

## Review failure message format

`notifyReviewFailure` builds a rich `message` string with full issue details so agents can act on the review feedback. The message includes:

- Summary line with repo, PR number, attempt, and blocking count
- Blocking issues with file path, line number, description, and fix suggestion
- Advisory issues with file path, line number, description, and suggestion

The `on_failure` config (`reviewer.on_failure` in `.github/fluent-flow.yml`) forwards `model` and `thinking` fields to the agent's webhook payload, allowing per-repo control of which AI model processes the fix.

## Transports

### webhook

HTTP POST to the agent's `url` with optional `Authorization: Bearer {token}`. Token resolved from env var named in `token_env`.

### workflow_dispatch

Calls GitHub Actions `workflow_dispatch` API via `dispatchWorkflow()` in `src/github/rest.js`. Dispatches the workflow named in the agent's config with the payload as inputs.

## Adding a new transport

1. Create `transports/your-transport.js` with `export async function send(agentConfig, payload)`
2. Register in `transports/index.js`
3. Use `transport: 'your_transport'` in agent config
