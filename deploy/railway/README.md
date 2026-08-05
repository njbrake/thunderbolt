# Thunderbolt on Railway

> ⚠️ **Under active development, not production ready.** Same caveat as the rest of
> `deploy/`: Thunderbolt is undergoing a security audit. Treat this as an evaluation
> and demo path.

Deploys the same five services as the other paths (frontend, backend, Postgres,
Keycloak, PowerSync) as five Railway services in one project.

## How this differs from the other deployment paths

Docker Compose, Helm, and Pulumi all put a single proxy in front of the stack and
route by path (`/v1/*` to backend, `/realms/*` to Keycloak, `/powersync/*` to
PowerSync). Railway has no shared ingress: every service gets its own domain. Two
consequences:

- **The SPA talks to the backend cross-origin.** `VITE_THUNDERBOLT_CLOUD_URL` is set
  to an absolute `https://<backend>/v1` instead of the same-origin `/v1` default, and
  the backend's `CORS_ORIGINS` allows the frontend domain. The frontend image's nginx
  `/v1/` proxy block goes unused here, which is deliberate: its `resolver 127.0.0.11`
  is Docker's embedded DNS and does not exist on Railway.
- **The OIDC callback lives on the backend domain**, not the app domain, since Better
  Auth serves `/v1/api/auth/sso/callback/sso`. The web origin stays the frontend
  domain. `deploy/pulumi/src/services.ts` makes the same split for its API hostname.
  This is also why **`BETTER_AUTH_URL` is the backend origin while `APP_URL` is the
  frontend**. Those two are equal in the Compose and ALB setups only because one
  origin proxies `/v1` there. Setting `BETTER_AUTH_URL` to the frontend on Railway
  makes Keycloak reject sign-in with `Invalid parameter: redirect_uri`, since Better
  Auth would then advertise a callback on an origin the realm does not register.

## Put the app and the API on one registrable domain

Strongly recommended, and the single thing most likely to cost you an afternoon if you
skip it. Railway's generated hostnames look adjacent but are not:
`frontend-production-xxxx.up.railway.app` and `backend-production-yyyy.up.railway.app`
are **different sites**, because `up.railway.app` is on the Public Suffix List.

The consequence is that the OAuth `state` cookie is set on a cross-site request during
sign-in, and browsers are entitled to drop it. Firefox logs

```
Cookie "__Secure-better-auth.state" has been rejected because it is in a cross-site
context and its "SameSite" is "Lax" or "Strict".
```

and Safari blocks cross-site cookies outright. Better Auth then fails the callback with
`state_security_mismatch` _after_ the IdP has already authenticated the user, so
sign-in dies with no obvious cause.

`backend/src/auth/auth.ts` works around this by setting `account.skipStateCookieCheck`
when `appUrl` and `betterAuthUrl` differ in origin, which is safe because the
authoritative state is a database row. But the cleaner answer is to not be cross-site
at all: put both services under one domain you control, e.g.

| Service    | Custom domain        |
| ---------- | -------------------- |
| `frontend` | `tb.example.com`     |
| `backend`  | `tb-api.example.com` |

Those share the `example.com` registrable domain, so the cookie is same-site and no
browser policy touches it. Keycloak and PowerSync do not need to join them: they are
reached by top-level redirects and an authenticated sync stream respectively, and share
no cookies with the app.

### Custom domains on Railway

```bash
railway domain tb.example.com     --service frontend --port 80
railway domain tb-api.example.com --service backend  --port 8000
```

Each prints a `CNAME` plus a `_railway-verify.<sub>` `TXT` record. Add all of them.

**Cloudflare's proxy (orange cloud) is fine.** Ownership is proven by the TXT record,
so Railway does not need to see its own CNAME target. Expect `dig CNAME` to return
nothing and `dig A` to return Cloudflare addresses even when everything is correct —
that is Cloudflare answering, not a misconfiguration. Verify with an actual request
instead: the app host should return HTTP 200 and the API host `404 NOT_FOUND` (the
backend serves no `/` route), both carrying `x-railway-request-id`.

After changing hostnames, update `APP_URL`, `BETTER_AUTH_URL`, `CORS_ORIGINS`,
`TRUSTED_ORIGINS` on `backend`, `OIDC_REDIRECT_URI` and `OIDC_WEB_ORIGIN` on
`keycloak`, and rebuild `frontend` for its baked-in API URL. Then **delete the old
generated domains**: they keep serving the rebuilt bundle, whose API calls are now
cross-site and CORS-rejected, so a stale bookmark reproduces the original bug exactly.

Everything else is stock. No application code changes are required, because:

