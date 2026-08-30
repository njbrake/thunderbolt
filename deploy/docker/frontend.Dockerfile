# Stage 1: Build frontend static files
# Pinned to CI's Bun (see ci.yml `bun-version`) so the deploy build runs the
# same validated runtime. Bun implements the node:fs globSync API that
# @lingui/cli/api needs (Node >=22.19 equivalent), verified by building this
# image; bump this tag and CI together.
FROM oven/bun:1.3.14 AS build

WORKDIR /app

# Install deps first for layer caching
COPY package.json bun.lock ./
COPY shared ./shared
RUN bun install --frozen-lockfile

# Copy frontend source
COPY src ./src
COPY public ./public
COPY index.html ./
# lingui.config.ts is load-bearing: @lingui/vite-plugin resolves it at build
# time to locate and compile the .po catalogs (THU-806).
COPY vite.config.ts lingui.config.ts tsconfig.json tsconfig.node.json ./
COPY components.json ./
COPY .storybook ./.storybook

# Build args — baked into the static bundle at build time
ARG VITE_THUNDERBOLT_CLOUD_URL="/v1"
ARG VITE_AUTH_MODE="sso"
# Name on the SSO sign-in button ("Sign in with Keycloak"). Cosmetic and
# deployment-specific: this screen fronts Keycloak, Okta, Entra or Auth0 alike.
# Falls back to a generic "SSO" when empty.
ARG VITE_SSO_PROVIDER_NAME=""
ENV VITE_THUNDERBOLT_CLOUD_URL=$VITE_THUNDERBOLT_CLOUD_URL
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
ENV VITE_SSO_PROVIDER_NAME=$VITE_SSO_PROVIDER_NAME

RUN bunx vite build && \
    find dist -name '*.map' -delete

# Stage 2: Serve with nginx
FROM nginxinc/nginx-unprivileged:alpine

# Backend upstream — resolved at container start via the official nginx
# image's `envsubst` entrypoint over /etc/nginx/templates/*.template.
# Override at runtime (e.g. k8s) by setting THUNDERBOLT_BACKEND_HOST /
# THUNDERBOLT_BACKEND_PORT.
#
# Namespaced with `THUNDERBOLT_` to dodge Kubernetes' auto-injected
# `<SERVICE>_PORT` env vars: a Service named `backend` injects
# `BACKEND_PORT=tcp://10.x.y.z:8000` into every pod, which would override
# any `BACKEND_PORT=8000` default we set here and break envsubst.
ENV THUNDERBOLT_BACKEND_HOST=backend
ENV THUNDERBOLT_BACKEND_PORT=8000

# DNS server nginx resolves THUNDERBOLT_BACKEND_HOST against. The default is
# Docker's embedded resolver, which exists only inside a Docker network, so any
# other platform must override this or the `/v1/` proxy answers 502 for every
# request. Use the nameserver from the container's /etc/resolv.conf.
ENV THUNDERBOLT_BACKEND_RESOLVER=127.0.0.11

COPY deploy/config/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/config/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Keep the final-stage user explicit for Semgrep's container check.
USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
