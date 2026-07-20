# Stage 1: Build the backend server
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/pnpm-lock.yaml* server/package-lock.json* server/pnpm-workspace.yaml* ./
COPY server/prisma/ ./prisma/
COPY server/prisma/ ./prisma_backup/
COPY server/scripts/ ./scripts/

ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install -g pnpm && pnpm install --frozen-lockfile || npm install

# Copy only backend source files (avoids copying host node_modules and sessions.db)
COPY server/app.js ./
COPY server/db.js ./
COPY server/config.toml* server/example_config.toml* ./
COPY server/handlers/ ./handlers/
COPY server/modules/ ./modules/
COPY server/public/ ./public/

# Copy the pre-built frontend dist folder directly from the context
COPY frontend/dist /frontend/dist

EXPOSE 17000

CMD ["pnpm", "start"]