- `frontend.Dockerfile` already declares `ARG VITE_THUNDERBOLT_CLOUD_URL` and
  `ARG VITE_AUTH_MODE`, and Railway exposes service variables to Docker builds as
  build args.
- `keycloak-realm.json` already uses Keycloak's `${VAR:default}` substitution for the
  client secret, redirect URI, and web origin.
- The backend already reads `PORT` (`backend/src/config/settings.ts`).

The one repo change is `deploy/docker/postgres.Dockerfile`, which now sets
`CMD ["postgres", "-c", "wal_level=logical"]`. PowerSync requires logical decoding,
and Railway has no way to override a start command (there is no deploy-side
equivalent of `RAILWAY_DOCKERFILE_PATH`, and `railway.json` is resolved per-service
from the repo root, which a five-service monorepo cannot use). Compose, Helm, and
Pulumi still pass the same flag themselves, and `args`/`command` replace this `CMD`
with an identical value, so their behavior is unchanged.

## Prerequisites

- A Railway account and a workspace to deploy into.
- The [Railway CLI](https://docs.railway.com/guides/cli) and `jq`.
- A paid Railway plan. Five services plus a volume exceed the trial allowance.
- For `DEPLOY_MODE=source` (the default): a fork of this repo with Railway's GitHub
  app granted access, and the branch already pushed. Install the app from the
  Railway dashboard (New Project → Deploy from GitHub repo) or at
  <https://github.com/apps/railway-app>. `DEPLOY_MODE=up` needs neither.

### Tokens

`RAILWAY_TOKEN` (a project token) is enough for everything the script does except
creating volumes, and volume creation is why the script talks to the GraphQL API
directly. Two gotchas worth knowing before you debug an "Unauthorized":

- `railway whoami`, `railway link`, and `railway service link` are account-level and
  fail under a project token even though the project-scoped commands work. The
  script therefore uses `railway status` as its auth check.
- Project tokens authenticate GraphQL mutations via the `Project-Access-Token`
  header. Passing the same token as `Authorization: Bearer` passes introspection
  but returns "Not Authorized" on mutations.
- Deleting or detaching a volume needs an account token; a project token cannot.

## Deploy

```bash
railway login          # or export RAILWAY_TOKEN=<account or workspace token>

cd deploy/railway
REPO=<your-org>/thunderbolt \
  WORKSPACE="<your workspace>" \
  PROJECT_NAME=thunderbolt \
  ./setup.sh
```

The script is idempotent. It creates the project and services, attaches volumes,
generates domains, writes every variable, and only then connects the GitHub source
so the first build already has the correct values. Re-running it refreshes variables
and redeploys.

Generated credentials are written once to `deploy/railway/.railway-secrets.env`
(gitignored). Keep that file: deleting it makes the next run mint new secrets that
will not match what Postgres and Keycloak have already persisted to their volumes.

First boot takes several minutes. The frontend runs a full Vite build, and Keycloak
imports the realm.

## Topology

| Service     | Dockerfile                    | Target port | Public | Volume                     |
| ----------- | ----------------------------- | ----------- | ------ | -------------------------- |
| `frontend`  | `docker/frontend.Dockerfile`  | 80          | yes    | no                         |
| `backend`   | `docker/backend.Dockerfile`   | 8000        | yes    | no                         |
| `keycloak`  | `docker/keycloak.Dockerfile`  | 8080        | yes    | no (see below)             |
| `powersync` | `docker/powersync.Dockerfile` | 8080        | yes    | no                         |
| `postgres`  | `docker/postgres.Dockerfile`  | n/a         | **no** | `/var/lib/postgresql/data` |

Target ports are set explicitly because none of these images except the backend read
Railway's injected `PORT`: nginx has `listen 80`, PowerSync has `port: 8080` in
`deploy/config/powersync-config.yaml`, and Keycloak takes `KC_HTTP_PORT`.

Service names are also their private DNS labels (`postgres.railway.internal`, etc.),
so renaming a service means updating the URIs in `setup.sh`.

Postgres has no public domain. Do not add one.

### Why three services are public

Worth stating, because "lock down everything except the frontend" is the natural
instinct and two of these cannot be locked down:

- **`keycloak` must be public.** The browser is redirected to it to sign in, and
  `OIDC_ISSUER` is the value Keycloak stamps into token `iss` claims, which Better Auth
  validates. It is an identity provider; being reachable is the job.
- **`powersync` must be public.** `backend/src/api/powersync.ts` returns
  `powerSyncUrl` in the `/v1/powersync/token` response and the client uses it as the
  sync stream `endpoint` (`src/db/powersync/connector.ts`), so the browser connects
  directly. An internal `.railway.internal` name does not resolve in a browser.
- **`postgres` is private and must stay that way.** Nothing outside the project needs
  it, and Railway does not expose TCP without an explicit proxy.

Neither public service is unauthenticated: PowerSync only accepts JWTs signed with
`POWERSYNC_JWT_SECRET` and checks the audience. The one thing worth restricting is
Keycloak's admin console at `/auth/admin`, which is reachable with the bootstrap admin
password. Put it behind your edge (e.g. Cloudflare Access) or set `KC_HOSTNAME_ADMIN`.

## Who can sign in

**Read this before pointing the deployment at real provider keys.**

Keycloak is on the public internet, and upstream's realm ships
`registrationAllowed: true` with a `demo@thunderbolt.io` / `demo` user. Two things
make that combination worse than it first looks:

- In `AUTH_MODE=oidc` the backend applies **no waitlist gate to SSO logins**. The
  waitlist only guards the consumer OTP path (`backend/src/auth/auth.ts`), so
  `WAITLIST_ENABLED=true` does nothing here.
- Thunderbolt has no admin/role concept and no per-user quota. Every account is
  equal and can use every model the backend proxies.

So a stranger who finds the Keycloak hostname can self-register and spend your
`THUNDERBOLT_INFERENCE_API_KEY`. This deployment path therefore closes
registration in `deploy/config/keycloak-realm.json` and drives the seeded user
from the environment:

| Variable            | Default               | Purpose                             |
| ------------------- | --------------------- | ----------------------------------- |
| `KC_SEED_USERNAME`  | `demo`                | Username of the one seeded account   |
| `KC_SEED_EMAIL`     | `demo@thunderbolt.io` | Its email — the Thunderbolt identity |
| `KC_SEED_PASSWORD`  | `demo`                | Its password                         |

`setup.sh` generates `KC_SEED_PASSWORD` into `.railway-secrets.env` and sets all
three, so a fresh Railway stack never has a guessable login. The defaults are only
what upstream's Compose/local-dev flow expects.

**Realm import is one-shot.** Keycloak reads the JSON only on the first boot of an
empty database, so changing these on a running stack does nothing. To fix an
already-imported realm, use the admin console (or the admin REST API):

- Realm settings → Login → turn **User registration** off.
- Users → create your real account, then delete `demo`.

Adding more people later is a Keycloak task, not a Thunderbolt one: create the user
in the realm and they can sign in.

## Install it as an app

The web build is an installable PWA, which is the only way to get Thunderbolt onto
a phone home screen without shipping through an app store.

- **iOS/iPadOS:** Safari → Share → **Add to Home Screen**. It must be Safari;
  other iOS browsers cannot install to the home screen. A home screen app gets its
  own storage and cookie jar, so the first launch asks you to sign in again even if
  Safari is already signed in.
- **Android:** Chrome offers **Install app** in the menu (or an install prompt).
- **Desktop:** Chrome/Edge show an install button in the address bar.

Two properties of this deployment matter for it:

- The service worker precaches the **app shell only** (~2MB: `index.html`, the entry
  chunk, the main stylesheet). A `**/*` precache would be 31MB, because `dist`
  carries ~17MB of wa-sqlite/ACP wasm (emitted twice) plus multi-MB lazy chunks.
  Consequence: this is not a work-offline app. It needs the backend for auth and
  inference anyway.
- Cross-origin isolation survives it. The app needs `crossOriginIsolated` for
  OPFS/SharedArrayBuffer, and cached navigation responses keep the COOP/COEP
  headers nginx set, so serving the shell from the worker does not break it.

### Updating the client

Static hosting gives a browser no version to compare, so the service worker is the
update channel: it re-fetches `/sw.js`, whose precache manifest names every hashed
asset, so a changed manifest means a new deploy. A new build **installs but waits** —
swapping chunks under a live React tree would break the running session. The user
gets an "A new version is available" card with **Reload**, and the same control sits
in Settings → About → Updates. Checks run hourly and on every return to the
foreground, which is what matters for a home screen app that gets resumed rather
than relaunched.

`nginx.conf.template` marks `sw.js`, `index.html`, and `manifest.webmanifest`
`Cache-Control: no-cache` for this to work at all. A cached `sw.js` pins a client to
an old build indefinitely, and a cached `index.html` is how a phone keeps loading
last week's bundle after a deploy.

## Notes and caveats

- **Keycloak runs in `start-dev` mode** with a file-backed H2 database, inherited from
  `deploy/docker/keycloak.Dockerfile`. Fine for evaluation. A production deployment
  wants `start --optimized` against a real database, which is out of scope here.
- **Do not mount a volume at `/opt/keycloak/data`.** It breaks Keycloak two ways, and
  both failures are quiet, so this is worth stating plainly.
  1. `keycloak.Dockerfile` bakes the realm to `/opt/keycloak/data/import/`. A volume
     mounted at `/opt/keycloak/data` **shadows that directory**, so `--import-realm`
     finds nothing. Keycloak boots fine, `/realms/master` answers 200, and only
     `/realms/thunderbolt` 404s. There is no "Importing realm" line in the log, and
     no error either.
  2. Railway mounts volumes root-owned and the image runs non-root, so H2 dies with
     `AccessDeniedException: /opt/keycloak/data/h2`, which needs `RAILWAY_RUN_UID=0`
     to work around.

  Persisting the dev-mode H2 file is not worth either problem: `--import-realm`
  rebuilds the realm, the OIDC client, and the seeded user from
  `deploy/config/keycloak-realm.json` on every boot.

  The flip side, worth knowing before you edit a user by hand: with no volume the
  H2 file lives in the container filesystem, so **users you create in the admin
  console are lost on redeploy** and the realm returns to whatever
  `KC_SEED_*` describes. Treat the realm JSON plus those variables as the source of
  truth, not the console.

- **`PGDATA` is a subdirectory** of the mount (`/var/lib/postgresql/data/pgdata`).
  Railway volumes mount with a `lost+found` entry and `initdb` refuses a non-empty
  target. The Helm chart does the same thing for the same reason.
- **The frontend's API URL is baked in at build time.** Changing the backend domain
  requires a rebuild, not a restart.
- **Private networking is runtime-only on Railway.** Migrations must run in the start
  command, which `deploy/docker/backend-entrypoint.sh` already does.
- **The RDS/PowerSync-storage hang** documented in `deploy/README.md` does not apply:
  PowerSync's storage points at the in-project Postgres, not a managed instance.
- `sslmode: disable` in `powersync-config.yaml` is correct here. Railway's private
  network is Wireguard-encrypted and this Postgres serves no TLS.
- **Inference.** Point `THUNDERBOLT_INFERENCE_URL` at an OpenAI-compatible gateway and
  list its models in `THUNDERBOLT_INFERENCE_MODELS`; see
  `docs/self-hosting/configuration.md`. Requests are proxied through the backend, so the
  gateway key stays server-side and the gateway needs no CORS configuration. Hosted
  provider keys (`ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`, `MISTRAL_API_KEY`) work as
  `backend` variables too.
- **`BETTER_AUTH_URL` is the API origin, `APP_URL` is the app.** They are equal in the
  Compose and ALB setups only because one origin proxies both. See the same-site section
  above.

## Troubleshooting

**Sign-in returns to a bare `NOT_FOUND`.** Better Auth resolves its error redirect as
`onAPIError.errorURL || ${baseURL}/error`, and `baseURL` is the API, which serves no
such route. `backend/src/auth/auth.ts` sets `errorURL` to `APP_URL` so failures land on
the app; if you see this, that setting is missing or `APP_URL` is wrong.

**Keycloak rejects sign-in with `Invalid parameter: redirect_uri`.** The realm registers
`OIDC_REDIRECT_URI`, which must be on the **backend** origin
(`<api>/v1/api/auth/sso/callback/sso`), while `OIDC_WEB_ORIGIN` is the frontend. If
`BETTER_AUTH_URL` points at the frontend, Better Auth advertises a callback the realm
does not know.

**The app hangs on the loading spinner.** Read the `[init] step...` lines in the browser
console and find the last one printed. Boot runs
`start → step0_5_storage_check → step1_create_app_dir → step2_initialize_database →
step2b_db_ready → … → step8_initialize_posthog → complete`. Stopping at
`step2b_db_ready` means the WASM/OPFS database never opened; that step has no timeout,
so it spins rather than erroring. The usual cause is stale or inaccessible site storage
for that origin. Clearing **cookies is not enough** — OPFS survives it. Remove the
origin under Cookies and Site Data, or test in a fresh browser profile.

**Keycloak's account console shows "Something went wrong" with 401s.** Cosmetic and
unrelated to the app. `deploy/config/keycloak-realm.json` defines no `defaultRole` and
gives the demo user no role mappings, so it has none of the `account` client roles the
account REST API requires. Thunderbolt sign-in is unaffected: it consumes ID token
claims and never calls that API.

**A stale generated domain "works" but nothing loads.** See the note about deleting old
domains after a hostname change.

## Teardown

```bash
railway down                      # remove the current deployment
# or delete the whole project from the dashboard, which also removes the volumes
```

Deleting the project deletes the volumes and all data with it.
