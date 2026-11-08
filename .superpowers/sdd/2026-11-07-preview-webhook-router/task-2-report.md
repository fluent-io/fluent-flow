# Task 2 report: edge deployment and preview route lifecycle

## Delivered

- Added the permanent `preview-webhook-router` service to the shared edge Compose stack with a persistent state volume, stable Traefik host, health dependency, no host ports, no Docker socket, and only webhook and route-administration secrets.
- Added the fixed-origin route lifecycle client with local identity validation and idempotent removal handling.
- Added Preview GitHub App webhook configuration using base64 private-key decoding and the existing `signAppJwt`, with the stable webhook URL, JSON content type, shared webhook secret, and TLS verification enabled.
- Added bounded recent App-delivery listing, GUID grouping, successful-attempt suppression, and one redelivery request per unresolved failed GUID.
- Added trusted edge reconciliation, App webhook configuration, preview deploy/register and teardown/remove lifecycle steps, route-aware PR comment state, and the five-minute/manual trusted redelivery workflow.
- Updated Compose and script contract tests and scripts documentation.

## Verification

### RED

Compose contract:

```bash
node --test scripts/preview-compose.test.mjs
```

Result:

```text
ℹ tests 4
ℹ pass 3
ℹ fail 1
ℹ cancelled 0
```

The router-service assertion failed because `preview-webhook-router` was absent.

Route, App, and redelivery contracts:

```bash
node --test scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Result:

```text
ℹ tests 3
ℹ pass 0
ℹ fail 3
ℹ cancelled 0
```

All three modules failed with `ERR_MODULE_NOT_FOUND` because the production scripts were absent.

### GREEN

Focused Task 2 suite:

```bash
node --test scripts/preview-compose.test.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Result: 12 tests passed, 0 failed, 0 cancelled.

Preview contract suite:

```bash
npm run test:preview
```

Result: 48 tests passed, 0 failed, 0 cancelled.

Syntax and whitespace checks:

```bash
node --check scripts/preview-webhook-route.mjs
node --check scripts/preview-github-app.mjs
node --check scripts/preview-webhook-redelivery.mjs
node --check scripts/preview-webhook-route.test.mjs
node --check scripts/preview-github-app.test.mjs
node --check scripts/preview-webhook-redelivery.test.mjs
node --check scripts/preview-compose.test.mjs
git diff --check
```

Result: all commands passed.

Compose validation:

```bash
PREVIEW_TUNNEL_TOKEN=tunnel-token PREVIEW_WEBHOOK_SECRET=webhook-secret PREVIEW_ROUTE_SECRET=route-secret PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose --project-name fluent-flow-preview-edge --file docker-compose.preview-edge.yml config >/dev/null
```

Result: passed.

Workflow YAML parsing:

```bash
node --input-type=module -e "import fs from 'node:fs'; import yaml from 'js-yaml'; for (const file of ['.github/workflows/preview-edge.yml','.github/workflows/preview.yml','.github/workflows/preview-webhook-redelivery.yml']) { yaml.load(fs.readFileSync(file, 'utf8')); console.log(file + ': PASS'); }"
```

Result: all three workflow files parsed successfully.

## Concerns

- `actionlint` was not installed in the execution environment, so workflow validation used `js-yaml` parsing plus Compose validation instead.
- Live GitHub App API configuration, scheduled redelivery, Cloudflare ingress, and deployed concurrent previews were not exercised locally.

## Review Fixes

### RED

Focused review-fix tests:

```bash
node --test scripts/preview-compose.test.mjs scripts/preview-webhook-route.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Result: 17 tests, 8 passed, 9 failed. The failures were the new behavioral assertions for required Compose secrets, cursor pagination, six-hour lookback, missing GUID rejection, AggregateError after all attempts, redelivery cap traversal, bounded-page exhaustion, redelivery AggregateError semantics, and remove-404 failure.

### GREEN

Focused review-fix suite:

```bash
node --test scripts/preview-compose.test.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Result: 19 tests passed, 0 failed, 0 cancelled.

The implementation now follows GitHub `Link` cursor URLs without `page=`, uses the six-hour outage window within GitHub's three-day webhook redelivery retention, stops after three pages with a loud failure when the cutoff is not reached, fails before any POST when unresolved candidates exceed the 100-redelivery cap, classifies delivery `status_code` 200–399 as success, rejects missing GUIDs, attempts every selected redelivery before throwing an `AggregateError`, accepts only 2xx route responses including removal, uses path-safe CLI guards, and requires both router secrets during Compose interpolation. The design spec and scripts README document these limits. Compose assertions cover service topology, secret requirements, and isolation behavior.

### Verification

```bash
npm run test:preview
```

Result: 55 tests passed, 0 failed, 0 cancelled.

```bash
for file in scripts/preview-webhook-route.mjs scripts/preview-github-app.mjs scripts/preview-webhook-redelivery.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs scripts/preview-compose.test.mjs; do node --check "$file"; done
PREVIEW_TUNNEL_TOKEN=tunnel-token PREVIEW_WEBHOOK_SECRET=webhook-secret PREVIEW_ROUTE_SECRET=route-secret PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose --project-name fluent-flow-preview-edge --file docker-compose.preview-edge.yml config >/dev/null
node --input-type=module -e "import fs from 'node:fs'; import yaml from 'js-yaml'; for (const file of ['.github/workflows/preview-edge.yml','.github/workflows/preview.yml','.github/workflows/preview-webhook-redelivery.yml']) { yaml.load(fs.readFileSync(file, 'utf8')); console.log(file + ': PASS'); }"
git diff --check
```

