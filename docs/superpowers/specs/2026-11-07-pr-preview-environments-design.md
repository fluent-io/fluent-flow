# Per-PR Preview Environments

**Date:** 2026-11-07
**Status:** Approved for implementation

## Context

Fluent Flow has CI for pull requests and a production Docker Compose deployment for `main`, but no deployed pull-request surface. Production runs on the G10 self-hosted runner behind Cloudflare. The repository is public, while the organization runner group currently rejects public repositories. Pull requests therefore cannot be verified against a real dashboard, service, database, migrations, authentication flow, or runner API before merge.

## Approaches

Three webhook designs were considered:

1. Manually point the Preview GitHub App at the pull request currently under test. This cannot support multiple active previews and requires unsafe operator coordination.
2. Give each preview its own GitHub App. This isolates delivery but creates unbounded App, installation, callback, and secret management.
3. Keep one Preview GitHub App and add a permanent signed-event router in the shared edge. The router maintains active PR routes and delivers each event to the relevant preview stacks.

The selected design is the permanent router. It preserves one preview identity, supports concurrent pull requests, and keeps routing policy in trusted `main` code.

## Goals

- Give every same-repository pull request an isolated full-stack preview.
- Use stable URLs:
  - Dashboard: `https://pr-<number>-preview.fluentflow.tech`
  - Service: `https://api-pr-<number>-preview.fluentflow.tech`
- Deploy on pull-request open, reopen, and synchronize.
- Destroy containers, networks, database volume, and local images when the pull request closes.
- Post or update one pull-request comment containing the dashboard URL, service URL, commit, and deployment state.
- Keep production data and production credentials out of preview containers.
- Make the preview contract deterministic and testable outside GitHub Actions.
- Use the preview for real browser, API, runner, and database UAT.

## Non-Goals

- Fork pull-request previews.
- Production traffic, production data copies, or production GitHub App credentials.
- A general container platform or Kubernetes layer.
- Long-lived preview state after a pull request closes.

## Security Boundary

The workflow uses `pull_request_target`, so GitHub loads the workflow and deployment policy from `main`. A job-level repository check rejects any pull request whose head repository differs from `fluent-io/fluent-flow` before a self-hosted runner is assigned.

The trusted checkout contains the workflow, preview contract script, and Compose definitions. The pull-request head is checked out into a separate source directory used only as the Docker build context. Pull-request code cannot alter mounts, Docker labels, edge routing, cleanup commands, or the workflow itself.

Runtime code receives only preview-scoped credentials:

- A dedicated preview GitHub App installed only on the Fluent Flow test repository.
- Preview App private key and webhook secret.
- Preview OAuth client ID and client secret.
- A preview stack seed used to derive per-PR PostgreSQL, NextAuth, MCP, and collaboration HMAC secrets.
- A Cloudflare Tunnel token available only to the trusted edge workflow.

The preview workflow never reads the production `DATABASE_URL`, GitHub App key, OAuth secret, MCP token, PostgreSQL password, or NextAuth secret.

The organization runner group may be enabled for public repositories only after it is restricted to the exact trusted production and preview workflows on `refs/heads/main`.

## Architecture

### Shared edge

One permanent edge stack runs on G10:

- Traefik watches Docker labels and routes by `Host`.
- A named Cloudflare Tunnel forwards `*.fluentflow.tech` to Traefik. Existing exact DNS records take precedence.
- A preview webhook router receives the Preview GitHub App's events at `https://preview-webhooks.fluentflow.tech/webhooks/github-app`.
- Both containers and the router use the external Docker network `fluent-flow-preview-edge`.
- The router has a persistent project-local volume for the route map and latest signed installation baseline.
- The edge stack has no host-published application ports.

The edge stack is created by a manual `workflow_dispatch` workflow after the tunnel and wildcard DNS record exist. Subsequent runs reconcile the same Compose project.

### Per-PR stack

Each pull request uses Compose project `fluent-flow-preview-<number>` with:

- `fluent-flow`
- `dashboard`
- `postgres`
- A project-local network
- A project-local PostgreSQL volume
- The shared external edge network on the two HTTP services

There are no fixed container names or host port bindings. Traefik labels route the dashboard and service hostnames to their internal ports. Compose project isolation supplies unique container, network, image, and volume names.

