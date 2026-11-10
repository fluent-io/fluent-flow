# Concurrent Preview Webhook Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route one Preview GitHub App webhook stream to the relevant active pull-request previews without manual webhook changes.

**Architecture:** A small Node 22 proxy in the permanent edge verifies GitHub signatures, reads a persisted JSON route map, and forwards original signed requests to deterministic preview API hosts. The router persists only routes and the latest signed `installation.created` baseline; a trusted scheduled workflow uses GitHub's App delivery API to redeliver failures.

**Tech Stack:** Node.js 22 built-ins, Docker Compose, Traefik, Cloudflare Tunnel, GitHub Actions, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-07-pr-preview-environments-design.md`

## Global Constraints

- Stable endpoint: `https://preview-webhooks.fluentflow.tech/webhooks/github-app`.
- Verify `X-Hub-Signature-256` over raw bytes before parsing.
- Forward unchanged body, signature, event name, and delivery ID.
- Derive `api-pr-<number>-preview.fluentflow.tech`; never accept a destination URL.
- PR events route to one preview; repository events route by repository; installation events route to all active previews.
- Return a server error if any selected preview rejects or cannot receive an event; do not add a router queue. A trusted scheduled workflow MUST request GitHub redelivery of failed App deliveries.
- Persist routes and the latest signed `installation.created` event atomically as JSON.
- Router receives no Docker socket, App private key, production credential, or application database.
- No database migration and no new code comments.

## Review Focus

- Two concurrent PRs must never receive each other's PR events.
- One failed fan-out target must make the GitHub request fail instead of silently dropping that target.
- The scheduled redelivery workflow must ignore successful deliveries and surface GitHub API failures.
- Restart must preserve routes and the installation baseline.
- Route administration must not allow SSRF or reveal active routes on auth failure.
- Forwarded bytes and signature must remain identical.

---

### Task 1: Small signed router with persisted route map

**Files:**
- Create: `scripts/preview-webhook-router/router.mjs`
- Create: `scripts/preview-webhook-router/router.test.mjs`
- Create: `scripts/preview-webhook-router/Dockerfile`
- Create: `scripts/preview-webhook-router/README.md`
- Modify: `scripts/README.md`
- Modify: `package.json`

**Interfaces:**
- `classifyWebhook(eventName, payload) -> { scope, repository, pullRequests }`.
- `createRouteStore({ directory }) -> { load, register, remove, routesFor, saveInstallationBaseline, installationBaseline }`.
- `createPreviewWebhookRouter({ webhookSecret, routeSecret, store, fetchImpl, logger }) -> Node HTTP server`.
- Endpoints: `POST /webhooks/github-app`, `PUT /routes`, `DELETE /routes`, `GET /health`.

- [ ] **Step 1: Write failing classification and route-map tests**

Prove PR-specific, issue-comment-on-PR, check-run PR-array, repository-only, and installation events select the correct literal route keys. Use a real temporary directory to prove registration, removal, restart, deterministic host derivation, atomic persistence, and latest installation baseline replacement.

- [ ] **Step 2: Run the core tests and verify RED**

Run: `node --test scripts/preview-webhook-router/router.test.mjs`

Expected: FAIL because `router.mjs` does not exist.

- [ ] **Step 3: Implement classification and the JSON route store**

Use one versioned JSON file, a serialized mutation promise, temp-file write, sync, and rename. Registration accepts only repository, positive PR number, and 40-character SHA.

- [ ] **Step 4: Add failing HTTP tests**

Start real ephemeral servers. Prove valid HMAC forwarding, invalid-signature rejection before parse, 5 MiB limit, distinct admin-secret authorization, generic auth failures, raw byte/header preservation, PR isolation, repository/global fan-out, any-target failure returning `502`, no-target success, and installation baseline replay once on registration.

- [ ] **Step 5: Run the HTTP tests and verify RED**

Run the same test file; expected failures are the missing HTTP behavior.

- [ ] **Step 6: Implement the HTTP proxy**

Forward through `http://traefik/webhooks/github-app` with the derived preview host in the `Host` header. Use a short request timeout so GitHub receives a failure before its delivery deadline. Log only delivery ID, event, selector, route, and status.

- [ ] **Step 7: Run Task 1 tests and container smoke**

Run:

```bash
node --test scripts/preview-webhook-router/router.test.mjs
docker build --file scripts/preview-webhook-router/Dockerfile --tag fluent-flow-preview-webhook-router:test .
```

Start the image with temporary secrets/state and verify `/health` returns `200`.

- [ ] **Step 8: Document and commit Task 1**

Update the parent and child READMEs and include nested router tests in `npm run test:preview`.

```bash
git add package.json scripts/README.md scripts/preview-webhook-router
git commit -m "feat: add concurrent preview webhook router"
```

### Task 2: Edge deployment and preview route lifecycle

