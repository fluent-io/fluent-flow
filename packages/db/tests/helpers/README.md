# Database fixture helpers

[Database package](../../README.md) · [Collaboration tests](../collaboration/README.md)

`collab-db.ts` validates the dedicated loopback `ff_*` database name and test
mode before any schema reset. It also seeds isolated legacy users and org
memberships for tests of the two permission domains. Never pass a shared or
production URL. Each parallel test package uses its own database.