Result: all syntax checks, Compose validation, workflow YAML parsing, and whitespace checks passed. YAML output:

```text
.github/workflows/preview-edge.yml: PASS
.github/workflows/preview.yml: PASS
.github/workflows/preview-webhook-redelivery.yml: PASS
```

Remaining concerns are unchanged: live GitHub App API configuration and redelivery, Cloudflare ingress, deployed concurrent previews, and live router delivery were not exercised locally; `actionlint` is not installed in the execution environment.

## Final re-review blocker fix

### RED

```bash
node --test scripts/preview-webhook-redelivery.test.mjs
```

Result: 8 tests, 7 passed, 1 failed. The 101-unresolved-GUID regression failed with `AssertionError: Missing expected rejection`, showing that the previous implementation returned normally instead of failing before the redelivery cap.

### GREEN

```bash
node --test --test-name-pattern='fails loudly before redelivering' scripts/preview-webhook-redelivery.test.mjs
```

Result: 1 test passed, 0 failed. The regression now rejects before any redelivery POST.

Final focused suite:

```bash
node --test scripts/preview-compose.test.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Result: 20 tests passed, 0 failed, 0 cancelled.

Full preview contract suite:

```bash
npm run test:preview
```

Result: 56 tests passed, 0 failed, 0 cancelled.

Syntax, Compose, workflow YAML, and whitespace checks all passed:

```bash
for file in scripts/preview-webhook-route.mjs scripts/preview-github-app.mjs scripts/preview-webhook-redelivery.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs scripts/preview-compose.test.mjs; do node --check "$file"; done
PREVIEW_TUNNEL_TOKEN=tunnel-token PREVIEW_WEBHOOK_SECRET=webhook-secret PREVIEW_ROUTE_SECRET=route-secret PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose --project-name fluent-flow-preview-edge --file docker-compose.preview-edge.yml config >/dev/null
node --input-type=module -e "import fs from 'node:fs'; import yaml from 'js-yaml'; for (const file of ['.github/workflows/preview-edge.yml','.github/workflows/preview.yml','.github/workflows/preview-webhook-redelivery.yml']) { yaml.load(fs.readFileSync(file, 'utf8')); console.log(file + ': PASS'); }"
git diff --check
```

Result: all commands passed; each workflow printed `PASS`.

## Final security review fixes

The final review identified five runtime defects: baseline replay omitted the JSON content type, replay-pending state was memory-only, the downstream timeout reset on response activity, the edge status step omitted required router secrets, and edge reconciliation could reuse a stale locally built router image.

### RED

```bash
node --test scripts/preview-webhook-router/router.test.mjs
```

Result: three new behavioral regressions failed. Baseline replay forwarded no content type, a persisted route skipped its baseline after restart, and a trickling response outlived the configured downstream deadline. The edge status command also failed during Compose interpolation when run with the workflow's original environment.

### GREEN

```bash
node --test scripts/preview-webhook-router/router.test.mjs
npm run test:preview
node --check scripts/preview-webhook-router/router.mjs
node --check scripts/preview-webhook-router/router.test.mjs
git diff --check
```

Result: 24 router tests and 59 preview contract tests passed. The router now persists content type and replay-pending state, clears pending state only after downstream acceptance, uses an absolute timeout, and retries unfinished replay after restart. The edge workflow supplies required secrets to `compose ps` and reconciles with `--build`.

```bash
PREVIEW_TUNNEL_TOKEN=test PREVIEW_WEBHOOK_SECRET=test PREVIEW_ROUTE_SECRET=test PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose --project-name fluent-flow-preview-edge --file docker-compose.preview-edge.yml ps
PREVIEW_TUNNEL_TOKEN=test PREVIEW_WEBHOOK_SECRET=test PREVIEW_ROUTE_SECRET=test PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose --project-name fluent-flow-preview-edge --file docker-compose.preview-edge.yml config --quiet
docker build --file scripts/preview-webhook-router/Dockerfile --tag fluent-flow-preview-webhook-router:verify .
```

Result: edge status and configuration commands passed, the final router image built, and its `/health` endpoint returned HTTP 200 with `{"status":"ok"}`.

## Independent recovery review fixes

The independent review found four release defects: production used the no-op logger, restart recovery waited for another route registration, failed replay could remove a route that already existed, and newer attempts could extend a delivery GUID beyond its six-hour recovery window.

### RED

```bash
node --test --test-name-pattern='persisted pending|failed restart replay' scripts/preview-webhook-router/router.test.mjs
node --test --test-name-pattern='six hours after its original' scripts/preview-webhook-redelivery.test.mjs
```

Result: both restart tests failed because the server exposed no startup replay, and the original-delivery regression expected zero redeliveries but observed one.

### GREEN

```bash
node --test scripts/preview-webhook-router/router.test.mjs
node --test scripts/preview-webhook-redelivery.test.mjs
```

Result: 25 router tests and 9 redelivery tests passed. The router now emits structured JSON in production, retries persisted baseline work when it starts, retains existing routes when recovery fails, and leaves failed recovery pending. Redelivery eligibility is now bounded by the original GitHub delivery rather than by newer attempts.

Final verification:

```bash
npm run test:preview
npm test
docker build --file scripts/preview-webhook-router/Dockerfile --tag fluent-flow-preview-webhook-router:final .
```

Result: 61 preview contract tests passed. The complete monorepo run passed all five Turbo tasks: dashboard 208, database 202, runner 515, and service 684 tests; 10 legacy integration tests remained intentionally skipped. The final image built, `/health` returned HTTP 200, and a signed pull-request delivery produced one JSON log containing its delivery ID, event, selector, route count, and status.
