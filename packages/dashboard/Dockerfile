FROM node:24-alpine
WORKDIR /app

# Enable corepack for yarn
RUN corepack enable

# Copy workspace root files
COPY package*.json ./
COPY turbo.json ./

# Copy dashboard package
COPY packages/dashboard ./packages/dashboard

# Install workspace dependencies for dashboard (including dev)
RUN npm ci --workspace packages/dashboard

WORKDIR /app/packages/dashboard

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]