The service starts against the per-PR PostgreSQL database and runs current migrations. The dashboard uses the same database, its per-PR `NEXTAUTH_URL`, and the preview OAuth client.

### Webhook router

The router is built only from trusted `main` and has no Docker socket or GitHub App private key. It receives the Preview App webhook secret and a separate route-administration secret.

Public webhook ingress:

1. Read the raw request body with a 5 MiB limit.
2. Verify `X-Hub-Signature-256` before parsing the payload.
3. Require `X-GitHub-Event` and `X-GitHub-Delivery`.
4. Select active preview routes from the event payload.
5. Forward the unchanged raw body, signature, event name, and delivery ID through Traefik.
6. Return success only when every selected preview accepts the event. Any failed target produces a server error recorded by GitHub as a failed delivery.

Trusted deploy and remove workflows call the route API with the administration secret. Registration accepts only a repository name, positive pull-request number, and 40-character head SHA. The destination is derived as `https://api-pr-<number>-preview.fluentflow.tech/webhooks/github-app`; callers cannot supply a URL. Removal is idempotent.

Pull-request-scoped events route only to the matching repository and pull request. This includes `pull_request`, `pull_request_review`, `pull_request_review_comment`, issue and issue-comment events whose issue contains `pull_request`, and pull-request arrays on `check_run`, `check_suite`, and `workflow_run`. A check or workflow event with no pull requests is repository-scoped. Every other event with `repository.full_name` fans out to active previews for that repository. `installation` and `installation_repositories` events fan out to all active previews. Events with neither a resolvable repository nor installation scope are acknowledged without delivery and logged by event name and delivery ID.

The route map is saved atomically as JSON. The router also retains the latest signed `installation.created` event. A newly registered preview receives that event once so its empty database can establish current App installation and repository state. After the initial cutover, the Preview App's current installation event must be redelivered once to seed the baseline.

