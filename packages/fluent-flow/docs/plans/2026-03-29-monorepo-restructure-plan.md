# Monorepo Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Fluent Flow repo into a Turborepo monorepo with the server in `packages/fluent-flow/`, preparing for the runner package and future dashboard.

**Architecture:** Move all server code into `packages/fluent-flow/`. Root becomes the monorepo orchestration layer with Turborepo, npm workspaces, and shared config. No functional changes — all tests must pass identically after restructure.

**Tech Stack:** Turborepo, npm workspaces, Node.js 20, ESM

---

## What moves where

### Stays at root
- `CLAUDE.md` — project-wide instructions
- `README.md` — becomes monorepo overview (rewritten)
- `LICENSE`
- `.gitignore` — updated for monorepo
- `.github/` — workflows updated for monorepo paths
- `docker-compose.yml` — updated build context
- `turbo.json` — new
- `package.json` — new root workspace config

### Moves to `packages/fluent-flow/`
- `src/` → `packages/fluent-flow/src/`
- `config/` → `packages/fluent-flow/config/`
- `tests/` → `packages/fluent-flow/tests/`
- `scripts/` → `packages/fluent-flow/scripts/`
- `docs/` → `packages/fluent-flow/docs/`
- `prompts/` → `packages/fluent-flow/prompts/`
- `Dockerfile` → `packages/fluent-flow/Dockerfile`
- `package.json` → `packages/fluent-flow/package.json` (current, unchanged)
- `package-lock.json` → regenerated at root
- `.env.example` → `packages/fluent-flow/.env.example`
- `DESIGN.md` → `packages/fluent-flow/DESIGN.md`
- `CONTRIBUTING.md` → `packages/fluent-flow/CONTRIBUTING.md`

---

## Task 1: Create root monorepo config

**Files:**
- Create: `package.json` (root, new)
- Create: `turbo.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "fluent-flow-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "dev": "turbo run dev"
  },
  "devDependencies": {
    "turbo": "^2.5.0"
  }
}
```

- [ ] **Step 2: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- [ ] **Step 3: Commit (do not run npm install yet)**

```bash
git add package.json turbo.json
git commit -m "chore: add root monorepo config with Turborepo"
```

---

## Task 2: Move server files to packages/fluent-flow/

This is the big move. Use `git mv` to preserve history.

- [ ] **Step 1: Create packages directory**

```bash
mkdir -p packages/fluent-flow
```

- [ ] **Step 2: Move server files**

```bash
git mv src packages/fluent-flow/
git mv config packages/fluent-flow/
git mv tests packages/fluent-flow/
git mv scripts packages/fluent-flow/
git mv docs packages/fluent-flow/
git mv prompts packages/fluent-flow/
git mv Dockerfile packages/fluent-flow/
git mv .env.example packages/fluent-flow/
git mv DESIGN.md packages/fluent-flow/
git mv CONTRIBUTING.md packages/fluent-flow/
```

- [ ] **Step 3: Move package.json and lock file**

The current `package.json` becomes the server package. Root already has the new one from Task 1.

```bash
git mv package.json packages/fluent-flow/package.json
rm package-lock.json
```

Note: `package-lock.json` will be regenerated at root by npm workspaces.

- [ ] **Step 4: Commit the move**

```bash
git add -A
git commit -m "chore: move server files to packages/fluent-flow/"
```

---

## Task 3: Update Docker and docker-compose

**Files:**
- Modify: `docker-compose.yml`
- Modify: `packages/fluent-flow/Dockerfile`

- [ ] **Step 1: Update docker-compose.yml build context**

```yaml
services:
  fluent-flow:
    build: ./packages/fluent-flow
    container_name: fluent-flow
    ports:
      - "3847:3847"
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgres://fluentflow:password@postgres:5432/fluentflow}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET}
      PORT: 3847
      CONFIG_CACHE_TTL_MS: 300000
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:-}
    volumes:
      - ./packages/fluent-flow/config:/app/config:ro
    networks:
      - fluent-flow-net
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: fluentflow
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-password}
      POSTGRES_DB: fluentflow
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - fluent-flow-net
    restart: unless-stopped

volumes:
  pgdata:

networks:
  fluent-flow-net:
    driver: bridge
```

