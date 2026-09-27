# ===========================================================================
# ConvAI MVP — Dockerfile
# 
# Multi-stage build with non-root user (least privilege).
# Using node:20-slim (Debian) for compatibility with onnxruntime native binaries.
# ===========================================================================

FROM node:20-slim AS builder

WORKDIR /app

# Copy package files first for Docker layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code and data
COPY src/ ./src/
COPY data/ ./data/

# ── Production stage ──────────────────────────────────────────────────────
FROM node:20-slim

# Install curl for healthcheck and native dependencies (libgomp1 is required for onnxruntime-node)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates libgomp1 libatomic1 && \
    rm -rf /var/lib/apt/lists/*

# Security: non-root user (Debian syntax)
RUN groupadd -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup appuser

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy source and data from builder
COPY --from=builder --chown=appuser:appgroup /app/src ./src
COPY --from=builder --chown=appuser:appgroup /app/data ./data

# Create logs directory and relax permissions to prevent EACCES
RUN mkdir -p /app/logs && \
    chown -R appuser:appgroup /app && \
    chmod -R 777 /app/data /app/logs /app/node_modules

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check (using curl as it was installed)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
