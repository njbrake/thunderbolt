/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { ensureGatewayModels, getGatewaySharedModels, parseGatewayVisionModelIds } from '@/inference/gateway-models'
import { supportedModels } from '@/inference/routes'
import { safeErrorHandler } from '@/middleware/error-handling'
import { serverTurnsAvailable } from '@/turns/availability'
import { getWebCapabilities } from '@/web/providers'
import { defaultModels, defaultModelsVersion, type SharedModel } from '@shared/defaults/models'
import { Elysia } from 'elysia'

/**
 * Public app config — the single source of deployment-level UI capability flags
 * (no auth, fetched at boot). The frontend mirrors this into its config store and
 * falls back to the cached value when offline (standalone mode keeps working).
 *
 * `defaults` ships the reconciled default sets (models today, more to follow) as
 * an OTA channel: clients pick between the server payload and their bundled copy
 * by comparing versions, so shipped defaults changes don't require a client
 * release. See "Reconciled defaults and version bumps" in AGENTS.md.
 */
/**
 * True when this deployment can actually route a shipped default model.
 *
 * The bundled defaults describe Thunderbolt's hosted lineup, and every one of
 * them needs a provider credential that a self-hosted backend usually does not
 * have: `opus-4.8` routes to Anthropic, `deepseek-v4-flash` to Fireworks,
 * `glm-5-2` to Tinfoil. Advertising them regardless is why a self-host with only
 * `THUNDERBOLT_INFERENCE_URL` configured showed three models in the picker that
 * fail the moment you send to them.
 *
 * Keyed off the routing table rather than the model's `provider` field, because
 * `provider` is the UI-facing transport ("thunderbolt") and hides which upstream
 * actually serves the request.
 */
const canServeDefaultModel = (model: SharedModel, settings: Settings): boolean => {
  const routed = supportedModels[model.model]
  if (routed) {
    switch (routed.provider) {
      case 'anthropic':
        return !!settings.anthropicApiKey
      case 'fireworks':
        return !!settings.fireworksApiKey
      case 'mistral':
        return !!settings.mistralApiKey
      case 'tinfoil':
        return !!settings.tinfoilApiKey
      case 'thunderbolt-inference':
        return !!settings.thunderboltInferenceUrl && !!settings.thunderboltInferenceApiKey
      default:
        return false
    }
  }
  // Not in the routing table: the only shipped case is Tinfoil, which the client
  // reaches through this backend's proxy and which needs an enclave key.
  return model.provider === 'tinfoil' && !!settings.tinfoilApiKey
}

/**
 * The models this deployment can actually serve: shipped defaults it holds
 * credentials for, plus everything its inference gateway advertises.
 *
 * The payload has to out-version the client's bundled copy or `pickModelsDefaults`
 * keeps the bundle, so any deviation from the shipped set bumps the version by
 * one — that also preserves the comparison across future upstream bumps.
 *
 * Omitting an unservable default is what retires it client-side:
 * `cleanupRemovedDefaults` soft-deletes system rows missing from this list. It
 * only touches rows with `isSystem = 1` and a `defaultHash`, so anything the user
 * added themselves is untouched.
 */
const buildModelDefaults = async (settings: Settings) => {
  // Refresh discovery here rather than at boot: /config is fetched on every app
  // start, so the catalogue is picked up without a redeploy, and a warm cache
  // makes this a no-op.
  await ensureGatewayModels(settings)
  const gatewayModels = getGatewaySharedModels(settings)
  const servableDefaults = defaultModels.filter((model) => canServeDefaultModel(model, settings))
  const data = [...servableDefaults, ...gatewayModels]

  // Nothing to correct: this deployment serves precisely the shipped lineup.
  if (gatewayModels.length === 0 && servableDefaults.length === defaultModels.length) {
    return { version: defaultModelsVersion, data: defaultModels }
  }

  // Refuse to publish an empty lineup. A misconfigured backend (no provider keys
  // and an unreachable gateway) would otherwise retire every model on every
  // client, and an offline gateway is a transient state, not a decision to strip
  // the app. The bundle is the floor in that case, wrong-but-present.
  if (data.length === 0) {
    return { version: defaultModelsVersion, data: defaultModels }
  }

  return { version: defaultModelsVersion + 1, data }
}

export const createConfigRoutes = (settings: Settings) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', async () => ({
    e2eeEnabled: settings.e2eeEnabled,
    // Inverted so the env reads as an opt-in switch ("disable") while the wire
    // contract reads as a positive capability ("enabled").
    builtInAgentEnabled: !settings.disableBuiltInAgent,
    allowCustomAgents: settings.allowCustomAgents,
    // Whether this deployment can service the `search` and `fetch_content` tools.
    // Reported separately because they are separately configurable: a deployment
    // can hold a search provider and no page fetcher, or the reverse.
    //
    // The frontend needs these because it decides which tools to hand the model,
    // and it cannot see the backend's credentials. Without them it offered web
    // search unconditionally, so on a deployment with no provider the model would
    // reach for it mid-answer and the tool call would fail, which reads as a broken
    // app rather than one without web access.
    ...getWebCapabilities(settings),
    // Model ids this deployment's gateway can accept images for. A deployment
    // capability, not user data, so it rides `/config` beside the tool flags
    // rather than becoming a synced column on every model row. The frontend
    // needs it because an OpenAI-compatible gateway advertises no modality
    // information, so without an operator declaration the built-in agent
    // advertises text-only and silently drops image blocks before the wire.
    visionModels: parseGatewayVisionModelIds(settings.thunderboltInferenceVisionModels),
    // Whether the client may hand a turn to the server at all. It cannot infer
    // this: the answer depends on the gateway credentials and the encryption
    // setting, neither of which the browser can see.
    serverTurnsEnabled: serverTurnsAvailable(settings),
    // The client needs this to create a push subscription at all. Public by
    // design — it is the key push services verify signatures against. Omitted
    // when unset so the frontend reads "this deployment cannot notify".
    vapidPublicKey: settings.vapidPublicKey || undefined,
    // Omit when unset so the frontend treats it as "no enforcement" without parsing an empty string as semver.
    minAppVersion: settings.minAppVersion || undefined,
    defaults: {
      models: await buildModelDefaults(settings),
    },
  }))
