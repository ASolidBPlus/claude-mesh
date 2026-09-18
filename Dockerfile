FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install deps separately for layer caching.
#
# AT /app, NOT /app/server, and that placement is load-bearing: both halves of
# the source resolve `ws` from here. Bun searches node_modules upward from the
# IMPORTING file, so deps under /app/server would be invisible to
# /app/client/src/*.ts — which imports `ws` too.
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source — BOTH PACKAGES, AND KEEPING THEIR RELATIVE LAYOUT.
#
# The server is not self-contained and has not been since federation landed:
#
#   server/border.ts        imports ../client/src/peer-client.ts
#   server/router.ts        imports ../client/src/protocol.ts
#   server/wire-version.ts  imports ../client/src/protocol.ts
#
# `server.ts` imports `./border.ts` at its top level, so this resolves at
# STARTUP and not on first peering use: the previous image — which copied
# `server/*.ts` into /app and nothing else — died immediately with
# `Cannot find module '../client/src/peer-client.ts' from '/app/border.ts'`.
# Measured on the image built from this file's previous revision.
#
# THE OLD COPY ALSO FLATTENED THE TREE, which is why "copy client/src too" is
# not by itself the fix: with the server's files at /app/*.ts, `../client/src`
# resolves to /client/src. The paths in the imports are relative to the
# REPOSITORY layout, so the image has to keep that layout.
COPY server/*.ts ./server/
COPY client/src/*.ts ./client/src/

# THE IMAGE MUST PROVE IT CAN RESOLVE WHAT IT RUNS.
#
# An image that BUILDS is not an image that RUNS, and that gap is exactly how
# the missing half survived: `docker build` succeeded for every commit since
# federation, and nothing ever loaded the modules. `bun build` walks every
# static import transitively and fails on an unresolvable one, so a future
# `COPY` that drops a package breaks the BUILD rather than the first container
# someone starts. It resolves without executing — the output is discarded.
RUN bun build --target=bun server/server.ts --outfile=/tmp/resolve-check.js \
 && rm -f /tmp/resolve-check.js

# Runtime
ENV MESH_DB_PATH=/data/mesh.db \
    MESH_WS_PORT=7432 \
    MESH_ADMIN_PORT=7433 \
    MESH_CLEANUP_INTERVAL_MS=60000 \
    MESH_MAX_FILE_BYTES=10485760 \
    MESH_FILES_DIR=/data/files

VOLUME /data
EXPOSE 7432 7433

ENTRYPOINT ["bun", "server/server.ts"]
