# Per-PR Preview Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy every same-repository pull request as an isolated Fluent Flow dashboard, service, and PostgreSQL stack under `preview.app.fluentflow.tech`, then remove it when the pull request closes.

**Architecture:** A trusted `pull_request_target` workflow reads a pure event-policy module from `main`, checks out pull-request code only as a Docker build context, and deploys a project-scoped Compose stack on G10. A permanent Traefik and Cloudflare Tunnel edge stack routes wildcard preview hostnames to per-PR containers. Dedicated preview credentials keep production secrets out of pull-request runtimes.

**Tech Stack:** GitHub Actions, Node.js 20, Docker Compose, Traefik, Cloudflare Tunnel, PostgreSQL 16, Node test runner

**Spec:** `docs/superpowers/specs/2026-11-07-pr-preview-environments-design.md`

## Global Constraints

- Preview only same-repository pull requests; fork pull requests MUST stop before self-hosted runner assignment.
- Use dedicated preview credentials; production secrets and production data MUST NOT enter a preview container.
- Trusted deployment files come from `main`; pull-request code is only a Docker build context.
- URLs are exactly `pr-<number>.preview.app.fluentflow.tech` and `api-pr-<number>.preview.app.fluentflow.tech`.
- Per-PR containers, network, images, PostgreSQL volume, database password, and NextAuth secret are isolated.
- Closing a pull request removes its stack and volume without affecting another preview.
- No fixed container names or host-published application ports.
- No comments in code or workflow files.
- Existing production deployment behavior remains unchanged except for the organization runner-group access repair.

## Review Focus

- A forked pull request must never reserve a self-hosted runner or obtain preview secrets; Task 1 tests the repository boundary and Task 4 verifies the GitHub job condition.
- A stale synchronize deployment must not replace a newer head; Task 3 tests head SHA propagation and Task 4 uses per-PR concurrency cancellation.
- A closed pull request whose branch was deleted must still clean up; Task 1 tests close events without relying on head checkout and Task 4 checks out only `main` for cleanup.
- Concurrent previews must never share PostgreSQL state or routing; Task 2 renders two projects and asserts distinct volumes, networks, and host rules.
- Preview OAuth must return to the initiating PR hostname; Task 5 performs a real browser sign-in through the wildcard callback.

---

### Task 1: Deterministic preview deployment policy

**Files:**
- Create: `scripts/preview-deployment.mjs`
- Create: `scripts/preview-deployment.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `previewDeployment(event, repository) -> null | { operation, number, projectName, environmentName, dashboardHost, apiHost, headSha }`
- Produces: CLI output written to `GITHUB_OUTPUT` from `GITHUB_EVENT_PATH` and `GITHUB_REPOSITORY`.
- Consumes: GitHub `pull_request_target` payloads only.

- [ ] **Step 1: Write failing policy tests**

Add Node tests named:

- `maps same-repository opened pull request to an isolated deployment`
- `maps same-repository closed pull request to removal without requiring a live branch`
- `rejects a fork before producing deployment identity`
- `rejects unsupported pull request actions`
- `rejects invalid pull request numbers and missing head SHAs`

Assert exact project, environment, dashboard host, API host, operation, and SHA values.

- [ ] **Step 2: Run the policy tests and verify RED**

Run: `node --test scripts/preview-deployment.test.mjs`

Expected: FAIL because `scripts/preview-deployment.mjs` does not exist.

- [ ] **Step 3: Implement the policy module and CLI**

Use one exported pure function. Return `null` only for a fork. Throw for malformed or unsupported same-repository events. The CLI writes newline-delimited `key=value` records to `GITHUB_OUTPUT`; no secrets or event body are logged.

- [ ] **Step 4: Run the policy tests and verify GREEN**

Run: `node --test scripts/preview-deployment.test.mjs`

Expected: all five tests pass.

- [ ] **Step 5: Add the root preview test script and run it**

Add `test:preview` with `node --test scripts/preview-*.test.mjs`.

Run: `npm run test:preview`

Expected: all policy tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/preview-deployment.mjs scripts/preview-deployment.test.mjs
git commit -m "feat: define preview deployment contract"
```

### Task 2: Isolated preview and edge Compose stacks

