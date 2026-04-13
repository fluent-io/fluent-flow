FROM node:20-alpine
WORKDIR /app

# Enable corepack for yarn (required by dashboard's packageManager field)
RUN corepack enable

# Copy workspace root files
COPY package*.json ./
COPY turbo.json ./

# Copy required workspace packages
COPY packages/db ./packages/db
COPY packages/dashboard ./packages/dashboard

# Install all workspace dependencies
RUN npm ci

# Build all packages (db first, then dashboard)
RUN npm run build

WORKDIR /app/packages/dashboard

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]