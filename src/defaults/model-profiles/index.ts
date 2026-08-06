/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import { defaultModelProfileDeepseekV4Flash } from './deepseek'
import { defaultModelProfileGlm52 } from './glm'
import { defaultModelProfileOpus48 } from './opus'

export { defaultModelProfileDeepseekV4Flash } from './deepseek'
export { defaultModelProfileGlm52 } from './glm'
export { defaultModelProfileOpus48 } from './opus'

/**
 * Compute hash of user-editable fields for a model profile.
 * Includes deletedAt to treat soft-delete as a user configuration choice.
 * Excludes modelId (PK) and defaultHash (the hash itself).
 */
export const hashModelProfile = (profile: ModelProfile): string =>
  hashValues([
    profile.temperature,
    profile.maxSteps,
    profile.maxAttempts,
    profile.nudgeThreshold,
    profile.useSystemMessageModeDeveloper,
    profile.toolsOverride,
    profile.linkPreviewsOverride,
    profile.chatModeAddendum,
    profile.searchModeAddendum,
    profile.researchModeAddendum,
    profile.citationReinforcementEnabled,
    profile.citationReinforcementPrompt,
    profile.nudgeFinalStep,
    profile.nudgePreventive,
    profile.nudgeRetry,
    profile.nudgeSearchFinalStep,
    profile.nudgeSearchPreventive,
    profile.nudgeSearchRetry,
    profile.providerOptions ? JSON.stringify(profile.providerOptions) : null,
    profile.deletedAt,
  ])

/** All default model profiles for iteration */
export const defaultModelProfiles: ReadonlyArray<ModelProfile> = [
  defaultModelProfileOpus48,
  defaultModelProfileDeepseekV4Flash,
  defaultModelProfileGlm52,
] as const

/**
 * Profile for a model this bundle ships no profile for — i.e. one the server
 * advertised that the client was never built with.
 *
 * Profiles are 1:1 with models, and the values are pure tuning (temperature,
 * step/attempt caps, nudge copy) with no per-model knowledge baked in: all three
 * bundled profiles are byte-identical apart from `modelId`. So a model whose id
 * the bundle doesn't know can be paired with the same baseline rather than
 * dropped, which is what lets a self-hosted deployment surface the models its
 * inference gateway serves without shipping a client release per model.
 *
 * Deliberately mirrors the bundled values rather than inventing new ones: a
 * gateway model should behave like a shipped one until someone tunes it, and the
 * user can edit any of this afterwards.
 */
export const synthesizeModelProfile = (modelId: string): ModelProfile => ({
  modelId,
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: null,
  toolsOverride: null,
  linkPreviewsOverride: null,
  chatModeAddendum: null,
  searchModeAddendum: null,
  researchModeAddendum: null,
  citationReinforcementEnabled: 0,
  citationReinforcementPrompt: null,
  nudgeFinalStep: null,
  nudgePreventive: null,
  nudgeRetry: null,
  nudgeSearchFinalStep: null,
  nudgeSearchPreventive: null,
  nudgeSearchRetry: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})

/**
 * One profile per model id, preferring the bundled profile and synthesizing for
 * ids this bundle doesn't know. Preserves the 1:1 model↔profile invariant that
 * `reconcileDefaults` relies on.
 */
export const resolveModelProfiles = (modelIds: readonly string[]): ModelProfile[] => {
  const bundled = new Map(defaultModelProfiles.map((profile) => [profile.modelId, profile]))
  return modelIds.map((modelId) => bundled.get(modelId) ?? synthesizeModelProfile(modelId))
}
