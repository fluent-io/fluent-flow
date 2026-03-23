# Rich Review Failure Notifications

## Problem

When a PR review fails, Fluent Flow notifies the agent via webhook with a `message` field that contains only a summary: `"Review FAILED: repo#357 (attempt 1) — 6 blocking issue(s)"`. The detailed issues (file paths, line numbers, descriptions, suggested fixes) are sent in a separate `issues` field that OpenClaw's `/hooks/agent` endpoint does not read. OpenClaw uses `message` as the agent prompt, so the agent never sees what to fix.

Additionally, there is no way to control which AI model or thinking level the agent uses when processing review feedback. A less capable model may not produce effective fixes.

## Solution

Two changes:

### 1. Format issue details into `message`

`notifyReviewFailure` will build a rich `message` string that includes all blocking and advisory issues with file paths, line numbers, descriptions, and fix suggestions. This is what OpenClaw reads as the agent prompt.

**Format:**

```
Review FAILED: owner/repo#123 (attempt 2) — 3 blocking issue(s)

Fix the following blocking issues and push your changes:

- src/foo.ts:42 — Description of issue
  > Fix: Suggested fix
- src/bar.ts:10 — Another issue
  > Fix: Another fix

Advisory (non-blocking):
- src/baz.ts:5 — Advisory note
  > Suggestion: Suggested improvement
```

The structured `issues` array remains in the payload for any consumers that do parse it.

### 2. Add `reviewer.on_failure` config block

A new optional `on_failure` block under `reviewer` in the per-repo `fluent-flow.yml`:

```yaml
reviewer:
  enabled: true
  model: claude-haiku          # model that performs the review
  max_retries: 3
  on_failure:                  # forwarded to agent when review fails
    model: claude-sonnet-4-6
    thinking: high
```

- `model` (optional string): AI model the agent should use for fixes
- `thinking` (optional enum: `low`, `medium`, `high`): thinking/reasoning level

When present, these are passed as top-level fields in the webhook payload. OpenClaw's `/hooks/agent` already supports both fields. If omitted, they are not sent and OpenClaw uses its defaults.

## Schema change

In `ReviewerConfigSchema` (src/config/schema.js):

```javascript
const OnFailureSchema = z.object({
  model: z.string().optional(),
  thinking: z.enum(['low', 'medium', 'high']).optional(),
});

const ReviewerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-haiku'),
  max_retries: z.number().int().min(0).max(10).default(3),
  diff_limit_kb: z.number().int().min(1).max(512).default(65),
  severity_tiers: z.boolean().default(true),
  on_failure: OnFailureSchema.optional(),
});
```

## Data flow

1. `handleReviewResult` (FAIL path) passes `config.reviewer.on_failure` to `notifyReviewFailure`
2. `notifyReviewFailure` formats the rich message from the `issues` array and includes `on_failure.model` / `on_failure.thinking` as top-level payload fields
3. `dispatch` builds the full payload (merging delivery config as before)
4. Webhook transport sends HTTP POST to OpenClaw
5. OpenClaw reads `message` (full prompt with issues), `model`, and `thinking`

## Files touched

- `src/config/schema.js` — add `OnFailureSchema`, add `on_failure` to `ReviewerConfigSchema`
- `src/notifications/dispatcher.js` — format rich message, accept and forward `on_failure` options
- `src/engine/review-manager.js` — pass `on_failure` from config to `notifyReviewFailure`
- `config/agents.example.yml` — document `on_failure` in example comments
- `src/notifications/README.md` — document the rich message format and `on_failure` config
- `config/README.md` — document `on_failure` under reviewer config
- Tests for schema, dispatcher, and review-manager changes

## What does not change

- The `issues` array still exists in the payload for other consumers
- The `event`, `wakeMode`, `deliver`, and delivery fields are unchanged
- The review dispatch flow (how reviews are triggered) is unchanged
- The retry/escalation logic is unchanged
