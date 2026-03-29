FROM node:20-alpine
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY turbo.json ./

# Copy the fluent-flow package
COPY packages/fluent-flow ./packages/fluent-flow

# Install all workspace dependencies
RUN npm ci --workspace=packages/fluent-flow --omit=dev

WORKDIR /app/packages/fluent-flow

CMD ["node", "src/index.js"]
