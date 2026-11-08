# Task 1 report: preview webhook router

## Delivered

- Replaced the partial router test with classification, persistence, HMAC, raw forwarding, isolation, fan-out, failure, size-limit, auth, restart, concurrent registration, and installation-baseline replay coverage.
- Replaced the partial router with a Node 22 built-in HTTP service.
- Added one versioned `state.json` containing routes and the latest signed `installation.created` baseline.
- Serialized route, baseline, and route-administration operations with temporary-file write, fsync, and rename persistence.
- Added strict repository, positive pull-request, and 40-hex SHA validation with server-derived preview hosts.
- Added the fixed Traefik forwarding URL, raw body and signature preservation, a 5 MiB body limit, HMAC-before-JSON verification, 10-second downstream timeout, and 502 failure propagation.
- Added the Node 22 Docker image and runtime README.
- Updated the scripts README and `npm run test:preview` to include the nested router tests.

## Verification

- RED: `node --test scripts/preview-webhook-router/router.test.mjs` was run before the implementation rewrite. The partial implementation produced 2 passing tests, 11 failing tests, and one canceled test after the server-close timeout.
- Regression RED: the new concurrent-registration test failed before the queue fix with `2 !== 1` baseline replays.
- GREEN: final focused router suite: 14 passing, 0 failing.
- Docker build: `docker build --file scripts/preview-webhook-router/Dockerfile --tag fluent-flow-preview-webhook-router:test .` passed on the final source.
- Docker smoke: the final image started with temporary secrets and a temporary published port; `GET /health` returned `200`.
- Full preview suite: `npm run test:preview` passed with 32 tests, 0 failures.
- Syntax and package checks: `node --check` passed for router source and tests; `package.json` parsed successfully.
- `git diff --check` passed before the final review changes.

## Concerns

- Task 2 edge Compose integration and route lifecycle clients are not part of this task and remain outside this commit.
- The Docker smoke exercised only router startup and `/health`; it did not require a live Traefik network, GitHub delivery, or preview stack.
- Live GitHub App redelivery and concurrent deployed previews were not exercised locally.