The router does not implement a second queue. A trusted scheduled workflow authenticates as the Preview GitHub App, lists recent failed App webhook deliveries through GitHub's cursor `Link` pagination, and requests redelivery through GitHub's API. It uses a conservative six-hour outage window, within [GitHub's three-day webhook redelivery retention](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks). The listing is bounded to three cursor pages and fails loudly if the next cursor remains before the lookback cutoff, rather than silently missing failures. If more than 100 unresolved delivery groups are eligible, the run fails before requesting any redelivery; the next scheduled run retries the same bounded window. Existing Fluent Flow webhook handlers are idempotent, so targets that accepted an earlier fan-out can safely receive the same delivery again.

The router logs decisions as structured JSON without payloads, signatures, secrets, or response bodies. Logs include the GitHub delivery ID, event name, repository, pull-request selector, route identity, and downstream status.

### Event contract

`scripts/preview-deployment.mjs` is the single event-to-deployment policy:

- Accept only `pull_request_target` events from the same repository.
- Map `opened`, `reopened`, and `synchronize` to `deploy`.
- Map `closed` to `remove`.
- Reject unsupported actions and malformed PR numbers.
- Produce the Compose project, dashboard host, API host, environment name, and head SHA.

The workflow consumes this output rather than reimplementing naming and trust checks in shell.

### Deployment lifecycle

Deploy:

1. Check out `main` for trusted deployment files.
2. Resolve the deployment contract from the event payload.
3. Check out the pull-request head into `source/`.
4. Derive per-PR secrets from the preview stack seed without writing them to logs.
5. Render and validate Compose configuration.
6. Build and reconcile the PR stack.
7. Wait for the service health endpoint and dashboard login page through their public URLs.
8. Register the active repository and pull-request route with the permanent webhook router.
9. Upsert the preview pull-request comment.

Remove:

1. Check out `main` for trusted cleanup files.
2. Resolve the same project identity from the closed event.
3. Attempt Compose down with volumes, orphan removal, and project-local image removal.
4. Remove the route even if Compose cleanup fails.
5. Update the preview pull-request comment to show removal.

Per-PR workflow concurrency cancels an older deployment for the same pull request. Different pull requests may deploy concurrently on the two G10 runners.

## Authentication and GitHub Integration

A dedicated preview GitHub App prevents pull-request runtime code from receiving production credentials. The App's OAuth callback uses `https://fluentflow.tech/api/auth/callback/github` with GitHub wildcard callback matching enabled, allowing the same path on `pr-<number>-preview.fluentflow.tech`.

The Preview App is installed only on the repositories used for Fluent Flow UAT. Its webhook URL is permanently configured as `https://preview-webhooks.fluentflow.tech/webhooks/github-app`. It is never changed for a pull request. The router authenticates GitHub with the App webhook secret, and deployment workflows authenticate route changes with a distinct secret.

## Verification

Automated contract tests prove:

- Same-repository deploy and remove events produce deterministic identities and URLs.
- Fork events are rejected.
- Unsupported actions and invalid PR numbers fail closed.
- Rendered Compose has no fixed container names or host ports.
- Each stack has its own PostgreSQL volume and internal database URL.
- Dashboard and service routes use only the expected preview hosts.
- Production environment variable names are absent from the preview workflow inputs.
- Invalid webhook signatures fail before payload parsing.
- Registration cannot create an arbitrary forwarding destination.
- Concurrent pull requests receive only their own pull-request-scoped events.
- Repository and installation events fan out to every active matching preview.
- A failed target makes the router return a server error, and the scheduled workflow requests GitHub redelivery.
- Router restart preserves the route map and installation baseline.
- Route removal prevents later delivery to the removed stack.
- Raw body bytes and the GitHub signature reach the preview service unchanged.
- A newly registered route receives the retained installation baseline once.
- The redelivery workflow follows cursor pagination, uses the six-hour window within GitHub's three-day redelivery retention, caps each run at 100 requests, ignores successful deliveries with `status_code` 200–399, and fails loudly when its bounded page traversal cannot reach the lookback cutoff or when any selected redelivery fails.

Deployment smoke checks prove:

- `GET /api/health` succeeds through the public service URL.
- `GET /login` succeeds through the public dashboard URL.
- An unauthenticated protected dashboard API remains unauthorized.
- The running containers report the expected PR head SHA.

The `Preview Full-Stack UAT` workflow is dispatched from `main` for an open same-repository pull request. It uses only trusted UAT code, validates the live containers against the pull-request head SHA, creates isolated state, drives an actual runner and browser, captures database evidence, screenshots, and sanitized runtime errors, then removes the temporary credentials and scripts.

Full-stack UAT proves:

- Password sign-in returns to the correct PR hostname and protected APIs authorize the test user.
- An actual runner registers with the preview service, claims work, streams execution events, handles permission and elicitation responses, and accepts a follow-up prompt.
- Execution history survives a browser reload and cancellation reaches a terminal state.
- Database rows for the temporary organization, project, task, runner, session, claim, events, requests, and commands match the observed UI flow.
- GitHub sign-in and live GitHub App webhooks are exercised through the fixed callback and permanent router.
- Closing the pull request removes its stack and volume.

## Operational Setup

One-time external setup:

1. Create the `fluent-flow-preview` Cloudflare Tunnel.
2. Route `*.fluentflow.tech` to the tunnel.
3. Create and install the preview GitHub App.
4. Add the preview-only repository secrets, including distinct webhook-routing and route-administration secrets.
5. Restrict the organization runner group to the production and preview workflows on `refs/heads/main`.
6. Enable public-repository use for that restricted runner group.
7. Run the preview-edge workflow once.
8. Configure the Preview App webhook URL as `https://preview-webhooks.fluentflow.tech/webhooks/github-app`.
9. Redeliver the current installation event once so the router can establish the replay baseline.

## Failure Behavior

- Missing preview secrets fail before Docker changes.
- A failed build or health check leaves the existing healthy revision running when Compose can preserve it; otherwise the PR comment reports failure and container logs are attached to the job.
- A closed-PR cleanup is idempotent when the stack is already absent.
- Tunnel or DNS failure makes public smoke checks fail; it never redirects to production.
- Database migration failure fails deployment and is visible in service logs.
- Route-map or baseline persistence failure rejects the affected change; it never reports a successful write.
- Invalid route administration credentials return a generic unauthorized response and do not reveal active routes.
- Any failed preview delivery returns a server error recorded by GitHub; the scheduled workflow requests redelivery of recent failures within the six-hour window, bounded to 100 requests per run and three cursor pages, and fails loudly when that bound is insufficient.
- An event for an unregistered pull request has no target and is acknowledged without delivery.
