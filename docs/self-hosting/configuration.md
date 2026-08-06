# Configuration

Thunderbolt's backend is configured through environment variables. The schema lives at [backend/src/config/settings.ts](../backend/src/config/settings.ts) and is validated with Zod on startup — misconfiguration fails loud, not silent.

Copy the example to a `.env` file and customize:

```bash
cp backend/.env.example backend/.env
```

Variables marked **required** must be set before the backend will start.

## Authentication

| Variable                  | Default                    | Required | Description                                                                                 |
| ------------------------- | -------------------------- | :------: | ------------------------------------------------------------------------------------------- |
| `AUTH_MODE`               | `consumer`                 |          | `consumer` for magic-link + Google/Microsoft OAuth, `oidc` for OIDC SSO, `saml` for SAML SSO |
| `BETTER_AUTH_SECRET`      | —                          | **yes**  | Non-empty string used to sign sessions. Generate with `openssl rand -hex 32`.               |
| `BETTER_AUTH_URL`         | `http://localhost:8000`    |          | Public URL the backend is served at; used in OAuth redirects                                |
| `GOOGLE_CLIENT_ID`        | —                          |          | Google OAuth client ID (consumer mode)                                                      |
| `GOOGLE_CLIENT_SECRET`    | —                          |          | Google OAuth client secret                                                                  |
| `MICROSOFT_CLIENT_ID`     | —                          |          | Microsoft OAuth client ID                                                                   |
| `MICROSOFT_CLIENT_SECRET` | —                          |          | Microsoft OAuth client secret                                                               |
| `OIDC_ISSUER`             | —                          |          | OIDC issuer URL (required when `AUTH_MODE=oidc`)                                            |
| `OIDC_DISCOVERY_URL`      | `${OIDC_ISSUER}/.well-known/openid-configuration` |          | Optional override for the OIDC discovery endpoint. Use when backend reaches the IdP at an internal hostname (e.g. `http://keycloak:8080/...`) but tokens are issued with a browser-facing hostname |
| `OIDC_CLIENT_ID`          | —                          |          | OIDC client ID                                                                              |
| `OIDC_CLIENT_SECRET`      | —                          |          | OIDC client secret                                                                          |
| `SAML_ENTRY_POINT`        | —                          |          | SAML IdP SSO URL (required when `AUTH_MODE=saml`)                                           |
| `SAML_ENTITY_ID`             | —                          |          | SP entity ID — must match the SAML client ID in the IdP (e.g. `thunderbolt-saml-sp`)        |
| `SAML_IDP_ISSUER`            | —                          |          | IdP entity ID / issuer (e.g. `https://keycloak.example.com/realms/thunderbolt`)             |
| `SAML_CERT`               | —                          |          | SAML IdP signing certificate (base64, no PEM headers)                                       |

