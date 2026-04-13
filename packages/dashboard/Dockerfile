FROM node:20-alpine
WORKDIR /app

# Enable corepack for yarn (required by dashboard's packageManager field)
RUN corepack enable

# Copy workspace root files
COPY package*.json ./

# Copy dashboard package
COPY packages/dashboard ./packages/dashboard

# Install all workspace dependencies (including root)
RUN npm ci

# Build the dashboard Next.js app
RUN npm run build --workspace packages/dashboard

WORKDIR /app/packages/dashboard

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]