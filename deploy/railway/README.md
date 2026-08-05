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
  rebuilds the realm, the OIDC client, and the demo user from
  `deploy/config/keycloak-realm.json` on every boot.

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
- **Inference.** `THUNDERBOLT_INFERENCE_URL` is not currently read by the backend, so
  a custom OpenAI-compatible gateway is configured per-user in the app instead, as a
  `custom` provider. Backend provider keys (`ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`,
  `MISTRAL_API_KEY`) can be added as `backend` service variables if you want the
  server-side AI features active.

## Teardown

```bash
railway down                      # remove the current deployment
# or delete the whole project from the dashboard, which also removes the volumes
```

Deleting the project deletes the volumes and all data with it.
