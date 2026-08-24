/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import { defaultModelProfileDeepseekV4Flash } from './deepseek'
import { defaultModelProfileGlm52 } from './glm'
import { defaultModelProfileOpus5 } from './opus'

export { defaultModelProfileDeepseekV4Flash } from './deepseek'
export { defaultModelProfileGlm52 } from './glm'
export { defaultModelProfileOpus5 } from './opus'

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
  defaultModelProfileOpus5,
  defaultModelProfileDeepseekV4Flash,
  defaultModelProfileGlm52,
] as const

/**
 * Synthesize a profile for an inference-gateway model.
 *
 * Gateway model ids are discovered at runtime, so no static profile can ship
 * for them — yet the 1:1 model↔profile invariant still has to hold for the row
 * to be usable. This supplies conservative defaults (identical in spirit to the
 * bundled hosted profiles: no temperature override, a sane step/attempt budget,
 * no mode addenda or nudges) keyed to the discovered `modelId`.
 */
export const buildGatewayModelProfile = (modelId: string): ModelProfile => ({
  modelId,
  temperature: null,
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