Consumer mode uses [Better Auth](https://better-auth.com)'s magic-link flow by default (email-delivered OTP). Hook up a provider by also setting the OAuth credentials above. Enterprise mode delegates entirely to an OIDC or SAML identity provider (Keycloak by default). See [OIDC local dev](../../backend/docs/oidc-local-dev.md) and [SAML local dev](../../backend/docs/saml-local-dev.md) for setup guides.

**The waitlist does not gate SSO.** `WAITLIST_ENABLED` only guards the consumer OTP sign-in path. In `oidc`/`saml` mode, anyone your identity provider will authenticate gets a Thunderbolt account, and Thunderbolt itself has no admin role or per-user quota — every account can use every model the backend proxies. Access control belongs in the IdP.

### Bundled Keycloak realm

`deploy/config/keycloak-realm.json` seeds one user, whose credentials come from the environment so a public deployment is not shipping a known login:

| Variable             | Default                                | Description                                   |
| -------------------- | -------------------------------------- | --------------------------------------------- |
| `KC_SEED_USERNAME`   | `demo`                                 | Username of the seeded account                |
| `KC_SEED_EMAIL`      | `demo@thunderbolt.io`                  | Its email, which is the Thunderbolt identity  |
| `KC_SEED_FIRST_NAME` | `Demo`                                 | Given name                                    |
| `KC_SEED_LAST_NAME`  | `User`                                 | Family name                                   |
| `KC_SEED_PASSWORD`   | `demo`                                 | Its password (permanent, not a temporary one) |
| `KC_SEED_ID`         | `1d0fc1e0-7a60-4f6f-93b6-5f1d9aef7d64` | Keycloak user UUID — see below                |

`KC_SEED_ID` looks like an implementation detail and is not. It becomes the `sub` claim, which is the identity Better Auth links a Thunderbolt account to, so it decides whether a re-imported realm maps onto the **existing** Thunderbolt user or a new one:

- Pinned (the default) means the account survives re-imports. That matters wherever Keycloak's storage is ephemeral, because every restart re-imports the realm and a freshly generated UUID would strand the previous account on every deploy.
- Consequently, changing `KC_SEED_USERNAME`/`KC_SEED_EMAIL` alone does **not** rename the Thunderbolt account: the `sub` is unchanged, so the app keeps the profile it first saw (the shipped default's is "Demo User"). Change `KC_SEED_ID` too when you want a genuinely separate identity, and expect the old account's data to stay behind, orphaned.

The realm also sets `registrationAllowed: false`. Leave it off whenever Keycloak is reachable from the internet: combined with the SSO/waitlist gap above, open registration lets any stranger who finds the Keycloak hostname mint an account and spend your provider keys. Turn it on per-realm in the admin console if you do want open sign-up.

**Realm import is one-shot.** Keycloak reads the JSON only on the first boot of an empty database, so changing these variables on a running stack has no effect — edit the user in the admin console, or discard Keycloak's storage to re-seed.

**Important:** When using `AUTH_MODE=oidc` or `saml`, the IdP origin must be included in `TRUSTED_ORIGINS` (see CORS section below). The SSO plugin validates discovery/metadata URLs against this list.

## AI Provider Keys

Set any subset; the app exposes each provider whose key is present.

| Variable                         | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | Anthropic (Claude)                                   |
| `FIREWORKS_API_KEY`              | Fireworks                                            |
| `MISTRAL_API_KEY`                | Mistral                                              |
| `EXA_API_KEY`                    | Exa search (for web-grounded retrieval)              |
| `THUNDERBOLT_INFERENCE_URL`      | Custom OpenAI-compatible inference endpoint          |
| `THUNDERBOLT_INFERENCE_API_KEY`  | Key for the custom inference endpoint                |

User-level keys (e.g. OpenAI, OpenRouter) are configured in the app itself, not as backend env vars. For local inference, point `THUNDERBOLT_INFERENCE_URL` at an Ollama or llama.cpp server.

## PowerSync

| Variable                         | Default  | Required         | Description                                                                  |
| -------------------------------- | -------- | ---------------- | ---------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | —        | yes (for sync)   | URL of the PowerSync service (e.g. `http://localhost:8080` for local dev)    |
| `POWERSYNC_JWT_SECRET`           | —        | yes when URL set | HS256 secret shared with PowerSync; must be **≥ 32 characters**              |
| `POWERSYNC_JWT_KID`              | —        |                  | Key ID for PowerSync to pick among multiple secrets during rotation          |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`   |                  | PowerSync JWT lifetime                                                       |

The JWT secret must match the `k` value the PowerSync service loads at runtime. For self-hosted deploys, `deploy/config/powersync-config.yaml` reads it from the `PS_JWT_KEY_BASE64` env var (base64 of the raw secret); `POWERSYNC_JWT_KID` on the backend must match `PS_JWT_KID` set on the PowerSync service. For local dev, both values are baked into `powersync-service/config/config.yaml`.

## CORS

| Variable                  | Default                                                              | Description                                                                    |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CORS_ORIGINS`            | `http://localhost:1420,tauri://localhost,http://tauri.localhost`     | Exact-match allowed origins (comma-separated)                                  |
| `CORS_ALLOW_CREDENTIALS`  | `true`                                                               | Whether browsers may send cookies                                              |
| `CORS_ALLOW_METHODS`      | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                                  | Allowed HTTP methods                                                           |
| `CORS_ALLOW_HEADERS`      | _(see [settings.ts](../backend/src/config/settings.ts))_             | Allowed request headers. **Add any new `X-*` header you introduce in the client.** |
| `CORS_EXPOSE_HEADERS`     | _(see `settings.ts`)_                                                | Response headers exposed to the client                                         |

When you add a new custom header to a client request (e.g. `X-Device-ID`), you **must** add it to `CORS_ALLOW_HEADERS` — otherwise browser preflight fails and the request never reaches your handler.

## Analytics

| Variable          | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog instance hostname                    |
| `POSTHOG_API_KEY` | —                          | Leave unset to disable server-side analytics |

See [TELEMETRY.md](../TELEMETRY.md) in the repo for the full list of events the client emits.

## Rate Limiting and Proxy Trust

| Variable             | Default | Description                                                                                               |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set to `false` to disable rate limiting (local dev only)                                                  |
| `TRUSTED_PROXY`      | `""`    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the socket IP |

Trusting the wrong proxy header lets a client spoof its IP for rate-limit bypass. Leave this empty unless you know your edge.

## Waitlist

| Variable                        | Default | Description                                                       |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `WAITLIST_ENABLED`              | `false` | Flip to `true` to require approval before new sign-ups can log in |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | —       | Comma-separated email domains that skip the waitlist queue        |

## OpenTelemetry (Optional)

OpenTelemetry traces are enabled automatically when these are set. Not part of the Zod schema — the backend reads them from `process.env` directly.

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TOKEN`    | Bearer token for authenticated collectors                   |

Tested with BetterStack, Jaeger, Zipkin, New Relic, Grafana Cloud, and any OTLP-compatible collector.

## General

| Variable           | Default                 | Description                                                          |
| ------------------ | ----------------------- | -------------------------------------------------------------------- |
| `PORT`             | `8000`                  | HTTP port the backend listens on                                     |
| `APP_URL`          | `http://localhost:1420` | Public URL where the frontend is served                              |
| `LOG_LEVEL`        | `INFO`                  | One of `DEBUG`, `INFO`, `WARN`, `ERROR`                              |
| `SWAGGER_ENABLED`  | `false`                 | Expose `/v1/swagger` with the full OpenAPI spec (don't in production) |
| `MONITORING_TOKEN` | —                       | Shared secret for authenticated `/health` checks                     |

## Frontend Build Args

The web/desktop bundle accepts two Vite env vars, passed as Dockerfile build args in `deploy/docker/frontend.Dockerfile`:

| Arg                          | Default | Purpose                                                                       |
| ---------------------------- | ------- | ----------------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative path, proxied by nginx or ALB)                      |
| `VITE_AUTH_MODE`             | `sso`   | Auth mode — `sso` for enterprise SSO (OIDC or SAML), omit for consumer        |

## Validating Your Config

The backend validates every variable on startup. Common hits:

- `BETTER_AUTH_SECRET: String must contain at least 1 character(s)` — set it.
- `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set` — regenerate with `openssl rand -hex 32`.
- `AUTH_MODE: Invalid enum value` — must be `consumer`, `oidc`, or `saml` (case-insensitive).
