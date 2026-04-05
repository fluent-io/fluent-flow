---
name: Fluent Flow deployment details
description: Where Fluent Flow is deployed, how to reach it, key URLs and config
type: reference
---

**Service URL:** http://flow.fluenthive.io (Cloudflare tunnel → :3847 on G10)
**MCP endpoint:** POST http://flow.fluenthive.io/mcp
**Webhook endpoint:** POST http://flow.fluenthive.io/api/webhook/github
**Health check:** GET http://flow.fluenthive.io/api/health
**Admin API:** http://flow.fluenthive.io/api/agents (auth: Bearer MCP_AUTH_TOKEN)
**Runner API:** http://flow.fluenthive.io/api/runner/* (auth: Bearer agent token)

**Deploy process:** `ssh g10 'cd ~/fluent-flow && ./deploy.sh'` (git pull + docker compose up -d --build with override file)
**Runner update:** `cd packages/fluent-flow-runner && npm link` then restart

**DB access:** `docker exec fluent-flow-postgres-1 psql -U fluentflow -d fluentflow`
**DB container:** `fluent-flow-postgres-1`
**DB credentials:** see docker-compose.override.yml on server

**Runner agent:** `ff-runner` (claude-code, long_poll, repos: fluent-io/fluent-flow), token id: 2

**Deployed version (2026-04-05):** Agent-agnostic routing, worktree management, branch in notification payload, 8 migrations.
