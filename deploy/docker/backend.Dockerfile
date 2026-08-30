# Single stage: Bun runtime with source
FROM oven/bun:1.3.14

# Dependencies are installed at /app, not /app/backend, so that BOTH /app/backend
# and /app/shared resolve them: Node resolution walks up from the importing file,
# and a module under /app/shared can never see /app/backend/node_modules. The
# backend imports `@shared/agent-core`, which pulls the Pi packages, so the
# shared tree needs them in scope or the server crashes on boot.
WORKDIR /app

# Install deps (hoisted — see above)
COPY --chown=1000:1000 backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile && chown 1000:1000 /app

WORKDIR /app/backend

# Copy source
COPY --chown=1000:1000 backend/src ./src
COPY --chown=1000:1000 backend/tsconfig.json ./
COPY --chown=1000:1000 backend/drizzle ./drizzle
COPY --chown=1000:1000 backend/drizzle.config.ts ./
COPY --chown=1000:1000 shared /app/shared

# Entrypoint: run migrations then start server
COPY --chmod=755 --chown=1000:1000 deploy/docker/backend-entrypoint.sh ./entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

USER 1000

ENTRYPOINT ["./entrypoint.sh"]
