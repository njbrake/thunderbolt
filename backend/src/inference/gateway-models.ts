/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { SharedModel } from '@shared/defaults/models'
import { createHash } from 'node:crypto'

/**
 * Models served by a self-hosted OpenAI-compatible inference gateway
 * (`THUNDERBOLT_INFERENCE_URL`). These are deployment-provided rather than
 * shipped: the operator names them in `THUNDERBOLT_INFERENCE_MODELS`, the proxy
 * in `routes.ts` accepts them, and `GET /config` advertises them so the model
 * picker lists them without a client release.
 *
 * The browser never talks to the gateway directly. Rows are published with
 * `provider: 'thunderbolt'` and `url: null`, which is the frontend's "call the
 * backend" contract (see `defaultModelOpus48`), so the gateway's API key stays
 * server-side and the gateway needs no CORS configuration.
 */

/**
 * Fixed namespace for deriving gateway model ids. Arbitrary but permanent: the
 * ids it produces land in user databases as row primary keys, and the defaults
 * reconciler treats a changed id as "new model, retire the old row". Never
 * change this value.
 */
const gatewayIdNamespace = '8f1b6d2e-4c7a-4b1e-9f3d-2a5c8e0b7d41'

/** RFC 4122 v5 UUID. Deterministic, so a model id is stable across restarts
 *  and identical on every replica. */
const uuidV5 = (name: string, namespace: string): string => {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]))
    .digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  // Stamp version (5) and the RFC 4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export type GatewayModelSpec = {
  /** Model id as the gateway knows it. Sent upstream verbatim. */
  id: string
  /** Label shown in the model picker. Defaults to `id`. */
  label: string
}

/**
 * Parse `THUNDERBOLT_INFERENCE_MODELS`: a comma-separated list of `id` or
 * `id=Label` entries, e.g. `llama-3.3-70b=Llama 3.3 70B,qwen-2.5-coder`.
 * Blank and malformed entries are skipped rather than throwing, so one typo
 * cannot stop the server from booting.
 */
export const parseGatewayModelSpecs = (raw: string): GatewayModelSpec[] => {
  const seen = new Set<string>()
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf('=')
      const id = (separator === -1 ? entry : entry.slice(0, separator)).trim()
      const label = (separator === -1 ? '' : entry.slice(separator + 1)).trim()
      if (!id || seen.has(id)) {
        return []
      }
      seen.add(id)
      return [{ id, label: label || id }]
    })
}

/** Settings this module reads. Passed explicitly rather than pulled from
 *  `getSettings()` so the config route stays injectable, matching the
 *  `getCorsOriginsList(settings)` style helpers in `@/config/settings`. */
export type GatewaySettings = Pick<Settings, 'thunderboltInferenceUrl' | 'thunderboltInferenceModels'>

/** Configured gateway models, empty when the gateway is not configured. */
export const getGatewayModelSpecs = (settings: GatewaySettings): GatewayModelSpec[] =>
  settings.thunderboltInferenceUrl ? parseGatewayModelSpecs(settings.thunderboltInferenceModels) : []

/** Whether `modelId` is one the configured gateway serves. */
export const isGatewayModel = (modelId: string, settings: GatewaySettings): boolean =>
  getGatewayModelSpecs(settings).some((spec) => spec.id === modelId)

/**
 * Publishable row for a gateway model.
 *
 * Capabilities are deliberately conservative, because a gateway can front any
 * model and we cannot introspect it: `vendor: null` means images are stripped
 * (`vendorSupportsImages` does not guess), `contextWindow: null` falls back to
 * the transport default, and parallel tool calls are off since advertising them
 * to a model that rejects them turns every tool call into an upstream error.
 */
const toSharedModel = (spec: GatewayModelSpec): SharedModel => ({
  id: uuidV5(spec.id, gatewayIdNamespace),
  name: spec.label,
  provider: 'thunderbolt',
  model: spec.id,
  url: null,
  isSystem: 1,
  enabled: 1,
  toolUsage: 1,
  isConfidential: 0,
  startWithReasoning: 0,
  supportsParallelToolCalls: 0,
  contextWindow: null,
  deletedAt: null,
  defaultHash: null,
  vendor: null,
  description: 'Served by this deployment’s inference gateway',
  userId: null,
})

/** Gateway models as publishable rows, empty when unconfigured. */
export const getGatewaySharedModels = (settings: GatewaySettings): SharedModel[] =>
  getGatewayModelSpecs(settings).map(toSharedModel)
