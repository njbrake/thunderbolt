/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SharedModel } from '@shared/defaults/models'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  e2eeEnabled?: boolean
  /** Deployment-level UI capability flags from `GET /config`. Optional so an
   *  empty/offline config (standalone mode) reads as "default behavior":
   *  built-in agent shown, custom agents allowed. */
  builtInAgentEnabled?: boolean
  allowCustomAgents?: boolean
  /** Whether the backend has a provider behind `search`. */
  webSearchEnabled?: boolean
  /** Whether the backend has a provider behind `fetch_content`. Absent on a backend
   *  predating the split, where `webSearchEnabled` governed both. */
  webFetchEnabled?: boolean
  /** Minimum semver string the server allows. Clients below this are hard-blocked
   *  until they upgrade. Absent/empty = no enforcement. */
  minAppVersion?: string
  /** Server-shipped default sets, versioned so the client can pick between
   *  server and bundled by whichever declares the higher version. See
   *  "Reconciled defaults and version bumps" in AGENTS.md. */
  defaults?: {
    models?: {
      version: number
      data: SharedModel[]
    }
  }
}

type ConfigStore = {
  config: AppConfig
  updateConfig: (config: AppConfig) => void
}

const initialState = { config: {} as AppConfig }

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      ...initialState,
      updateConfig: (config) => set({ config }),
    }),
    { name: 'thunderbolt-config' },
  ),
)

/** Whether the built-in Thunderbolt agent appears in the agent list. Absent
 *  config (offline/standalone) defaults to enabled, so the app always has at
 *  least the built-in to fall back on. */
export const selectBuiltInAgentEnabled = (config: AppConfig): boolean => config.builtInAgentEnabled !== false

/** Whether the UI offers adding custom agents. Absent config defaults to allowed. */
export const selectAllowCustomAgents = (config: AppConfig): boolean => config.allowCustomAgents !== false

/**
 * Whether to hand the model the `search` tool.
 *
 * Absent defaults to enabled, matching the other flags here: a backend predating
 * this field, or a client that has not fetched config yet, keeps the behavior it
 * had rather than silently losing web access. Only an explicit `false`, a backend
 * saying it has no search provider, withdraws the tool.
 */
export const selectWebSearchEnabled = (config: AppConfig): boolean => config.webSearchEnabled !== false

/**
 * Whether to hand the model the `fetch_content` tool.
 *
 * Separate from search because the backend configures them separately: a search
 * provider need not fetch pages. Falls back to `webSearchEnabled` rather than
 * defaulting to `true` on its own, so a backend predating the split (which reported
 * one flag for both) still gets both tools or neither, instead of having page fetch
 * silently switched on against a deployment that cannot serve it.
 */
export const selectWebFetchEnabled = (config: AppConfig): boolean =>
  config.webFetchEnabled ?? selectWebSearchEnabled(config)
