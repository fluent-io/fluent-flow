# Notifications

Agent-agnostic notification dispatcher. Routes wake notifications to the correct agent via pluggable transports.

## Architecture

```
dispatcher.js       — resolveAgentId, resolveAgentForIssue, dispatch, notify* functions
transports/
  index.js          — transport registry (getTransport by name)
  webhook.js        — HTTP POST transport
  workflow.js       — GitHub Actions workflow_dispatch transport
  long-poll.js      — in-memory queue for runner sessions
```

## How it works

1. **Agent identity** is resolved per-notification:
   - PR-facing handlers use `resolveAgentId({ prBody, config })` — extracts agent from PR body marker `<!-- fluent-flow-agent: agent-id -->`
   - Issue-facing handlers use `resolveAgentForIssue(owner, repo, issueNumber, config)` — checks active pause `agent_id` → linked PR body marker → config default
   - Resolution priority: PR body marker > `config.default_agent` > `config.agent_id` (legacy)

2. **Agent config** is looked up from the DB agent registry first, then falls back to `config/agents.yml` (deprecated) via `getAgentConfig(agentId)`. For `long_poll` agents, the dispatcher resolves `session_id` from the active claim so the transport can route to the correct runner.

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

### long_poll

In-memory queue for `fluent-flow-runner` instances. Payloads are enqueued per `session_id` and dequeued when the runner calls `POST /api/runner/poll`. Max queue size: 100 per session (oldest dropped with warning on overflow). Runners connect outbound — no inbound networking required.

## Adding a new transport

1. Create `transports/your-transport.js` with `export async function send(agentConfig, payload)`
2. Register in `transports/index.js`
3. Use `transport: 'your_transport'` in agent config