**Files:**
- Create: `docker-compose.preview.yml`
- Create: `docker-compose.preview-edge.yml`
- Create: `scripts/preview-compose.test.mjs`

**Interfaces:**
- Consumes: Task 1 `projectName`, `dashboardHost`, `apiHost`, and head SHA.
- Consumes: `PREVIEW_SOURCE_DIR`, `PREVIEW_DASHBOARD_HOST`, `PREVIEW_API_HOST`, `PREVIEW_DEPLOY_SHA`, `PREVIEW_DATABASE_PASSWORD`, `PREVIEW_NEXTAUTH_SECRET`, preview GitHub credentials, and `PREVIEW_EDGE_NETWORK`.
- Produces: a three-service per-PR stack and a two-service shared edge stack.

- [ ] **Step 1: Write failing rendered-Compose tests**

The test invokes `docker compose config --format json` with disposable environment values and asserts:

- `fluent-flow`, `dashboard`, and `postgres` exist.
- No service declares `container_name`.
- No application service declares host ports.
- PostgreSQL has one project-scoped named volume.
- Dashboard and service join the external edge network; PostgreSQL does not.
- Dashboard and service labels contain only the expected preview hosts and internal ports.
- Both application services receive the expected deploy SHA.
- Database URLs point at the stack-local `postgres` service.
- Rendering two project names produces different network and volume names.
- Edge config exposes no host port and routes cloudflared to Traefik.

- [ ] **Step 2: Run the Compose tests and verify RED**

Run: `node --test scripts/preview-compose.test.mjs`

Expected: FAIL because the preview Compose files do not exist.

- [ ] **Step 3: Implement the per-PR Compose stack**

Reuse the existing application Dockerfiles. Use `${PREVIEW_SOURCE_DIR}` as both build contexts. Attach only HTTP services to `${PREVIEW_EDGE_NETWORK}`. Set Traefik routes and health checks from environment values. Do not mount the Docker socket or host paths into a PR container.

- [ ] **Step 4: Implement the shared edge Compose stack**

Run Traefik with Docker discovery disabled by default and the Docker socket mounted read-only. Run cloudflared with the named-tunnel token and `http://traefik:80` origin. Use one external network named by `${PREVIEW_EDGE_NETWORK}`.

- [ ] **Step 5: Run the Compose tests and verify GREEN**

Run: `npm run test:preview`

Expected: all policy and Compose tests pass.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.preview.yml docker-compose.preview-edge.yml scripts/preview-compose.test.mjs
git commit -m "feat: add isolated preview stacks"
```

### Task 3: Preview secret derivation and deployment commands

**Files:**
- Create: `scripts/preview-runtime.mjs`
- Create: `scripts/preview-runtime.test.mjs`

**Interfaces:**
- Consumes: Task 1 deployment identity and `PREVIEW_STACK_SECRET`.
- Produces: deterministic per-PR PostgreSQL and NextAuth values, a mode-0600 runtime env file, and Compose argument vectors for deploy/remove.
- Must never return or print production variable values.

- [ ] **Step 1: Write failing runtime tests**

Add tests named:

- `derives stable distinct secrets for different pull requests and purposes`
- `writes a mode-0600 env file without logging values`
- `produces deploy arguments bound to the trusted compose file and project`
- `produces idempotent removal arguments with volumes and local images`
- `rejects empty credentials and unsafe project names`

- [ ] **Step 2: Run the runtime tests and verify RED**

Run: `node --test scripts/preview-runtime.test.mjs`

Expected: FAIL because `scripts/preview-runtime.mjs` does not exist.

- [ ] **Step 3: Implement runtime preparation**

Use HMAC-SHA256 with distinct purpose strings for PostgreSQL and NextAuth. Write values with `fs.open` mode `0o600`. Return argument arrays rather than shell strings.

- [ ] **Step 4: Run the runtime tests and verify GREEN**

Run: `npm run test:preview`

Expected: all policy, Compose, and runtime tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/preview-runtime.mjs scripts/preview-runtime.test.mjs
git commit -m "feat: prepare preview runtime securely"
```

### Task 4: Trusted GitHub Actions lifecycle

