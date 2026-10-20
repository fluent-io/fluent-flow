# scripts

Developer CLIs for `@fluent-flow/db`.

- `collab-fixture.mjs` — non-production fixture/bootstrap for isolated `ff_*`
  loopback databases: two client workspaces, three projects,
  password collaborators in both clients, reviewer/operator principals, two GitHub admin fixtures and one offline execution host. All
  generated credentials go to a mode-0600 local file; nothing sensitive is
  printed or logged. Idempotent on re-run (existing principals are reused,
  credentials not regenerated). Run `npm run build` in packages/db first.

Parent: [packages/db README](../README.md) ·
Contract: [docs/plans/2026-10-19-collaborative-contracts.md](../../../docs/plans/2026-10-19-collaborative-contracts.md)
