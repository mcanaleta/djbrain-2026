# syntax=docker/dockerfile:1

# --- Stage 1: Build the frontend ---
FROM node:24-slim AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# --- Stage 2: Production image ---
FROM node:24-slim

# ffprobe is needed for audio duration detection
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy server source (runs with --experimental-strip-types, no transpile needed)
COPY src/ src/

# Copy built frontend from builder stage
COPY --from=builder /app/dist/ dist/

# Data directory: SQLite DB, cache, logs
# Mount a volume here for persistence
ENV DJBRAIN_DATA_DIR=/data

# Music library: mount your music folder here
# Configure via DJBRAIN_* env vars → musicFolderPath = /music
VOLUME ["/data", "/music"]

EXPOSE 5178

CMD ["node", "--experimental-strip-types", "src/server/index.ts", "--port", "5178", "--static", "dist"]