**Files:**
- Create: `.github/workflows/preview.yml`
- Create: `.github/workflows/preview-edge.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1–3 scripts and Compose files from `main`.
- Produces: automatic same-repository PR deploy/update/remove, manual edge reconciliation, public smoke evidence, and one updatable PR comment.

- [ ] **Step 1: Add preview contract tests to hosted CI**

Run `npm run test:preview` in the existing Ubuntu CI job before the full suite.

- [ ] **Step 2: Add the trusted PR lifecycle workflow**

Use `pull_request_target` for `opened`, `reopened`, `synchronize`, and `closed`. Set the job-level same-repository condition. Use per-PR concurrency with stale deployment cancellation. Check out `main` for trusted files and the exact head SHA only into `source/` for deploy operations. Validate secrets before Docker changes. Invoke scripts with arrays, validate rendered Compose, deploy or remove, perform bounded public health checks, and upsert one marker-based PR comment.

- [ ] **Step 3: Add the manual edge workflow**

Use `workflow_dispatch`, the trusted `main` checkout, `PREVIEW_TUNNEL_TOKEN`, and the fixed edge Compose project. Create the external network idempotently, validate Compose, and reconcile the edge stack.

- [ ] **Step 4: Document operator behavior**

Document preview URLs, same-repository-only behavior, lifecycle, required dedicated secrets, edge setup, and the prohibition on production credentials. Do not document secret values.

- [ ] **Step 5: Verify workflow and Compose syntax locally**

Run:

```bash
npm run test:preview
PREVIEW_TUNNEL_TOKEN=test PREVIEW_EDGE_NETWORK=fluent-flow-preview-edge docker compose -f docker-compose.preview-edge.yml config >/dev/null
```

Expected: tests pass and Compose config exits 0.

- [ ] **Step 6: Run repository verification**

Run:

```bash
npm test
npm run build
```

Expected: all configured suites and builds pass with disposable collaboration database variables supplied.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/preview.yml .github/workflows/preview-edge.yml .github/workflows/ci.yml README.md
git commit -m "ci: deploy full-stack pull request previews"
```

### Task 5: Provision and prove the live preview platform

**Files:**
- Modify only if runtime evidence exposes a defect in Tasks 1–4.

**Interfaces:**
- Consumes: merged preview workflows, dedicated preview GitHub App credentials, Cloudflare account access, and G10 runner group administration.
- Produces: a working wildcard preview platform and retained UAT evidence on a pull request.

- [ ] **Step 1: Create dedicated Cloudflare ingress**

Create named tunnel `fluent-flow-preview`, route `*.preview.app.fluentflow.tech`, obtain its run token, and store it as `PREVIEW_TUNNEL_TOKEN` without printing it.

- [ ] **Step 2: Create dedicated preview GitHub App**

Install it only on the Fluent Flow UAT repository. Configure the wildcard-enabled callback base and preview-scoped permissions required by the server. Store only its preview credentials under `PREVIEW_*` repository secret names.

- [ ] **Step 3: Restrict and enable the organization runner group**

Restrict the group to the production deploy, preview lifecycle, and preview edge workflows on `refs/heads/main`, then permit public repositories. Confirm arbitrary workflows remain ineligible.

- [ ] **Step 4: Publish and merge the preview infrastructure PR**

Follow the repository PR flow, require hosted CI, perform whole-branch review, and merge only after a clean gate.

- [ ] **Step 5: Reconcile the edge stack**

Dispatch `preview-edge.yml` and verify Traefik and cloudflared are healthy on G10.

- [ ] **Step 6: Deploy PR 122 and perform full-stack smoke**

Trigger or resynchronize PR 122. Verify both public URLs, the PR comment, service health, login page, database migrations, and deployed SHA.

- [ ] **Step 7: Perform browser, API, runner, and database UAT**

Sign in through the PR hostname, exercise the dashboard, register a disposable runner against the preview service, execute a claim, capture screenshots, and inspect the isolated PostgreSQL state. Close or use a disposable PR to prove teardown without affecting PR 122.

- [ ] **Step 8: Record final evidence**

Add the preview URLs, workflow runs, smoke results, screenshots, database assertions, and teardown proof to the infrastructure PR or its follow-up evidence record. Do not include secrets.
