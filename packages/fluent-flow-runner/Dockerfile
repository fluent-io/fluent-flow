# Reference Dockerfile for fluent-flow-runner deployment.
# See README.md "Docker Deployment" section for full documentation.

FROM node:24-bookworm

# Install git, SSH client, and GitHub CLI
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code (or your preferred AI agent CLI)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY packages/fluent-flow-runner/package.json packages/fluent-flow-runner/package.json
RUN npm ci --workspace packages/fluent-flow-runner --include-workspace-root
COPY packages/fluent-flow-runner packages/fluent-flow-runner

# Work dir owned by node (uid 1000 matches host user for volume perms)
RUN mkdir -p /work && chown node:node /work

WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/packages/fluent-flow-runner/bin/fluent-flow-runner.js"]
