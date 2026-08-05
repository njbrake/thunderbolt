#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Provision a Thunderbolt stack on Railway. See ./README.md for prerequisites.
#
# Railway has no shared path-based ingress, so unlike the Docker Compose, Helm,
# and Pulumi paths this deploys four separately-addressed public services and
# wires them together by URL. The frontend's nginx `/v1/` proxy is unused here
# (its `resolver 127.0.0.11` is Docker-specific); the SPA calls the backend
# domain directly instead, which is why VITE_THUNDERBOLT_CLOUD_URL is absolute.
#
# Idempotent: re-running skips services that already exist and refreshes
# variables. Secrets are generated once and cached in .railway-secrets.env.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-thunderbolt}"
WORKSPACE="${WORKSPACE:-}"
REPO="${REPO:-}"
BRANCH="${BRANCH:-main}"
# source: connect the GitHub repo, so pushes redeploy. Needs the Railway GitHub
#   app authorized on REPO, and the branch must already be pushed.
# up:     upload the working tree as the build context. No GitHub involvement, so
#   it works with an unpushed branch, but there is no push-to-deploy afterwards.
DEPLOY_MODE="${DEPLOY_MODE:-source}"
SECRETS_FILE="${SECRETS_FILE:-$(cd "$(dirname "$0")" && pwd)/.railway-secrets.env}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Service names double as private DNS labels (<name>.railway.internal), so
# changing them means changing every URI below.
SVC_PG=postgres
SVC_KC=keycloak
SVC_PS=powersync
SVC_BE=backend
SVC_FE=frontend

die() {
  echo "error: $*" >&2
  exit 1
}
log() { echo "==> $*"; }

command -v railway >/dev/null || die "railway CLI not found. See README.md."
command -v jq >/dev/null || die "jq not found (used to parse CLI JSON output)."

# `railway whoami` is deliberately not the auth check: it is an account-level
# call and fails under a project token even when every command this script needs
# succeeds. `railway status` is project-scoped, so it is the real signal.
railway status >/dev/null 2>&1 ||
  die "no project context. Export RAILWAY_TOKEN=<project token>, or run 'railway login' && 'railway link'."

case "$DEPLOY_MODE" in
  source)
    [ -n "$REPO" ] || die "DEPLOY_MODE=source needs REPO=<owner>/<fork>."
    ;;
  up) ;;
  *) die "DEPLOY_MODE must be 'source' or 'up' (got '$DEPLOY_MODE')." ;;
esac

# --- secrets -----------------------------------------------------------------
# Hex-only, for two reasons: the values embed in postgres:// URIs without
# percent-encoding, and `railway variable set K=V` splits on the first `=`, so
# base64 padding is a hazard. POWERSYNC_JWT_SECRET must be >=32 chars, enforced
# in backend/src/config/settings.ts.
if [ -f "$SECRETS_FILE" ]; then
  log "reusing secrets from $SECRETS_FILE"
else
  log "generating secrets into $SECRETS_FILE"
  umask 077
  cat >"$SECRETS_FILE" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POWERSYNC_DB_PASSWORD=$(openssl rand -hex 24)
OIDC_CLIENT_SECRET=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
POWERSYNC_JWT_SECRET=$(openssl rand -hex 24)
KC_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)
EOF
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# PowerSync verifies the JWT the backend signs, keyed by kid. `k` must be
# base64 of the same secret the backend uses (deploy/config/powersync-config.yaml).
PS_JWT_KEY_BASE64="$(printf '%s' "$POWERSYNC_JWT_SECRET" | base64 | tr -d '\n')"
PS_JWT_KID=enterprise-powersync

# --- project ------------------------------------------------------------------
if railway status >/dev/null 2>&1; then
  log "using already-linked project"
else
  log "creating project '$PROJECT_NAME'"
  if [ -n "$WORKSPACE" ]; then
    railway init --name "$PROJECT_NAME" --workspace "$WORKSPACE" --json >/dev/null
  else
    railway init --name "$PROJECT_NAME" --json >/dev/null
  fi
fi

existing_services() { railway service list --json 2>/dev/null || echo '[]'; }

# Created without a source on purpose. Attaching the repo immediately would
# kick off a build before any variables exist, and the frontend bakes
# VITE_THUNDERBOLT_CLOUD_URL into its bundle at build time, so that first build
# would ship a bundle pointing at the wrong API. Sources are connected last.
ensure_service() {
  local name="$1"
  if existing_services | jq -e --arg n "$name" '[.. | strings] | index($n)' >/dev/null 2>&1; then
    log "service '$name' exists, skipping create"
    return
  fi
  log "creating service '$name'"
  railway add --service "$name" >/dev/null
}

