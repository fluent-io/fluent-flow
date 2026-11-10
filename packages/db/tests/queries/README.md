# Query tests

[Database tests](../) · [Database package README](../../README.md#queries) · [Schema tests](../schemas/README.md)

Five files mock the pg pool and assert SQL text, parameters and parsed results. Three files run against a real PostgreSQL database.

Unit suites (no database):

- [agents.test.ts](agents.test.ts): `listAgents`, `getAgentDetail`, `createAgent` and `createAgentWithEnrollment` (agent row and enrollment token inserted in one transaction, rollback on failure).
- [tokens.test.ts](tokens.test.ts): `regenerateKey`, `getKeyInfo`, `createToken`, `createEnrollmentToken` and `exchangeEnrollmentToken`.
- [sessions.test.ts](sessions.test.ts): `getAgentSessions`.
- [pipelines.test.ts](pipelines.test.ts): `listPipelines` and `getPipelineDetail`.
- [users.test.ts](users.test.ts): `upsertUser`, `getUserOrgs` and `linkUserToOrg`.

Real-database suites (need a disposable loopback `ff_*` database in `COLLAB_DB_TEST_DATABASE_URL`, see [testing](../../README.md#testing)):

- [claim-interactions.test.ts](claim-interactions.test.ts): persistence of claim events, requests and commands, including idempotent replay.
- [enrollment-exchange.integration.test.ts](enrollment-exchange.integration.test.ts): two concurrent exchanges of one enrollment token produce exactly one durable token, and an expired enrollment produces none.
- [agents-capacity.integration.test.ts](agents-capacity.integration.test.ts): the slot aggregate behind the agent list and detail. Live slots, `busy` versus `online`, capacity summed over distinct live instances, restart overlaps counted once, TTL expiry without any status write, poisoned `session_meta` ignored, fallbacks to the capacity and deployment stored on the agent, tie-breaking on session ID, and organization scoping for same-named agents.
