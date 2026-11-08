# Preview webhook router

The preview webhook router is a small Node.js HTTP service for the permanent Preview GitHub App webhook endpoint.

It verifies `X-Hub-Signature-256` over the raw request bytes, classifies events, and forwards accepted events to the active preview API through `http://traefik/webhooks/github-app`. Forwarding uses the deterministic `Host` header `api-pr-<number>-preview.fluentflow.tech`.

The router persists one versioned JSON state file under `ROUTER_STATE_DIR`. The file contains active repository/PR routes and the latest signed `installation.created` baseline. State mutations serialize, write a temporary file, fsync it, and rename it into place. Corrupt state fails startup.

## Runtime

Required environment variables:

- `PREVIEW_WEBHOOK_SECRET`
- `PREVIEW_ROUTE_SECRET`

Optional environment variables:

- `PORT` defaults to `3000`.
- `ROUTER_STATE_DIR` defaults to `/data`.

The container exposes `GET /health`, `POST /webhooks/github-app`, `PUT /routes`, and `DELETE /routes`.

Route administration uses `Authorization: Bearer <PREVIEW_ROUTE_SECRET>` or `X-Route-Secret`. Registration accepts only `repository`, positive `pullRequest`, and a 40-character hexadecimal `headSha`. The destination is always derived by the router.

## Tests

Run the focused suite with:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
```

Run all preview contract tests with:

```bash
npm run test:preview
```
