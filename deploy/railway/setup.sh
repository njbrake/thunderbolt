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
# (its resolver and upstream default to Docker's); the SPA calls the backend
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
# Mint a v4 UUID from openssl bytes rather than depending on uuidgen, which is
# absent on stock Alpine and on some minimal CI images. Sets the version nibble
# to 4 and the variant bits to 10xx per RFC 4122 §4.4.
gen_uuid4() {
  local h
  h="$(openssl rand -hex 16)"
  printf '%s-%s-4%s-%x%s-%s\n' \
    "${h:0:8}" "${h:8:4}" "${h:13:3}" \
    "$(((0x${h:16:1} & 0x3) | 0x8))" "${h:17:3}" "${h:20:12}"
}

# Hex-only, for two reasons: the values embed in postgres:// URIs without
# percent-encoding, and `railway variable set K=V` splits on the first `=`, so
# base64 padding is a hazard. POWERSYNC_JWT_SECRET must be >=32 chars, enforced
# in backend/src/config/settings.ts.
#
# KC_SEED_ID lives here despite not being a secret, because it must be STABLE.
# Keycloak stamps it into the token's `sub` claim, and Better Auth binds the
# Thunderbolt account to that value, so minting a new one on a re-run would
# orphan the existing account and its chats. Caching it alongside the secrets is
# what makes re-runs safe.
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
KC_SEED_PASSWORD=$(openssl rand -hex 16)
KC_SEED_ID=$(gen_uuid4)
EOF
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# Backfill keys added to this script after a stack was first provisioned, so an
# existing secrets file does not silently leave them unset. Appending (rather
# than regenerating the file) preserves every value the running stack already
# persisted to its volumes.
if [ -z "${KC_SEED_ID:-}" ]; then
  KC_SEED_ID="$(gen_uuid4)"
  log "adding KC_SEED_ID to $SECRETS_FILE"
  # chmod, not umask: umask only applies to files being created, so appending to
  # a secrets file that predates this script would leave its mode untouched.
  chmod 600 "$SECRETS_FILE"
  printf 'KC_SEED_ID=%s\n' "$KC_SEED_ID" >>"$SECRETS_FILE"
fi

# The realm's seeded user. Upstream's realm JSON ships demo@thunderbolt.io/demo;
# these override it through Keycloak's ${VAR:default} substitution so a public
# deploy never has a guessable login. It is also the ONLY account that can sign
# in: the realm sets registrationAllowed=false, and in AUTH_MODE=oidc the backend
# applies no waitlist gate to SSO logins (the waitlist only guards the consumer
# OTP path), so an open realm would hand any stranger who finds the Keycloak
# hostname a Thunderbolt account with access to this deployment's provider keys.
#
# Realm import is one-shot — Keycloak reads the JSON only on the first boot of an
# empty database. Changing these on an existing stack does nothing; edit the user
# in the admin console, or delete the keycloak volume to re-seed from scratch.
KC_SEED_USERNAME="${KC_SEED_USERNAME:-owner}"
KC_SEED_EMAIL="${KC_SEED_EMAIL:-owner@example.com}"
# Overridden for the same reason: the realm defaults these to Demo/User, and they
# are what the app renders as the signed-in user's name, so leaving them unset
# shows "Demo User" in the sidebar even once the login itself is locked down.
KC_SEED_FIRST_NAME="${KC_SEED_FIRST_NAME:-Thunderbolt}"
KC_SEED_LAST_NAME="${KC_SEED_LAST_NAME:-Owner}"

# An OpenAI-compatible inference gateway, and the key it authenticates with.
# Optional: with both unset the backend serves only the shipped model lineup,
# filtered to the providers it holds credentials for. Deliberately not generated
# into SECRETS_FILE, since the key belongs to an external service and cannot be
# invented; export it in the environment when running this script. Absent values
# are skipped rather than written empty, so a re-run without them in the
# environment leaves whatever the service already has in place.
THUNDERBOLT_INFERENCE_URL="${THUNDERBOLT_INFERENCE_URL:-}"
THUNDERBOLT_INFERENCE_API_KEY="${THUNDERBOLT_INFERENCE_API_KEY:-}"

# Names the button on the sign-in page ("Sign in with Keycloak"). Baked into the
# bundle at build time like the other VITE_* values below, so changing it needs a
# rebuild. Defaults to the identity provider this path actually deploys.
VITE_SSO_PROVIDER_NAME="${VITE_SSO_PROVIDER_NAME:-Keycloak}"

