# Development scripts

- [dev-database.mjs](dev-database.mjs): the root `npm run dev` pre-start check. When `DATABASE_URL` selects the existing project demo at `127.0.0.1:55432/ff_demo`, starts `.local/postgres-data` if stopped and checks readiness before Turbo launches either app. Reads the exported URL first, then the API's `.env.local`. Uses PostgreSQL tools matching the cluster version, from the standard Linux versioned directory or `PATH`. Never creates or resets a database, changes credentials, or manages custom databases. PostgreSQL stays running when the apps stop.
- [check-migrations.sh](check-migrations.sh): verifies that SQL migrations and journal entries match. Run from the repository root.
- [dev-runner.mjs](dev-runner.mjs): root `npm run runner` command. Ensures the local database is up, builds shared DB code, connects to the existing local Paseo daemon, registers the real connector, and prepares Project A1 before announcing readiness. `--help` runs without services; `--profile <id>` selects an existing profile. Work starts only through a task's Start action.
- [dev-runner-setup.mjs](dev-runner-setup.mjs): guarded fixture-owner authentication, private durable enrollment, disposable Git repository, and authorized host/project setup. Uses a database session lock keyed by project to reject concurrent runners across checkouts. Restarts reuse credentials, host identity, repository edits and existing project instructions. Also serves the real connector, announces readiness after registration and configuration, and closes it on SIGINT/SIGTERM.
- [preview-webhook-router/router.mjs](preview-webhook-router/router.mjs): permanent signed Preview GitHub App webhook router. It persists routes and the latest signed installation baseline, forwards raw events through Traefik, and exposes route administration and health endpoints.
- [preview-webhook-router/README.md](preview-webhook-router/README.md): router runtime, authentication, state, and test documentation.
- [preview-webhook-router/Dockerfile](preview-webhook-router/Dockerfile): Node 22 image for the router service.
- [preview-webhook-route.mjs](preview-webhook-route.mjs): registers and removes preview webhook routes through the fixed permanent router origin.
- [preview-github-app.mjs](preview-github-app.mjs): configures the Preview GitHub App webhook at the stable router URL with an App JWT.
- [preview-webhook-redelivery.mjs](preview-webhook-redelivery.mjs): lists recent failed Preview App deliveries and requests bounded redelivery through GitHub.

Startup regressions live in [dev-database.test.js](../packages/fluent-flow/tests/unit/dev-database.test.js) and execute the real npm lifecycle with controlled external process fixtures.
Runner setup tests use the real mounted API, password service, separate PostgreSQL database and Git: [collab-local-runner.test.js](../packages/fluent-flow/tests/routes/collab-local-runner.test.js). Lifecycle tests run the real connector runtime and poll loop; only external Paseo SDK/CLI I/O is faked. They verify readiness, signal cleanup and lock release. The [CLI test](../packages/fluent-flow/tests/unit/dev-runner-cli.test.js) verifies help without requiring services.

Local runner errors identify a missing API/daemon or fixture credentials, non-loopback configuration, production mode, a database outside the explicit local selection, unavailable profile, concurrent runner, missing/revoked enrollment, interrupted enrollment, unexpected demo directory, or conflicting project defaults. They stop setup without resetting credentials or replacing existing data. The default database must be the seeded loopback `ff_demo`, with matching private fixture output. For another disposable `ff_*` database, explicitly set `FF_LOCAL_RUNNER_DATABASE` to its exact name. Production mode is always rejected. It never installs Paseo or creates an AI task automatically.

If enrollment commits but its one-time response or private state cannot be saved, `enrollment-pending.json` blocks a second enrollment. Restore the private state if available; otherwise revoke the unused `Local demo runner` through settings before explicitly removing that marker and retrying. A saved, verified enrollment clears a leftover marker automatically. Never remove `.local/runner` to resolve a running task: its journal retains execution and cleanup authority.

Parent: [project README](../README.md).
Database setup: [database README](../packages/db/README.md).
Preview router details: [preview webhook router README](preview-webhook-router/README.md).
