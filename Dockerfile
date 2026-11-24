# ─── Home on the Worker runtime + SQLite ────────────────────────
# The container runs the real Worker (src/index.tsx) on workerd, with D1 and
# both Durable Objects backed by SQLite under /data. better-sqlite3 is still
# the one native module (the boot entrypoint checkpoints an adopted database
# and the Node tools use it); the build stage carries a compiler so a platform
# without a prebuilt binary still works.

FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Native build toolchain, only in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json wrangler.jsonc ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY migrations-home ./migrations-home
COPY migrations-sompitra ./migrations-sompitra
COPY migrations-way ./migrations-way
COPY migrations-laoka ./migrations-laoka
# The messages FK parent repair (rule 19). Explicitly copied because
# .dockerignore excludes the rest of scripts/ from the build context.
COPY scripts/repair-way-messages-fk.sql ./scripts/repair-way-messages-fk.sql

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The real Worker (Sompitra + WAY + Laoka + Chat) on workerd, with D1 and the
# Durable Objects backed by SQLite in /data. See server/worker-entry.mjs.
CMD ["node", "server/worker-entry.mjs"]
