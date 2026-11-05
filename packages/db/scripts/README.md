# scripts

Developer CLIs for `@fluent-flow/db`.

- `collab-fixture.mjs` — non-production fixture/bootstrap for isolated `ff_*`
  loopback databases: two client workspaces, three projects,
  password collaborators in both clients, reviewer/operator principals, two GitHub admin fixtures with local demo passwords and one offline execution host. All
  generated credentials go to a mode-0600 local file; nothing sensitive is
  printed or logged. Idempotent on re-run (existing principals are reused,
  credentials not regenerated). Owner entries, including the duplicate host-owner entry, share the same saved password for their principal. Missing owner password credentials are generated once with the shared password service; existing credential hashes are never reset. Keep using the same private output file on reruns. If an existing owner hash has no matching saved password, the output reports an unknown password rather than replacing that hash. Run `npm run build` in packages/db first.
  It also inserts demo project overviews only where a project has none: A1 is a
  disposable Node.js arithmetic demo with no web server (`npm test`, add starts
  out broken on purpose), A2 is a permission-isolation example with no
  repository or host, and B1 shows client isolation with no application. Edited
  overviews are never overwritten and project versions are not bumped.

Parent: [packages/db README](../README.md) ·
Contract: [docs/plans/2026-10-19-collaborative-contracts.md](../../../docs/plans/2026-10-19-collaborative-contracts.md)
