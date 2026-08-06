/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { defaultModels } from '@shared/defaults/models'
import {
  canFetchCatalog,
  catalogRequestKey,
  fetchThunderboltCatalog,
  getThunderboltCatalog,
  isFetchableCatalogUrl,
  thunderboltModelCatalog,
} from './model-catalog'

describe('model catalog policy', () => {
  it('derives Thunderbolt choices from shipped defaults', () => {
    expect(thunderboltModelCatalog.map((model) => model.id)).toEqual(
      defaultModels.filter((model) => model.provider === 'thunderbolt').map((model) => model.model),
    )
  })

  it('invalidates catalog identity when credentials or endpoint change', () => {
    const base = catalogRequestKey({ provider: 'custom', url: 'https://a.example/v1', apiKey: 'one' })
    expect(catalogRequestKey({ provider: 'custom', url: 'https://b.example/v1', apiKey: 'one' })).not.toBe(base)
    expect(catalogRequestKey({ provider: 'custom', url: 'https://a.example/v1', apiKey: 'two' })).not.toBe(base)
  })

  describe('isFetchableCatalogUrl', () => {
    it('rejects empty and missing URLs', () => {
      expect(isFetchableCatalogUrl(undefined)).toBe(false)
      expect(isFetchableCatalogUrl('')).toBe(false)
    })

    it('rejects half-typed hosts mid-keystroke', () => {
      expect(isFetchableCatalogUrl('http')).toBe(false)
      expect(isFetchableCatalogUrl('http://')).toBe(false)
      expect(isFetchableCatalogUrl('localhost:11434')).toBe(false)
    })

    it('accepts complete URLs', () => {
      expect(isFetchableCatalogUrl('http://localhost:11434/v1')).toBe(true)
      expect(isFetchableCatalogUrl('https://api.example.com/v1')).toBe(true)
    })
  })

  describe('canFetchCatalog', () => {
    it('blocks key-gated providers until an API key is present', () => {
      expect(canFetchCatalog({ provider: 'openai' })).toBe(false)
      expect(canFetchCatalog({ provider: 'openrouter', apiKey: '' })).toBe(false)
      expect(canFetchCatalog({ provider: 'anthropic', apiKey: 'sk-test' })).toBe(true)
      expect(canFetchCatalog({ provider: 'openai', apiKey: 'sk-test' })).toBe(true)
    })

    it('blocks custom providers until the URL is fetchable', () => {
      expect(canFetchCatalog({ provider: 'custom', url: 'http' })).toBe(false)
      expect(canFetchCatalog({ provider: 'custom' })).toBe(false)
      expect(canFetchCatalog({ provider: 'custom', url: 'http://localhost:11434/v1' })).toBe(true)
    })

    it('allows credential-free providers unconditionally', () => {
      expect(canFetchCatalog({ provider: 'thunderbolt' })).toBe(true)
      expect(canFetchCatalog({ provider: 'tinfoil' })).toBe(true)
    })
  })
})

describe('getThunderboltCatalog', () => {
  afterEach(() => {
    useConfigStore.getState().updateConfig({} as never)
  })

  const advertise = (models: unknown[]) =>
    useConfigStore.getState().updateConfig({ defaults: { models: { version: 99, data: models } } } as never)

  it('falls back to the bundled catalogue before /config has loaded', () => {
    expect(getThunderboltCatalog()).toEqual(thunderboltModelCatalog)
  })

  // A self-hosted backend proxying an inference gateway advertises ids the client
  // was never built with, and the defaults reconciler drops them for lack of a
  // bundled profile, so the catalogue has to read /config directly.
  it('offers models the deployment advertises but the bundle does not know', () => {
    advertise([
      { provider: 'thunderbolt', model: 'kimi', name: 'Kimi', toolUsage: 1 },
      { provider: 'thunderbolt', model: 'llama-3.3-70b', name: 'Llama 3.3 70B', toolUsage: 1 },
    ])

    expect(getThunderboltCatalog().map((m) => m.id)).toEqual(['kimi', 'llama-3.3-70b'])
    expect(getThunderboltCatalog()[0].name).toBe('Kimi')
  })

  it('ignores advertised models belonging to other providers', () => {
    advertise([
      { provider: 'thunderbolt', model: 'kimi', name: 'Kimi', toolUsage: 1 },
      { provider: 'tinfoil', model: 'glm-5-2', name: 'GLM 5.2', toolUsage: 1 },
    ])

    expect(getThunderboltCatalog().map((m) => m.id)).toEqual(['kimi'])
  })

  it('falls back when the deployment advertises no thunderbolt models', () => {
    advertise([{ provider: 'tinfoil', model: 'glm-5-2', name: 'GLM 5.2', toolUsage: 1 }])
    expect(getThunderboltCatalog()).toEqual(thunderboltModelCatalog)
  })

  it('carries tool support through from the advertised row', () => {
    advertise([{ provider: 'thunderbolt', model: 'no-tools', name: 'No Tools', toolUsage: 0 }])
    expect(getThunderboltCatalog()[0].supports_tools).toBe(false)
  })
})

describe('fetchThunderboltCatalog', () => {
  afterEach(() => {
    useConfigStore.getState().updateConfig({} as never)
  })

  const advertise = (models: unknown[]) =>
    useConfigStore.getState().updateConfig({ defaults: { models: { version: 99, data: models } } } as never)

  // The config store is persisted and otherwise only filled during boot, so a
  // resumed phone would keep offering whatever the gateway served on its last
  // cold start. Opening the picker has to go back to the network.
  it('refreshes /config before reading the served list', async () => {
    const refresh = mock(async () => {
      advertise([{ provider: 'thunderbolt', model: 'freshly-added', name: 'Fresh', toolUsage: 1 }])
    })

    const models = await fetchThunderboltCatalog(refresh)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(models.map((m) => m.id)).toEqual(['freshly-added'])
  })

  it('keeps the previously known list when the refresh brings nothing new', async () => {
    advertise([{ provider: 'thunderbolt', model: 'kimi', name: 'Kimi', toolUsage: 1 }])

    // `fetchConfig` swallows its own failures and leaves the persisted config in
    // place, so an offline refresh must degrade to the last known list rather
    // than emptying the picker.
    const models = await fetchThunderboltCatalog(async () => undefined)

    expect(models.map((m) => m.id)).toEqual(['kimi'])
  })
})
