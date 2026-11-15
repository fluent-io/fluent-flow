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
- `execution-archive.mjs` — private operator transfer of raw execution snapshots.
  Build `packages/db` first and supply `DATABASE_URL` through the operator's
  environment. The script never runs migrations, freezes writers, revokes
  credentials, creates live execution identities or deletes execution history.

  ```sh
  node scripts/execution-archive.mjs capture --workspace-id <uuid> --run-id <uuid>
  node scripts/execution-archive.mjs verify --workspace-id <uuid> --archive-id <uuid> --compare-source
  node scripts/execution-archive.mjs artifacts --workspace-id <uuid> --archive-id <uuid>
  node scripts/execution-archive.mjs export --workspace-id <uuid> --archive-id <uuid> --output <private-directory>/execution.dump
  node scripts/execution-archive.mjs import --workspace-id <uuid> --input <private-directory>/execution.dump
  ```

  Keep the output directory private (mode 0700). Export creates a mode-0600 file
  and refuses existing paths and symlinks. Dumps contain private raw
  configuration; do not attach them to tickets, browser responses or public
  artifacts. Output and failures contain metadata or generic diagnostics, not
  the dump contents.

  Import verifies the complete ordered stream, identities, record hashes,
  manifest counts and completion footer in one transaction. Exact replay is
  idempotent; conflicting or truncated input does not replace stored data.
  Original IDs, JSON text, microsecond timestamps, provider sequence strings
  and seal metadata are preserved. A historical unknown organization remains
  unknown after the same workspace is linked to an organization.

  This transfers run/session/command/observation records only. It is **not** a
  complete canonical-resource or artifact-byte backup. Source comparison can
  fail if live writers have advanced since capture. Capture or restored seal
  metadata does not establish an operational freeze/drain/deletion receipt;
  those gates still require separate evidence and authorization.
- `execution-retirement.mjs` — global legacy admission fence and read-only
  server-record inventory. Build `packages/db` first and supply `DATABASE_URL`
  through the environment. `inventory` never certifies removal readiness.
  Only `freeze --confirm-all-legacy-execution` authorizes a freeze; busy
  admissions cause a refusal, not an automatic retry. No migrations,
  revocation or deletion. See [fence and drain operations](../src/collaboration/README.md#legacy-admission-fence-and-drain-inventory)
  for deployment, authorization and independent host/backup gates.

The archive `artifacts` inventory exits 2 for missing hashes or missing/invalid
captured bytes, including superseded versions. Exit 0 certifies only this byte
inventory. It does not freeze writers, seal storage or authorize removal.


Parent: [packages/db README](../README.md) ·
Contract: [docs/plans/2026-10-19-collaborative-contracts.md](../../../docs/plans/2026-10-19-collaborative-contracts.md)
