# Stage 1: Build @fluent-flow/db (tsc + copy migrations/ into dist)
FROM node:20-alpine AS db-builder
WORKDIR /app

# Workspace root + all package.json files (npm workspaces needs them all present)
COPY package*.json turbo.json ./
COPY packages/db ./packages/db
COPY packages/fluent-flow/package.json ./packages/fluent-flow/package.json
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json

# Install only the db workspace's deps (includes devDeps like tsc, drizzle-kit
# needed for the build step). Avoids pulling in unrelated workspace deps.
RUN npm ci --workspace packages/db

# Emits packages/db/dist/*.js + *.d.ts and copies src/migrations into
# dist/migrations (tsc doesn't emit .sql/.json on its own).
RUN npm run build --workspace packages/db

# Stage 2: Runtime — only the pieces fluent-flow needs at run time
FROM node:20-alpine AS runtime
WORKDIR /app

COPY package*.json turbo.json ./
COPY packages/fluent-flow ./packages/fluent-flow
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json

# Pull the built @fluent-flow/db in as a workspace: package.json + dist/ only
# (no src/ or node_modules — those aren't needed at runtime).
COPY --from=db-builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=db-builder /app/packages/db/dist ./packages/db/dist

# Prod-only install for the fluent-flow workspace only. Resolves
# @fluent-flow/db via the workspace link and installs the runtime deps
# needed by fluent-flow without pulling in unrelated workspaces.
RUN npm ci --omit=dev --workspace packages/fluent-flow

WORKDIR /app/packages/fluent-flow

EXPOSE 3847

CMD ["node", "-r", "./src/tracing.cjs", "src/index.js"]
