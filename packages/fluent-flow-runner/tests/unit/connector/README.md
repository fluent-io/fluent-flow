# Connector tests

[Runner](../../../README.md) · [Implementation](../../../src/connector/README.md) · [External SDK fixture](helpers/README.md)

The unit suites cover durable journal recovery, local allowlists, stable SDK identities, staged grants, permission translation, timeline normalization, observation byte/count limits, artifact containment, real Git cleanup safety and CLI invocation. `runtime.test.js` composes the real modules around the external SDK fixture.

`native-sdk-contract.test.js` runs the actual public `createPaseoApi` mapping over a daemon I/O driver that parses requests with the pinned native protocol schemas. It checks workspace format, agent UUID/provider/model/placement/labels/MCP configuration, send options, numeric timeline cursors, permission replies, replay and preservation of older journal bindings. This catches wire-shape errors the high-level fixture alone cannot prove.

`real-app.test.js` launches the actual Express app, runs migrations on a dedicated PostgreSQL database, and uses the real HTTP client, runtime, journal, loop, executor and observer. Only the external Paseo SDK and stop boundary are faked. It exercises accepted-response loss and restart, scoped MCP setup, more than one observation batch with an ACK loss, plan/usage/Git projections, native question replies/resolution, selected-session follow-ups, cancellation and revoked accepted grants. It creates isolated fixture records and does not reset the schema. `COLLAB_CONNECTOR_TEST_DATABASE_URL` is required and must name a loopback `ff_connector_*` database (`ff_c` is accepted for the assigned local fixture). Never point it at the DB or server package's reset database.

The native usage case sets the actual public snapshot `lastUsage` fields, observes native idle, and exercises startup/reconciliation and observer restart. It asserts one cumulative sample, raw input/cache/context/cost provenance, zero/null distinctions, updated values and project insights without summing overlapping turn usage.

The privacy case verifies actual app JSON, outgoing observation JSON and the local observation journal omit known fixture paths and credentials in tool, permission and assistant text. Native MCP credentials and permission inputs remain exact. Runtime restart coverage loads private seeded credentials plus newly retained reporting credentials before native backfill. `redaction-context.test.js` checks private modes, atomic replacement, restart, malformed files and symlink refusal; `observation-privacy.test.js` documents the narrow known-value scope.

The archive case uses a disposable local Git repository and bare upstream, queues real HTTP preflight/archive commands, removes only the fixture directory at the external SDK boundary, and delays native confirmation to prove concurrent Git sampling waits. It verifies the exact confirmed HEAD remains historical in delivery review across runtime restart, one stable archived observation is stored, and another workspace missing without a receipt remains unknown. Journal tests cover pre-existing successful wrapup receipts and reject failed, session-only, dirty or foreign cleanup as archival authority.

```bash
COLLAB_CONNECTOR_TEST_DATABASE_URL=postgres://ffuser@127.0.0.1:55432/ff_connector_test npm test --workspace=@fluent-flow/runner
npm run typecheck --workspace=@fluent-flow/runner
```

These tests do not execute a paid model. Real daemon/model and browser UAT remains a separate controlled acceptance gate.
