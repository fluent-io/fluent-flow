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

## Fix round 1

### RED

Command:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
```

Result before the fix: 8 passing, 11 failing, 1 cancelled. The failures covered positional registration, baseline positional overloads, ignored transport injection, missing Node transport, missing operational error logs, DELETE validation, persistence status mapping, and baseline replay retry behavior. The run remained pending after 120 seconds because the new timeout/ephemeral-server cases had no supported transport boundary.

### GREEN

- `node --test scripts/preview-webhook-router/router.test.mjs` — 19 passing, 0 failing, 0 cancelled.
- `npm run test:preview` — 37 passing, 0 failing, 0 cancelled.
- `node --check scripts/preview-webhook-router/router.mjs` and `node --check scripts/preview-webhook-router/router.test.mjs` — passed.
- `docker build --file scripts/preview-webhook-router/Dockerfile --tag fluent-flow-preview-webhook-router:test .` — passed.
- Docker smoke with temporary secrets and state — `GET /health` returned `{"status":"ok"}`.

The fix uses Node's built-in HTTP transport with an explicit Host header and a 5-second default timeout, keeps transport injection for deterministic tests, removes positional and alias inputs, validates DELETE requests, logs sanitized operational error identifiers, maps persistence failures to 500, maps baseline replay failures to 502, and keeps retry behavior safe after rollback failure in the running router.

## Fix round 2

### RED

Command:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
```

Output:

```text
ℹ tests 20
ℹ pass 19
ℹ fail 1
ℹ cancelled 0
```

The failure proved the removed `routesFor(classification)` contract was still accepting the dead string-event overload: `routesFor('push', payload)` returned the registered route instead of `[]`.

### GREEN

- `node --test scripts/preview-webhook-router/router.test.mjs` — 20 passing, 0 failing, 0 cancelled.
- `npm run test:preview` — 38 passing, 0 failing, 0 cancelled.

The round-2 tests prove concurrent same-route PUT responses both return `204` while exactly one installation baseline is delivered, and prove a baseline replay failure with rollback failure returns `500`, preserves the route for retry, replays the preserved baseline once successfully, and does not replay it on the following retry.

## Fix round 3

### RED

Command:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
```

Output before adding the missing behavior coverage:

```text
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
```

The existing suite was green because it did not register a second distinct route after preserving an installation baseline or verify that re-registering either route produced no additional replay. No production defect was exposed by the coverage addition.

### GREEN

Commands:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
npm run test:preview
```

Output:

```text
focused router suite: 21 passing, 0 failing, 0 cancelled
preview suite: 39 passing, 0 failing, 0 cancelled
```

The new test registers two distinct routes and verifies each receives the preserved installation body once with the original signature and its derived `Host`; re-registering either route leaves the replay count at two. Production code was unchanged.
