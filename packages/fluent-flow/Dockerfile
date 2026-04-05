FROM node:20-alpine
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY turbo.json ./

# Copy all workspace packages (required by workspace resolution)
COPY packages/fluent-flow ./packages/fluent-flow
COPY packages/fluent-flow-runner/package.json ./packages/fluent-flow-runner/package.json

# Install workspace dependencies
RUN npm ci --omit=dev --workspace packages/fluent-flow

WORKDIR /app/packages/fluent-flow

EXPOSE 3847

CMD ["node", "-r", "./src/tracing.cjs", "src/index.js"]
