# Config

Two-layer configuration system: global defaults + per-repo overrides.

## Files

### defaults.yml

Global defaults loaded at startup. Defines states, transitions, reviewer settings, pause rules, and notification preferences. All values can be overridden per-repo.

### agents.yml

Agent wake transport registry. Maps agent IDs to their notification transport config. Loaded at startup from this file. If missing, falls back to an empty registry.

**Not committed to the repo** — it's in `.gitignore` because it contains deployment-specific URLs. Copy `agents.example.yml` to `agents.yml` and configure for your deployment.

```yaml
agents:
  my-agent:
    transport: webhook              # or workflow_dispatch
    url: http://my-agent:8080/wake
    token_env: MY_AGENT_TOKEN       # env var name holding the auth token
    delivery:                       # optional routing metadata
      channel: discord
      to: "channel:123"
```

### agents.example.yml

Template showing available agent config options. Copy to `agents.yml` to get started.

## Per-repo config

Each repo can override defaults by adding `.github/fluent-flow.yml`:

```yaml
project_id: "PVT_xxx"        # GitHub Project v2 ID
default_agent: "my-agent"     # Default agent for this repo
reviewer:
  max_retries: 5              # Override default
  on_failure:                 # Forwarded to agent when review fails
    model: claude-sonnet-4-6  # AI model for fix attempts
    thinking: high            # Thinking level: low, medium, high
```

## Resolution

Config is resolved via `resolveConfig(owner, repo)` in `src/config/loader.js`:

1. Memory cache (TTL-based)
2. DB cache (`config_cache` table, TTL-based)
3. GitHub API (fetch `.github/fluent-flow.yml`)
4. Deep merge with defaults
5. Zod validation

Cache invalidated automatically on push to `.github/fluent-flow.yml`.

## Validation

All config is validated with Zod schemas in `src/config/schema.js`:
- `DefaultsConfigSchema` — global defaults
- `RepoConfigSchema` — per-repo overrides
- `MergedConfigSchema` — combined result with transforms (`agent_id` → `default_agent`, `project_id` → `project_ids`)