# --skip-deploys batches variable writes so each service builds once, at the end.
setvar() {
  local svc="$1"
  shift
  for kv in "$@"; do
    railway variable set "$kv" --service "$svc" --skip-deploys --json >/dev/null
  done
}

for s in "$SVC_PG" "$SVC_KC" "$SVC_PS" "$SVC_BE" "$SVC_FE"; do
  ensure_service "$s"
done

# --- postgres -----------------------------------------------------------------
# PGDATA points at a subdirectory: a Railway volume mounts with a lost+found
# entry, and initdb refuses a non-empty target. The Helm chart does the same.
log "configuring $SVC_PG"
setvar "$SVC_PG" \
  "RAILWAY_DOCKERFILE_PATH=deploy/docker/postgres.Dockerfile" \
  "PGDATA=/var/lib/postgresql/data/pgdata" \
  "POSTGRES_USER=postgres" \
  "POSTGRES_DB=postgres" \
  "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  "POWERSYNC_DB_PASSWORD=$POWERSYNC_DB_PASSWORD"

# wal_level=logical is not set here. Railway has no start-command variable
# (RAILWAY_DOCKERFILE_PATH has no deploy-side equivalent) and railway.json is
# resolved per-service from the repo root, which a five-service monorepo cannot
# use. It is baked into deploy/docker/postgres.Dockerfile's CMD instead.

# Volumes go through the GraphQL API rather than the CLI. `railway volume add`
# takes no --service and attaches to the *linked* service, but `railway link`
# and `railway service link` are account-level operations that a project token
# cannot perform. Passing --service to the parent command
# (`railway volume --service X add`) panics the CLI (v5.30.4, volume.rs:836).
#
# Note the header: project tokens authenticate mutations via
# Project-Access-Token. An `Authorization: Bearer` project token passes
# introspection but returns "Not Authorized" on volumeCreate.
gql_project() {
  curl -s -X POST https://backboard.railway.com/graphql/v2 \
    -H "Project-Access-Token: $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1"
}

ensure_volume() {
  local svc_id="$1" path="$2" name="$3" resp
  if railway volume list --json 2>/dev/null | grep -q "$path"; then
    log "volume $path already present, skipping"
    return
  fi
  resp="$(gql_project "$(jq -n \
    --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$svc_id" --arg m "$path" \
    '{query:"mutation($p:String!,$e:String,$s:String,$m:String!){volumeCreate(input:{projectId:$p,environmentId:$e,serviceId:$s,mountPath:$m}){id name}}",
      variables:{p:$p,e:$e,s:$s,m:$m}}')")"
  if echo "$resp" | jq -e '.data.volumeCreate.id' >/dev/null 2>&1; then
    log "attached volume $path to $name"
  else
    die "volumeCreate failed for $name: $(echo "$resp" | jq -c '.errors // .' 2>/dev/null)"
  fi
}

service_id() {
  railway service list --json 2>/dev/null |
    jq -r --arg n "$1" '.[] | select(.name==$n) | .id'
}

PROJECT_ID="$(railway status --json 2>/dev/null | jq -r '.id // empty')"
ENVIRONMENT_ID="$(railway status --json 2>/dev/null | jq -r '.environments.edges[0].node.id // empty')"
[ -n "$PROJECT_ID" ] && [ -n "$ENVIRONMENT_ID" ] || die "could not read project/environment id from 'railway status --json'"

ensure_volume "$(service_id "$SVC_PG")" /var/lib/postgresql/data "$SVC_PG"

# Keycloak deliberately gets NO volume. Railway mounts volumes root-owned and the
# Keycloak image runs non-root, so a mount at /opt/keycloak/data makes H2 fail on
# boot with `AccessDeniedException: /opt/keycloak/data/h2` while the deployment
# still reports SUCCESS and the domain serves 502. Persisting the dev-mode H2 file
# buys little, since --import-realm rebuilds the realm, client and demo user on
# every boot. A volume here would additionally need RAILWAY_RUN_UID=0.

# --- domains ------------------------------------------------------------------
# Generated before the URL-dependent variables below, because each service needs
# to know the others' hostnames. Postgres is deliberately left private.
# Pulls the first `domain` field at any nesting depth, so this survives changes
# to the CLI's JSON envelope.
read_domain() {
  railway domain list --service "$1" --json 2>/dev/null |
    jq -r '[.. | objects | .domain? // empty] | map(select(. != null and . != "")) | first // empty' 2>/dev/null
}