# Which proxy header carries the real client IP. Rate limiting keys on it, so this
# is not cosmetic: left empty behind a CDN, every request appears to come from a
# handful of edge IPs and all users share one bucket. Set it to the edge you
# actually terminate on, and ONLY that — trusting a header your edge does not
# overwrite lets a client spoof its IP and bypass the limits entirely.
# Railway custom domains are commonly fronted by Cloudflare, hence the default;
# set TRUSTED_PROXY="" if you serve *.up.railway.app directly.
TRUSTED_PROXY="${TRUSTED_PROXY-cloudflare}"

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

# Keycloak deliberately gets NO volume: its state lives in the `keycloak` database
# on the Postgres above (KC_DB below), which the Postgres volume already persists.
#
# A volume here would also actively break the realm import, because
# keycloak.Dockerfile bakes the realm to /opt/keycloak/data/import/ and a mount at
# /opt/keycloak/data shadows that directory. The failure is silent: the deployment
# reports SUCCESS, /realms/master answers 200, and only /realms/thunderbolt 404s.

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
  "KC_DB=postgres" \
  "KC_DB_URL=jdbc:postgresql://$SVC_PG.railway.internal:5432/keycloak" \
  "KC_DB_USERNAME=postgres" \
  "KC_DB_PASSWORD=$POSTGRES_PASSWORD" \
  "KC_PROXY_HEADERS=xforwarded" \
  "KC_HOSTNAME=$KC_URL" \
  "KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true" \
  "KC_BOOTSTRAP_ADMIN_USERNAME=admin" \
  "KC_BOOTSTRAP_ADMIN_PASSWORD=$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  "KC_SEED_ID=$KC_SEED_ID" \
  "KC_SEED_USERNAME=$KC_SEED_USERNAME" \
  "KC_SEED_EMAIL=$KC_SEED_EMAIL" \
  "KC_SEED_FIRST_NAME=$KC_SEED_FIRST_NAME" \
  "KC_SEED_LAST_NAME=$KC_SEED_LAST_NAME" \
  "KC_SEED_PASSWORD=$KC_SEED_PASSWORD" \
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
  "RATE_LIMIT_ENABLED=true" \
  "TRUSTED_PROXY=$TRUSTED_PROXY" \
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

# Set separately, and only when provided, so a run without them in the
# environment does not overwrite a key the service already holds with an empty
# string. An empty THUNDERBOLT_INFERENCE_URL reads as "no gateway", which would
# silently retire every gateway model from the lineup.
if [ -n "$THUNDERBOLT_INFERENCE_URL" ]; then
  log "  attaching inference gateway"
  setvar "$SVC_BE" "THUNDERBOLT_INFERENCE_URL=$THUNDERBOLT_INFERENCE_URL"
  [ -n "$THUNDERBOLT_INFERENCE_API_KEY" ] &&
    setvar "$SVC_BE" "THUNDERBOLT_INFERENCE_API_KEY=$THUNDERBOLT_INFERENCE_API_KEY"
else
  log "  no THUNDERBOLT_INFERENCE_URL in the environment; leaving the gateway variables untouched"
fi

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
  "VITE_AUTH_MODE=sso" \
  "VITE_SSO_PROVIDER_NAME=$VITE_SSO_PROVIDER_NAME"

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

Sign in as:  $KC_SEED_EMAIL  (password is in $SECRETS_FILE, as KC_SEED_PASSWORD)
Keycloak admin user: admin  (password is in $SECRETS_FILE)

Self-registration is off, so this is the only account that can sign in. Keycloak
runs on Postgres here, so accounts you add in the admin console are durable.

Inference: $(if [ -n "$THUNDERBOLT_INFERENCE_URL" ]; then echo "gateway at $THUNDERBOLT_INFERENCE_URL"; else echo "no gateway set, so only shipped models with provider credentials are offered"; fi)

$SECRETS_FILE holds every generated credential. It is gitignored. Keep it if you
want re-runs to preserve the stack; delete it and the next run mints new secrets,
which will not match what Postgres and Keycloak already persisted on their volumes.
That file also holds KC_SEED_ID, which becomes the seeded user's OIDC subject claim
and so the identity the Thunderbolt account is bound to. Losing it orphans that
account.

First boot takes several minutes: the frontend runs a full Vite build and
Keycloak imports the realm.
EOF
