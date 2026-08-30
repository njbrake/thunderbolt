/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { modelSupportsImages } from './model-image-support'

const model = (over: { model?: string; vendor?: string | null } = {}) => ({
  model: over.model ?? 'homelab:qwen-vl',
  vendor: over.vendor ?? null,
})

describe('modelSupportsImages', () => {
  test('accepts a known image-capable vendor with no deployment declaration', () => {
    expect(modelSupportsImages(model({ vendor: 'anthropic' }), [])).toBe(true)
  })

  test('rejects an unknown vendor with no deployment declaration', () => {
    // The regression this whole path exists for: a gateway model is published
    // with `vendor: null`, so vendor alone can never clear it.
    expect(modelSupportsImages(model({ vendor: null }), [])).toBe(false)
    expect(modelSupportsImages(model({ vendor: 'qwen' }), [])).toBe(false)
  })

  test('accepts a gateway model the operator declared, despite a null vendor', () => {
    expect(modelSupportsImages(model({ model: 'homelab:qwen-vl' }), ['homelab:qwen-vl'])).toBe(true)
  })

  test('matches the declaration on model id, not on a different model', () => {
    expect(modelSupportsImages(model({ model: 'homelab:llama' }), ['homelab:qwen-vl'])).toBe(false)
  })

  test('either signal alone is sufficient', () => {
    expect(modelSupportsImages(model({ vendor: 'openai' }), ['something-else'])).toBe(true)
  })
})
