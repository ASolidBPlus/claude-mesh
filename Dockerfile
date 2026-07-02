FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install deps separately for layer caching
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY server/*.ts ./

# Runtime
ENV MESH_DB_PATH=/data/mesh.db \
    MESH_WS_PORT=7432 \
    MESH_ADMIN_PORT=7433 \
    MESH_CLEANUP_INTERVAL_MS=60000 \
    MESH_MAX_FILE_BYTES=10485760 \
    MESH_FILES_DIR=/data/files

VOLUME /data
EXPOSE 7432 7433

ENTRYPOINT ["bun", "server.ts"]
