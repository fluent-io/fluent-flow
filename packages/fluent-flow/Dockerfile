# Stage 1: Build @fluent-flow/db (tsc + copy migrations/ into dist)
FROM node:20-alpine AS db-builder
WORKDIR /app

# Workspace root + all package.json files (npm workspaces needs them all present)
COPY package*.json turbo.json ./
COPY packages/db ./packages/db
COPY packages/fluent-flow/package.json ./packages/fluent-flow/package.json
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json

# Install every workspace's deps — @fluent-flow/db's devDeps (tsc, drizzle-kit)
# are required to run the build step below.
RUN npm ci --include-workspace-root

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

# Prod-only install. Resolves @fluent-flow/db via workspace symlink and
# installs its runtime deps (drizzle-orm, drizzle-zod, pg, zod) alongside
# fluent-flow's own prod deps.
RUN npm ci --omit=dev --include-workspace-root

WORKDIR /app/packages/fluent-flow

EXPOSE 3847

CMD ["node", "-r", "./src/tracing.cjs", "src/index.js"]
