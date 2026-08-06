/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModels, defaultModelsVersion, type SharedModel } from '@shared/defaults/models'

export type ModelsDefaults = {
  version: number
  data: readonly SharedModel[]
}

type ServerModelsDefaults = { version: number; data: SharedModel[] }

/**
 * Pick between server-supplied and bundled models defaults, preferring the
 * higher declared version. Behaves like an OTA channel: the server can hot-ship
 * new defaults without a client build; when offline / unreachable / behind, the
 * bundle wins.
 *
 * Rollback semantics are monotonic — a server that regresses its declared
 * version below what the client already has will not overwrite. To retract a
 * bad server-published set, ship a *higher* version with the reverted content.
 *
 * Sanity guards on the server payload (fall back to bundle when tripped):
 *   - version is a finite number strictly higher than the bundle's;
 *   - `data` is a non-empty array;
 *   - every entry is model-shaped (`id`, `model` and `provider` present).
 *
 * A bundle-id overlap used to be required too, because a fully-disjoint payload
 * meant `cleanupRemovedDefaults` retired every bundle-known row while the
 * reconcile pass inserted nothing — OTA-only ids had no bundled profile, so they
 * were dropped. `reconcileDefaults` now synthesizes a profile for an unknown id
 * instead of dropping it, so a disjoint payload inserts what it advertises and the
 * premise no longer holds.
 *
 * That requirement was actively wrong for self-hosted deployments: the shipped
 * lineup routes to Anthropic, Fireworks and Tinfoil, so a self-host with only its
 * own inference gateway configured can serve *none* of the bundled ids. Demanding
 * an overlap forced it to keep advertising models that fail on send.
 *
 * Shape-checking each entry replaces the overlap heuristic as the guard against a
 * malformed payload, and retirement stays bounded either way:
 * `cleanupRemovedDefaults` only sweeps rows with `isSystem = 1` and a
 * `defaultHash`, never anything the user created.
 */
export const pickModelsDefaults = (server: ServerModelsDefaults | undefined): ModelsDefaults => {
  if (
    server &&
    Number.isFinite(server.version) &&
    server.version > defaultModelsVersion &&
    Array.isArray(server.data) &&
    server.data.length > 0
  ) {
    const isModelShaped = (model: SharedModel) => !!model?.id && !!model?.model && !!model?.provider
    if (server.data.every(isModelShaped)) {
      return { version: server.version, data: server.data }
    }
    // Version and length look right but at least one entry is not a model. A
    // malformed payload must not drive retirement, so fall back and log.
    console.warn(
      `[pickModelsDefaults] Server payload rejected: ${server.data.filter((m) => !isModelShaped(m)).length} of ` +
        `${server.data.length} entries are missing id/model/provider. Falling back to the bundled lineup.`,
    )
  }
  return { version: defaultModelsVersion, data: defaultModels }
}
