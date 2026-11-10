FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/fluent-flow-agent-server/package.json packages/fluent-flow-agent-server/package.json
RUN npm ci --workspace packages/fluent-flow-agent-server --include-workspace-root --omit=dev
COPY packages/fluent-flow-agent-server/bin packages/fluent-flow-agent-server/bin
COPY packages/fluent-flow-agent-server/src packages/fluent-flow-agent-server/src

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

LABEL org.opencontainers.image.source="https://github.com/fluent-io/fluent-flow" \
      org.opencontainers.image.title="fluent-flow-agent-server" \
      org.opencontainers.image.description="Portable Fluent Flow agent server with Git, GitHub CLI and the Claude and Codex ACP adapters" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git gh \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

COPY packages/fluent-flow-agent-server/docker/adapters/package.json packages/fluent-flow-agent-server/docker/adapters/package-lock.json /opt/adapters/

RUN npm ci --omit=dev --prefix /opt/adapters \
    && npm cache clean --force \
    && /opt/adapters/node_modules/.bin/claude-agent-acp --version \
    && /opt/adapters/node_modules/.bin/codex-acp --version

ENV PATH=/opt/adapters/node_modules/.bin:$PATH

COPY --from=build /app /app

RUN install -d -o 1000 -g 1000 -m 0755 /work \
    && install -d -o 1000 -g 1000 -m 0700 /home/node/.fluent-flow

ENV HOME=/home/node \
    NODE_ENV=production

WORKDIR /work
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3860/healthz', { signal: AbortSignal.timeout(4000) }).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js"]
