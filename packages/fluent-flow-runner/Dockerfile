# Fluent Flow runner image — designed to run alongside the Fluent Flow server
# (see docker-compose.yml) on the machine where the AI harness CLIs live.
#
# Key decisions:
# - `gh` CLI is REQUIRED by the review agent prompt (it fetches the PR diff and
#   posts the review via `gh api`). Without it, review claims complete without
#   posting anything — a silent no-op pipeline.
# - Runs as USER node (uid 1000) to match host volume ownership.
# - Compose sets `init: true` so PID 1 reaps the harness's orphaned
#   grandchildren (git/gh/ripgrep). Node as PID 1 does not, and long-lived
#   runner containers accumulate zombies without it.
FROM node:24-bookworm

# gh CLI lives in its own apt repo (not in Debian bookworm main).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client gh \
    && rm -rf /var/lib/apt/lists/*

# Default harness. Mount/extend for codex/aider-based agents.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY packages/fluent-flow-runner/package.json packages/fluent-flow-runner/package.json
RUN npm ci --workspace packages/fluent-flow-runner --include-workspace-root
COPY packages/fluent-flow-runner packages/fluent-flow-runner

# Work dir owned by node (uid 1000) — matches the host user for volume perms.
RUN mkdir -p /work && chown node:node /work

WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/packages/fluent-flow-runner/bin/fluent-flow-runner.js"]
