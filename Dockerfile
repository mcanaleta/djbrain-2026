# syntax=docker/dockerfile:1

# --- Stage 1: Build the frontend ---
FROM node:24-slim AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workers/package.json apps/workers/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable && pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# --- Stage 2: Production image ---
FROM node:24-slim

# ffprobe is needed for audio duration detection
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workers/package.json apps/workers/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Copy runtime source (runs with --experimental-strip-types, no transpile needed)
COPY apps/server/src/ apps/server/src/
COPY apps/workers/src/ apps/workers/src/
COPY packages/backend/src/ packages/backend/src/
COPY packages/shared/src/ packages/shared/src/

# Copy built frontend from builder stage
COPY --from=builder /app/dist/ dist/

# Data directory for local runtime state when a service opts into one.
ENV DJBRAIN_DATA_DIR=/data

EXPOSE 5180

CMD ["node", "--experimental-strip-types", "apps/server/src/index.ts", "--port", "5180", "--static", "dist"]