ensure_domain() {
  local svc="$1" port="$2" host
  host="$(read_domain "$svc")"
  if [ -z "$host" ]; then
    railway domain --service "$svc" --port "$port" >/dev/null
    host="$(read_domain "$svc")"
  fi
  [ -n "$host" ] || die "could not resolve a domain for '$svc'. Run 'railway domain --service $svc --port $port' manually."
  echo "$host"
}

log "generating domains"
# Target ports are explicit because none of these images read Railway's $PORT:
# nginx has `listen 80`, PowerSync has `port: 8080` in its config, Keycloak
# takes KC_HTTP_PORT. The backend does read $PORT (settings.ts), so 8000 below
# just matches its Dockerfile default.
FE_HOST="$(ensure_domain "$SVC_FE" 80)"
BE_HOST="$(ensure_domain "$SVC_BE" 8000)"
KC_HOST="$(ensure_domain "$SVC_KC" 8080)"
PS_HOST="$(ensure_domain "$SVC_PS" 8080)"

APP_URL="https://$FE_HOST"
API_URL="https://$BE_HOST"
KC_URL="https://$KC_HOST"
PS_URL="https://$PS_HOST"

# --- keycloak -----------------------------------------------------------------
# The realm JSON uses Keycloak's ${VAR:default} substitution, so redirect URI,
# web origin, and client secret are all set here rather than by editing the file.
# The callback lives on the BACKEND origin (Better Auth handles /v1/api/auth/...),
# while the web origin is the frontend. deploy/pulumi/src/services.ts makes the
# same split.
log "configuring $SVC_KC"
setvar "$SVC_KC" \
  "RAILWAY_DOCKERFILE_PATH=deploy/docker/keycloak.Dockerfile" \
  "KC_HTTP_PORT=8080" \
  "KC_HTTP_ENABLED=true" \
  "KC_PROXY_HEADERS=xforwarded" \
  "KC_HOSTNAME=$KC_URL" \
  "KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true" \
  "KC_BOOTSTRAP_ADMIN_USERNAME=admin" \
  "KC_BOOTSTRAP_ADMIN_PASSWORD=$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  "OIDC_REDIRECT_URI=$API_URL/v1/api/auth/sso/callback/sso" \
  "OIDC_WEB_ORIGIN=$APP_URL" \
  "OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET"

# --- powersync ----------------------------------------------------------------
# sslmode=disable is already set in powersync-config.yaml and is correct here:
# Railway's private network is Wireguard-encrypted and this Postgres serves no
# TLS. Storage points at our own container, so the RDS/PG17 storage hang
# documented in deploy/README.md does not apply.
log "configuring $SVC_PS"
setvar "$SVC_PS" \
  "RAILWAY_DOCKERFILE_PATH=deploy/docker/powersync.Dockerfile" \
  "PS_PG_URI=postgresql://powersync_role:$POWERSYNC_DB_PASSWORD@$SVC_PG.railway.internal:5432/postgres" \
  "PS_STORAGE_URI=postgresql://postgres:$POSTGRES_PASSWORD@$SVC_PG.railway.internal:5432/powersync_storage" \
  "PS_JWT_KEY_BASE64=$PS_JWT_KEY_BASE64" \
  "PS_JWT_KID=$PS_JWT_KID"