**Files:**
- Modify: `docker-compose.preview-edge.yml`
- Modify: `.github/workflows/preview-edge.yml`
- Modify: `.github/workflows/preview.yml`
- Modify: `scripts/preview-compose.test.mjs`
- Create: `scripts/preview-webhook-route.mjs`
- Create: `scripts/preview-webhook-route.test.mjs`
- Create: `scripts/preview-github-app.mjs`
- Create: `scripts/preview-github-app.test.mjs`
- Create: `scripts/preview-webhook-redelivery.mjs`
- Create: `scripts/preview-webhook-redelivery.test.mjs`
- Create: `.github/workflows/preview-webhook-redelivery.yml`
- Modify: `scripts/README.md`

**Interfaces:**
- `reconcilePreviewWebhookRoute({ operation, repository, prNumber, headSha, secret, fetchImpl })` calls the fixed router origin.
- `configurePreviewAppWebhook({ appId, privateKey, webhookSecret, fetchImpl })` patches the App webhook to the stable URL using the existing `signAppJwt`.
- `redeliverFailedPreviewWebhooks({ appId, privateKey, fetchImpl, now })` lists recent failed App deliveries and requests redelivery for each eligible delivery.

- [ ] **Step 1: Write failing Compose tests**

Assert the edge includes a healthy router service, persistent state volume, stable Traefik host, no host ports, and no Docker socket or App private key.

- [ ] **Step 2: Run the Compose test and verify RED**

Run: `node --test scripts/preview-compose.test.mjs`

Expected: FAIL because the router service is absent.

- [ ] **Step 3: Add the router to the permanent edge**

Pass only the webhook and route-administration secrets, attach the external edge network, persist the state directory, and make Compose wait for health.

- [ ] **Step 4: Write failing route-client, App-configuration, and redelivery tests**

Prove the route client sends only repository, PR number, and SHA to the fixed origin; remove is idempotent; non-fixed origins and invalid identities fail locally. Prove GitHub App configuration sends a JWT-authenticated `PATCH /app/hook/config` with the stable URL, JSON content type, webhook secret, and TLS verification. Prove redelivery lists only failed recent App deliveries, ignores successful or already-resolved records, requests each eligible delivery once, and fails loudly on list or redelivery errors without logging response bodies.

- [ ] **Step 5: Run all three tests and verify RED**

Run:

```bash
node --test scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Expected: FAIL because the scripts are absent.

- [ ] **Step 6: Implement clients and workflow integration**

The edge workflow validates required secrets, starts the router, then reconciles the App webhook URL. The preview workflow registers after public smoke and unregisters in an `always()` step after teardown was attempted. Include route-step outcome in the PR comment state. The redelivery workflow runs every five minutes and by manual dispatch from trusted `main`, authenticates with an App JWT, and invokes only the GitHub App delivery API.

- [ ] **Step 7: Run Task 2 tests and commit**

Run:

```bash
node --test scripts/preview-compose.test.mjs scripts/preview-webhook-route.test.mjs scripts/preview-github-app.test.mjs scripts/preview-webhook-redelivery.test.mjs
```

Expected: PASS.

```bash
git add docker-compose.preview-edge.yml .github/workflows/preview-edge.yml .github/workflows/preview.yml .github/workflows/preview-webhook-redelivery.yml scripts
git commit -m "feat: register preview webhook routes"
```

### Task 3: Verification, review, live UAT, and merge

**Files:**
- Modify only files required by verified findings.

- [ ] **Step 1: Run all preview and repository tests**

```bash
npm run test:preview
npm test
```

Report every failing suite by name.

- [ ] **Step 2: Run a two-preview smoke**

With two controlled downstream HTTP servers, register PR 122 and 123, send signed interleaved PR events plus one repository event, verify exact isolation and fan-out, restart the router, and verify routes and installation baseline remain available.

Force one downstream target to fail, run the redelivery client against a controlled GitHub API fixture, and verify the original event succeeds after the target recovers.

- [ ] **Step 3: Obtain independent final quality and security reviews**

Use different model families, including AI3. Resolve every actionable finding and return material fixes to the finding reviewer.

- [ ] **Step 4: Publish the pull request**

Document the old single-webhook limitation, exact routing behavior, GitHub-redelivery failure model, security boundaries, test results, and live UAT steps.

- [ ] **Step 5: Reconcile the reviewed router on the preview edge**

Run the trusted edge workflow, verify the router and existing edge services are healthy, and confirm the App webhook URL is stable.

- [ ] **Step 6: Seed installation and exercise concurrent live previews**

Redeliver the current installation event once. Use two active previews to prove PR isolation and repository fan-out, then close both and verify independent stack, volume, and route removal.

- [ ] **Step 7: Merge only after CI, independent reviews, and live UAT are clean**
