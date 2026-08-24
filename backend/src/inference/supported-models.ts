/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InferenceProvider } from './client'

export type ModelConfig = {
  provider: InferenceProvider
  internalName: string
  /** Whether to omit `temperature` from the upstream payload. */
  omitTemperature?: boolean
}

/**
 * Built-in models this backend routes by id. Extracted from `routes.ts` so
 * gateway discovery can detect (and drop) a gateway model whose id collides
 * with a built-in slug without importing the route module (which would be a
 * cycle: `routes.ts` imports gateway discovery).
 */
export const supportedModels: Record<string, ModelConfig> = {
  'opus-5': {
    provider: 'anthropic',
    internalName: 'claude-opus-5',
    omitTemperature: true,
  },
  'deepseek-v4-flash': {
    provider: 'fireworks',
    internalName: 'accounts/fireworks/models/deepseek-v4-flash',
  },
}

/** Whether `modelId` names a built-in model this backend routes directly. */
export const isBuiltInModel = (modelId: string): boolean => modelId in supportedModels
