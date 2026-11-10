# Schema tests

[Database tests](../) · [Database package README](../../README.md#schemas)

Unit tests for the Zod schemas in `src/schemas`. They parse plain objects and need no database.

- [agents.test.ts](agents.test.ts): `agentSchema`, `agentDetailSchema` and `agentListItemSchema`. Checks the capacity, `active_slots`, deployment, status and `last_seen_at` fields that the dashboard reads, nulls for agents that never connected, and rejection of unknown deployments, non-integer capacity and invalid `active_slots`.
- [repo-config.test.ts](repo-config.test.ts): repository and organization configuration schemas, and the GitHub webhook event schema.

The queries that produce these shapes are covered in [../queries/](../queries/README.md).
