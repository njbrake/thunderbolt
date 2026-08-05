/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { getGatewayModelSpecs, getGatewaySharedModels, isGatewayModel, parseGatewayModelSpecs } from './gateway-models'

const configured = (models: string) =>
  createTestSettings({
    thunderboltInferenceUrl: 'https://gateway.example.com/v1',
    thunderboltInferenceApiKey: 'key',
    thunderboltInferenceModels: models,
  })

describe('parseGatewayModelSpecs', () => {
  it('parses bare ids and defaults the label to the id', () => {
    expect(parseGatewayModelSpecs('a,b')).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('parses id=Label, keeping spaces inside the label', () => {
    expect(parseGatewayModelSpecs('llama-3.3-70b=Llama 3.3 70B')).toEqual([
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
    ])
  })

  it('trims whitespace and drops empty entries', () => {
    expect(parseGatewayModelSpecs('  a  , ,, b ')).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('skips malformed entries rather than throwing, so a typo cannot stop boot', () => {
    expect(parseGatewayModelSpecs('=Orphan Label,ok')).toEqual([{ id: 'ok', label: 'ok' }])
  })

  it('keeps the first of a duplicated id', () => {
    expect(parseGatewayModelSpecs('a=First,a=Second')).toEqual([{ id: 'a', label: 'First' }])
  })

  it('returns nothing for an empty string', () => {
    expect(parseGatewayModelSpecs('')).toEqual([])
  })
})

describe('getGatewayModelSpecs', () => {
  it('is empty when no gateway URL is configured, even if models are listed', () => {
    const settings = createTestSettings({ thunderboltInferenceModels: 'a,b' })
    expect(getGatewayModelSpecs(settings)).toEqual([])
  })

  it('is empty when a URL is set but no models are listed', () => {
    expect(getGatewayModelSpecs(configured(''))).toEqual([])
  })

  it('returns the configured models when both are set', () => {
    expect(getGatewayModelSpecs(configured('a,b')).map((spec) => spec.id)).toEqual(['a', 'b'])
  })
})

describe('isGatewayModel', () => {
  it('matches only exact configured ids', () => {
    const settings = configured('llama-3.3-70b')
    expect(isGatewayModel('llama-3.3-70b', settings)).toBe(true)
    expect(isGatewayModel('llama', settings)).toBe(false)
    expect(isGatewayModel('opus-4.8', settings)).toBe(false)
  })

  it('is false when the gateway is unconfigured', () => {
    expect(isGatewayModel('anything', createTestSettings())).toBe(false)
  })
})

describe('getGatewaySharedModels', () => {
  it('publishes rows the frontend routes back through this backend', () => {
    const [model] = getGatewaySharedModels(configured('llama-3.3-70b=Llama 3.3 70B'))

    // provider 'thunderbolt' + url null is the "call the backend" contract, which
    // is what keeps the gateway key server-side.
    expect(model.provider).toBe('thunderbolt')
    expect(model.url).toBeNull()
    expect(model.model).toBe('llama-3.3-70b')
    expect(model.name).toBe('Llama 3.3 70B')
    expect(model.enabled).toBe(1)
  })

  it('advertises conservative capabilities for an uninspectable endpoint', () => {
    const [model] = getGatewaySharedModels(configured('some-model'))

    // vendor null means images are stripped rather than guessed, and parallel
    // tool calls stay off so an unsupporting model does not error on every call.
    expect(model.vendor).toBeNull()
    expect(model.contextWindow).toBeNull()
    expect(model.supportsParallelToolCalls).toBe(0)
    expect(model.isConfidential).toBe(0)
  })

  it('derives a stable RFC 4122 v5 id from the model id', () => {
    const first = getGatewaySharedModels(configured('some-model'))[0].id
    const second = getGatewaySharedModels(configured('some-model=Renamed'))[0].id

    // Stable across restarts and independent of the label, because the id lands
    // in user databases as a row primary key.
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('gives different models different ids', () => {
    const ids = getGatewaySharedModels(configured('a,b')).map((model) => model.id)
    expect(new Set(ids).size).toBe(2)
  })
})