# --- backend ------------------------------------------------------------------
# OIDC_ISSUER must equal KC_HOSTNAME: it is what Keycloak stamps into token `iss`
# and what Better Auth validates. Discovery goes over the private network so it
# does not depend on public DNS, and KC_HOSTNAME_BACKCHANNEL_DYNAMIC keeps the
# returned token/jwks endpoints internal too.
# POWERSYNC_URL is echoed to the browser, so it must be the public domain.
#
# BETTER_AUTH_URL is the BACKEND origin while APP_URL is the frontend. They are
# the same value in docker-compose and under the ALB only because a single origin
# proxies /v1 to the backend there. Here they must differ: Better Auth derives its
# own base from BETTER_AUTH_URL (see `backendOrigin` in backend/src/auth/auth.ts)
# and builds the OIDC redirect_uri as <BETTER_AUTH_URL>/v1/api/auth/sso/callback/sso.
# Point it at the frontend and Keycloak rejects the handshake with
# "Invalid parameter: redirect_uri", because the realm registers the backend
# callback (OIDC_REDIRECT_URI above). Cross-origin API calls are unaffected: the
# web client authenticates with a bearer token from localStorage, not a cookie.
log "configuring $SVC_BE"
setvar "$SVC_BE" \
  "RAILWAY_DOCKERFILE_PATH=deploy/docker/backend.Dockerfile" \
  "NODE_ENV=production" \
  "PORT=8000" \
  "AUTH_MODE=oidc" \
  "WAITLIST_ENABLED=false" \
  "RATE_LIMIT_ENABLED=false" \
  "DATABASE_DRIVER=postgres" \
  "DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@$SVC_PG.railway.internal:5432/postgres" \
  "OIDC_ISSUER=$KC_URL/realms/thunderbolt" \
  "OIDC_DISCOVERY_URL=http://$SVC_KC.railway.internal:8080/realms/thunderbolt/.well-known/openid-configuration" \
  "OIDC_CLIENT_ID=thunderbolt-app" \
  "OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET" \
  "APP_URL=$APP_URL" \
  "BETTER_AUTH_URL=$API_URL" \
  "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET" \
  "TRUSTED_ORIGINS=$APP_URL,$API_URL,$KC_URL,http://$SVC_KC.railway.internal:8080" \
  "CORS_ORIGINS=$APP_URL" \
  "POWERSYNC_URL=$PS_URL" \
  "POWERSYNC_JWT_SECRET=$POWERSYNC_JWT_SECRET" \
  "POWERSYNC_JWT_KID=$PS_JWT_KID"

# --- frontend -----------------------------------------------------------------
# Railway exposes service variables to the Docker build as ARGs, and
# frontend.Dockerfile already declares ARG VITE_THUNDERBOLT_CLOUD_URL /
# ARG VITE_AUTH_MODE, so no Dockerfile change is needed. These are baked into
# the bundle at build time: changing the backend domain requires a rebuild, not
# just a restart. A literal value is used rather than a ${{backend.*}} reference
# so the build does not depend on reference-variable resolution ordering.
log "configuring $SVC_FE"
setvar "$SVC_FE" \
  "RAILWAY_DOCKERFILE_PATH=deploy/docker/frontend.Dockerfile" \
  "VITE_THUNDERBOLT_CLOUD_URL=$API_URL/v1" \
  "VITE_AUTH_MODE=sso"

# --- connect sources and deploy -----------------------------------------------
# Connecting the repo is what triggers the first build, now that every variable
# is in place. Postgres goes first: the backend entrypoint polls it and runs
# migrations before serving, and PowerSync needs the powersync_role and the
# powersync_storage database that Postgres creates on first init. Railway's
# private network is runtime-only, so none of that can happen during a build.
deploy_service() {
  local svc="$1"
  if [ "$DEPLOY_MODE" = "up" ]; then
    log "uploading and deploying $svc"
    # Run from the repo root: the Dockerfiles COPY from there (backend/, shared/,
    # deploy/config/), so the build context must be the root regardless of which
    # Dockerfile RAILWAY_DOCKERFILE_PATH selects.
    (cd "$REPO_ROOT" && railway up --service "$svc" --detach >/dev/null 2>&1) ||
      log "  upload failed for $svc"
    return
  fi
  log "connecting $svc to $REPO@$BRANCH"
  if railway service source connect --repo "$REPO" --branch "$BRANCH" --service "$svc" >/dev/null 2>&1; then
    return
  fi
  log "  source already connected, redeploying instead"
  railway service redeploy --service "$svc" --from-source --yes >/dev/null 2>&1 ||
    log "  could not trigger a deploy for $svc; start it from the dashboard"
}

for s in "$SVC_PG" "$SVC_KC" "$SVC_PS" "$SVC_BE" "$SVC_FE"; do
  deploy_service "$s"
done

cat <<EOF

Stack provisioned.

  App        $APP_URL
  Backend    $API_URL
  Keycloak   $KC_URL  (admin console at /admin)
  PowerSync  $PS_URL

Demo user:  demo@thunderbolt.io / demo
Keycloak admin user: admin  (password is in $SECRETS_FILE)

$SECRETS_FILE holds every generated credential. It is gitignored. Keep it if you
want re-runs to preserve the stack; delete it and the next run mints new secrets,
which will not match what Postgres and Keycloak already persisted on their volumes.

First boot takes several minutes: the frontend runs a full Vite build and
Keycloak imports the realm.
EOF
