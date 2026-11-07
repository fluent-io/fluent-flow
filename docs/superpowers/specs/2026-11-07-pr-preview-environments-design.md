# Per-PR Preview Environments

**Date:** 2026-11-07
**Status:** Approved for implementation

## Context

Fluent Flow has CI for pull requests and a production Docker Compose deployment for `main`, but no deployed pull-request surface. Production runs on the G10 self-hosted runner behind Cloudflare. The repository is public, while the organization runner group currently rejects public repositories. Pull requests therefore cannot be verified against a real dashboard, service, database, migrations, authentication flow, or runner API before merge.

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
- Automatic webhook fan-out to every active preview.
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
- Both containers use the external Docker network `fluent-flow-preview-edge`.
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
8. Upsert the preview pull-request comment.

Remove:

1. Check out `main` for trusted cleanup files.
2. Resolve the same project identity from the closed event.
3. Run Compose down with volumes, orphan removal, and project-local image removal.
4. Update the preview pull-request comment to show removal.

Per-PR workflow concurrency cancels an older deployment for the same pull request. Different pull requests may deploy concurrently on the two G10 runners.

## Authentication and GitHub Integration

A dedicated preview GitHub App prevents pull-request runtime code from receiving production credentials. The App's OAuth callback uses `https://fluentflow.tech/api/auth/callback/github` with GitHub wildcard callback matching enabled, allowing the same path on `pr-<number>-preview.fluentflow.tech`.

The preview App is installed only on the repository used for Fluent Flow UAT. Its fixed webhook URL may be pointed at the pull request currently undergoing live GitHub-event UAT. Generic preview deployment does not fan webhook events to every stack.

## Verification

Automated contract tests prove:

- Same-repository deploy and remove events produce deterministic identities and URLs.
- Fork events are rejected.
- Unsupported actions and invalid PR numbers fail closed.
- Rendered Compose has no fixed container names or host ports.
- Each stack has its own PostgreSQL volume and internal database URL.
- Dashboard and service routes use only the expected preview hosts.
- Production environment variable names are absent from the preview workflow inputs.

Deployment smoke checks prove:

- `GET /api/health` succeeds through the public service URL.
- `GET /login` succeeds through the public dashboard URL.
- An unauthenticated protected dashboard API remains unauthorized.
- The running containers report the expected PR head SHA.

Manual UAT proves:

- GitHub sign-in returns to the correct PR hostname.
- Database state is isolated between two simultaneous previews.
- A local runner can register with a preview service and execute a claim.
- Closing one pull request removes only its stack and volume.

## Operational Setup

One-time external setup:

1. Create the `fluent-flow-preview` Cloudflare Tunnel.
2. Route `*.fluentflow.tech` to the tunnel.
3. Create and install the preview GitHub App.
4. Add the preview-only repository secrets.
5. Restrict the organization runner group to the production and preview workflows on `main`.
6. Enable public-repository use for that restricted runner group.
7. Run the preview-edge workflow once.

## Failure Behavior

- Missing preview secrets fail before Docker changes.
- A failed build or health check leaves the existing healthy revision running when Compose can preserve it; otherwise the PR comment reports failure and container logs are attached to the job.
- A closed-PR cleanup is idempotent when the stack is already absent.
- Tunnel or DNS failure makes public smoke checks fail; it never redirects to production.
- Database migration failure fails deployment and is visible in service logs.