- [ ] **Step 2: Dockerfile stays the same**

The Dockerfile is relative to its own directory (build context = `./packages/fluent-flow`), so paths like `COPY package*.json ./` and `COPY . .` still work. No changes needed.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: update docker-compose build context for monorepo"
```

---

## Task 4: Update CI workflows

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update CI to run in server package directory**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
          cache-dependency-path: packages/fluent-flow/package-lock.json

      - name: Install dependencies
        run: npm ci
        working-directory: packages/fluent-flow

      - name: Run tests
        run: npm test
        working-directory: packages/fluent-flow
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "chore: update CI workflow for monorepo paths"
```

---

## Task 5: Update .gitignore and root README

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Update .gitignore for monorepo**

```
node_modules/
.env
.env.local
.env.*.local
*.log
dist/
coverage/
.DS_Store
.idea/
.vscode/
*.swp
*.swo
tmp/
.turbo/

# Deployment-specific overrides — configure locally, never commit
packages/fluent-flow/config/agents.yml
docker-compose.override.yml
```

- [ ] **Step 2: Rewrite root README.md**

```markdown
# Fluent Flow

Monorepo for the Fluent Flow platform — a config-driven GitHub workflow orchestrator.

## Packages

| Package | Description |
|---|---|
| [packages/fluent-flow](packages/fluent-flow/) | Server — webhook handler, state machine, review pipeline, agent work queue |

## Getting Started

```bash
npm install        # install root + all packages
npm test           # run all tests via Turborepo
```

### Server

```bash
cd packages/fluent-flow
npm run dev
```

### Docker

```bash
docker compose up -d --build
```

## Architecture

See [packages/fluent-flow/README.md](packages/fluent-flow/README.md) for server documentation.
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore README.md
git commit -m "chore: update .gitignore and root README for monorepo"
```

---

## Task 6: Update CLAUDE.md references

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md paths**

Update all path references to point to `packages/fluent-flow/`:
- `config/README.md` → `packages/fluent-flow/config/README.md`
- `src/engine/README.md` → `packages/fluent-flow/src/engine/README.md`
- `src/mcp/README.md` → `packages/fluent-flow/src/mcp/README.md`
- `src/notifications/README.md` → `packages/fluent-flow/src/notifications/README.md`
- `DESIGN.md` → `packages/fluent-flow/DESIGN.md`
- Test command: `npm test` → `cd packages/fluent-flow && npm test` (or `npm test` at root via Turborepo)

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "chore: update CLAUDE.md paths for monorepo"
```

---

## Task 7: Install dependencies and verify

- [ ] **Step 1: Install root dependencies (Turborepo)**

```bash
npm install
```

This creates the root `package-lock.json` and installs Turborepo + hoists workspace dependencies.

- [ ] **Step 2: Run tests from the server package**

```bash
cd packages/fluent-flow && npm test
```

Expected: All 320 tests pass.

- [ ] **Step 3: Run tests via Turborepo from root**

```bash
npm test
```

Expected: Turborepo runs `test` task in `packages/fluent-flow`, 320 tests pass.

- [ ] **Step 4: Commit lock file**

```bash
git add package-lock.json
git commit -m "chore: regenerate package-lock.json for npm workspaces"
```

---

## Task 8: Final verification

- [ ] **Step 1: Verify Docker build**

```bash
docker compose build fluent-flow
```

Expected: Build succeeds with new context path.

- [ ] **Step 2: Verify all files in correct location**

```bash
ls packages/fluent-flow/src/index.js
ls packages/fluent-flow/config/defaults.yml
ls packages/fluent-flow/tests/unit/
ls packages/fluent-flow/Dockerfile
ls turbo.json
```

- [ ] **Step 3: Verify nothing left at root that should have moved**

```bash
# These should NOT exist at root:
test ! -d src && test ! -d tests && test ! -d scripts && echo "Clean"
```
