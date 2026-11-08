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
