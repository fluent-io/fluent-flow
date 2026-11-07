FROM node:24-bookworm

# gh CLI lives in its own apt repo (not in Debian bookworm main).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @agentclientprotocol/claude-agent-acp@0.101.0

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
