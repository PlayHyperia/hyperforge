# Multi-stage Dockerfile for Hyperia Game Server
# Builds the server with all dependencies and creates a lean runtime image

# ============================================================================
# Stage 1: Builder - Install dependencies and build packages
# ============================================================================
FROM oven/bun:1.3.14-alpine AS builder

# Install build dependencies for native modules (canvas, better-sqlite3)
RUN apk add --no-cache python3 py3-setuptools make g++ pkgconfig cairo-dev pango-dev jpeg-dev giflib-dev

WORKDIR /app

# Copy package files for dependency installation
COPY package.json bun.lock ./
COPY packages/physx-js-webidl/package.json ./packages/physx-js-webidl/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/plugin-hyperia/package.json ./packages/plugin-hyperia/

# Install dependencies (skip postinstall scripts)
RUN bun install --ignore-scripts

# Copy source code
COPY packages/physx-js-webidl ./packages/physx-js-webidl
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/plugin-hyperia ./packages/plugin-hyperia
COPY packages/client/public/physx-js-webidl.js ./packages/client/public/
COPY packages/client/public/physx-js-webidl.wasm ./packages/client/public/
COPY turbo.json ./

# Build packages in correct order
# 1. PhysX (copies prebuilt files)
WORKDIR /app/packages/physx-js-webidl
RUN bun run build || echo "PhysX build skipped"

# 2. Shared (core engine)
WORKDIR /app/packages/shared
RUN bun run build

# 3. Server (game server)
WORKDIR /app/packages/server
RUN bun run build

# ============================================================================
# Stage 2: Runtime - Minimal production image
# ============================================================================
FROM oven/bun:1.3.14-alpine AS runtime

# Install runtime dependencies for native modules
RUN apk add --no-cache python3 py3-setuptools make g++ pkgconfig cairo-dev pango-dev jpeg-dev giflib-dev ffmpeg

RUN ffmpeg -version && ffprobe -version

WORKDIR /app

# Install production dependencies only
COPY package.json bun.lock ./
COPY packages/physx-js-webidl/package.json ./packages/physx-js-webidl/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/plugin-hyperia/package.json ./packages/plugin-hyperia/
RUN bun install --production --ignore-scripts

# Copy built artifacts from builder (excluding large assets - they're served from CDN)
COPY --from=builder /app/packages/physx-js-webidl/dist ./packages/physx-js-webidl/dist
COPY --from=builder /app/packages/shared/build ./packages/shared/build
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/plugin-hyperia ./packages/plugin-hyperia

# Create world directory structure and copy manifests where server expects them
RUN mkdir -p ./packages/server/world/assets/manifests

# Copy manifests (small JSON files needed for server-side logic)
COPY assets/manifests ./packages/server/world/assets/manifests

# Copy server source files needed at runtime
COPY --from=builder /app/packages/server/src ./packages/server/src

# Set working directory to server
WORKDIR /app/packages/server

# Expose WebSocket port
EXPOSE 5555

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun run -e "fetch('http://localhost:5555/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server
CMD ["bun", "run", "start"]
