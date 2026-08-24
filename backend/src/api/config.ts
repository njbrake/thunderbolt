/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { ensureGatewayModels, getGatewaySharedModels } from '@/inference/gateway-models'
import { safeErrorHandler } from '@/middleware/error-handling'
import { defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { Elysia } from 'elysia'

/**
 * Public app config — the single source of deployment-level UI capability flags
 * (no auth, fetched at boot). The frontend mirrors this into its config store and
 * falls back to the cached value when offline (standalone mode keeps working).
 *
 * `defaults.models` ships the reconciled default sets as a version-gated OTA
 * channel: clients pick between the server payload and their bundled copy by
 * comparing versions, so shipped defaults changes don't require a client
 * release. See "Reconciled defaults and version bumps" in AGENTS.md.
 *
 * `defaults.gatewayModels` is deliberately separate and *not* version-gated.
 * Inference-gateway models are discovered per deployment and change whenever the
 * operator's gateway does, so folding them into the version-gated `models`
 * channel would (a) require a synthetic version bump that then freezes out every
 * later catalogue change, and (b) never reach the picker at all, since the
 * frontend reconciler drops OTA model ids that lack a bundled profile. The
 * frontend reconciles this list to the current server state directly and
 * synthesizes a profile for each row.
 */
export type CreateConfigRoutesOptions = {
  /** Injected fetch for gateway discovery. Omitted in production (global fetch);
   *  supplied by tests so the route's own discovery call is exercised. */
  fetchFn?: typeof fetch
}

export const createConfigRoutes = (settings: Settings, options: CreateConfigRoutesOptions = {}) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', async () => {
    // Refresh discovery here rather than at boot: /config is fetched on every app
    // start, so the catalogue is picked up without a redeploy, and a warm cache
    // makes this a no-op.
    await ensureGatewayModels(settings, { fetchFn: options.fetchFn })
    return {
      e2eeEnabled: settings.e2eeEnabled,
      // Inverted so the env reads as an opt-in switch ("disable") while the wire
      // contract reads as a positive capability ("enabled").
      builtInAgentEnabled: !settings.disableBuiltInAgent,
      allowCustomAgents: settings.allowCustomAgents,
      // Omit when unset so the frontend treats it as "no enforcement" without parsing an empty string as semver.
      minAppVersion: settings.minAppVersion || undefined,
      defaults: {
        models: { version: defaultModelsVersion, data: defaultModels },
        gatewayModels: getGatewaySharedModels(settings),
      },
    }
  })
