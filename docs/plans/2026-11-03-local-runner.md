# One-command local runner implementation plan

**Goal:** `npm run runner` makes Project A1 executable from the local board using the existing real Paseo connector.

**Design:** The user selected a disposable demo repository. Reuse the existing local PostgreSQL startup hook and build the DB package, then authenticate the saved fixture owner, enroll one durable local host, and configure one demo repository/profile mapping through authorized services. Use an existing OMP AI3 coding profile (prefer the configured `ai3/qwen38-flash` profile), with `--profile <id>` for an explicit choice. Actual AI work still requires a task's Start action. Provider credentials remain in Paseo.

**Boundaries:** Default to the seeded loopback `ff_demo` database. Another disposable loopback `ff_*` database requires an explicit `FF_LOCAL_RUNNER_DATABASE` name; production mode is always rejected. The control plane must be loopback. Store private enrollment, connector config and journal in `.local/runner/`; keep the same host/instance IDs on restart. Never overwrite existing source, saved credentials, a modified demo repository or unrelated project settings. No package installation, production changes, autonomous task launch, commits or PR publication.

**Alternatives:** A bare alias to the connector CLI leaves host enrollment and project mapping manual, so does not satisfy ready-to-test startup. A simulated runner does not exercise the approved execution integration. The selected approach prepares the existing connector and leaves its runtime protocol unchanged.

## Implementation

- [x] Write real-app regressions against a separate test database: first setup produces a private enrolled host and disposable Git repo; registration plus configuration makes Project A1 runnable; restart reuses host/token/mapping and preserves data; invalid profile, credential, or remote target fails before enrollment.
- [x] Observe the behavioral RED before adding setup code. Keep the database, mounted HTTP routes and filesystem real; fake only native Paseo I/O.
- [x] Add `scripts/dev-runner-setup.mjs` for guarded, authorized, durable preparation and project defaults, plus `scripts/dev-runner.mjs` for connecting the existing SDK/runtime and signal cleanup. Reuse the existing connector catalog and runtime.
- [x] Add the root `runner` script (database check and DB build run in that entry point) and update root, script, runner and local READMEs with two-terminal usage, profile selection and CLI errors.
- [x] Verify focused GREEN, then the full suite in independent databases, runner typecheck, and whitespace checks.
- [x] Run real `npm run runner`, confirm host heartbeat/catalog/defaults in the browser, perform one bounded native task in the disposable repo, and restart without duplicate hosts or prompts.

## Review focus

- Enrollment tokens stay in private files and never reach logs or screenshots.
- Restart preserves local edits, credentials, host identity, journal and user-edited project instructions.
- A revoked enrollment or missing private token fails rather than silently replacing it.
- Concurrent starts cannot enroll competing local hosts.
- Readiness is announced only after actual registration and authorized project configuration.

Review findings reproduced five failures before fixes: production mode, an unrelated local database, competing checkouts, same-host non-demo defaults, and a lost one-time enrollment response. The fixes scope the lock to the database/project, require an explicit disposable database selection, preserve unrelated defaults before creating another mapping, and retain a private pending marker for enrollment recovery. Focused setup, lifecycle and CLI coverage passes 18 tests. SIGINT and SIGTERM coverage uses the real runtime, journal, API and poll loop with external Paseo I/O faked.

## Validation

- Node 22 forced full suite: 1,082 passed (DB 159, API 498, dashboard 112, runner 313), 5/5 Turbo tasks, zero cached. The three opt-in legacy SQL cases also passed in a separate migrated test database.
- Runner typecheck and `git diff --check`: passed.
- Actual root `npm run runner`: database check, shared DB build, native Paseo connection, host registration, profile catalog and Project A1 mapping succeeded. No task started until the browser Start action.
- Browser created one bounded demo task and queued its run with the online local host and configured OMP AI3 Qwen profile. The native agent changed only `math.mjs` in its disposable Paseo worktree. The original two failing tests both pass, with test expectations unchanged. Changes remain uncommitted for human review.
- Browser transcript shows the saved task output after reload: one run, one session, idle state, zero page errors and zero failed collaboration responses.
- SIGTERM stopped the real CLI with exit 0. Restart preserved the host credential, instance, mapping, native agent/workspace IDs and exactly one user message; the heartbeat resumed. Private state, config and token files remain mode 0600.
- Ctrl+C also stopped the actual root npm process and its connector child. The database and app processes remained available. The final runner was started again for browser testing.
- Independent read-only re-review approved all five finding resolutions and the new real-runtime lifecycle coverage. The reviewer did not execute the tests or services; validation above was performed by the implementing agent.

Local logs and private evidence are under ignored `.local/`; they are not part of the published repository. No production environment, installation, commit, push or PR operation was performed. The native smoke proves this configured host/profile; it does not assert availability of every provider or host.

Parent: [implementation plans](README.md). Execution contract: [collaborative specification](2026-10-19-collaborative-spec.md).
