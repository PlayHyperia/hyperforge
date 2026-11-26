# ============================================================================
# Asset Forge API Server - Production Dockerfile
# ============================================================================
# Elysia API server for AI-powered 3D asset generation
# Based on Bun runtime for maximum performance
# ============================================================================

FROM oven/bun:1.3.14-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy asset-forge package.json and create a minimal root package.json
COPY packages/asset-forge/package.json ./packages/asset-forge/

# Create a minimal root package.json without workspace dependencies
RUN echo '{"name":"asset-forge-build","private":true,"workspaces":["packages/asset-forge"]}' > package.json

# Copy bun.lock for dependency resolution
COPY bun.lock ./

# Install dependencies (will only install asset-forge deps)
RUN cd packages/asset-forge && bun install --ignore-scripts || bun install

# Copy source code
COPY packages/asset-forge/ ./packages/asset-forge/

# ============================================================================
# Runtime stage
# ============================================================================
FROM oven/bun:1.3.14-alpine AS runtime

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache tini

# Copy package files
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/asset-forge ./packages/asset-forge

# Create directories for runtime
RUN mkdir -p /app/packages/asset-forge/temp-images \
    && mkdir -p /app/packages/asset-forge/gdd-assets

# Set working directory to asset-forge
WORKDIR /app/packages/asset-forge

# Expose API port
EXPOSE 3401

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3401/api/health || exit 1

# Use tini as init system
ENTRYPOINT ["/sbin/tini", "--"]

# Start the Elysia server
CMD ["bun", "run", "server/api-elysia.ts"]
