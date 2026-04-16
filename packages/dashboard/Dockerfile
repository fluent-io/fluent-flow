# Stage 1: Build @fluent-flow/db (dashboard imports from it at build time)
FROM node:20-alpine AS db-builder
WORKDIR /app

COPY package*.json turbo.json ./
COPY packages/db ./packages/db
COPY packages/fluent-flow/package.json ./packages/fluent-flow/package.json
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json

RUN npm ci --include-workspace-root
RUN npm run build --workspace packages/db

# Stage 2: Build the Next.js dashboard
FROM node:20-alpine AS dashboard-builder
WORKDIR /app

COPY package*.json turbo.json ./
COPY packages/dashboard ./packages/dashboard
COPY packages/fluent-flow/package.json ./packages/fluent-flow/package.json
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json

COPY --from=db-builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=db-builder /app/packages/db/dist ./packages/db/dist

RUN npm ci --include-workspace-root

# @fluent-flow/db opens a pg Pool at module load (client.ts). `next build`
# imports the module during static analysis, so a dummy URL is required to
# get past the Pool() construction. The build doesn't actually connect.
ARG DATABASE_URL=postgres://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL

RUN npm run build --workspace packages/dashboard

# Stage 3: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app

COPY package*.json turbo.json ./
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/fluent-flow/package.json ./packages/fluent-flow/package.json
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json

COPY --from=db-builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=db-builder /app/packages/db/dist ./packages/db/dist

# Next.js build outputs
COPY --from=dashboard-builder /app/packages/dashboard/.next ./packages/dashboard/.next
COPY --from=dashboard-builder /app/packages/dashboard/public ./packages/dashboard/public
COPY --from=dashboard-builder /app/packages/dashboard/next.config.* ./packages/dashboard/

RUN npm ci --omit=dev --include-workspace-root

WORKDIR /app/packages/dashboard

EXPOSE 3000
ENV NODE_ENV=production

CMD ["npm", "start"]
