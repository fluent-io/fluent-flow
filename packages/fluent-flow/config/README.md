# Config

Two-layer configuration system: global defaults + per-repo overrides.

## Files

### defaults.yml

Global defaults loaded at startup. Defines states, transitions, reviewer settings, pause rules, and notification preferences. All values can be overridden per-repo.

### agents.yml (deprecated)

Legacy agent transport registry. **Deprecated** — agents should be managed via the admin API (`/api/agents`) or MCP tools (`create_agent`, `list_agents`). Agent config is now stored in the `agents` DB table.

If `agents.yml` is present, it still works as a fallback but logs a deprecation warning on each lookup. See `src/agents/README.md` for the new agent registry system.

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
