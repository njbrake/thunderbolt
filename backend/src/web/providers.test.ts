/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { getWebCapabilities, resolveWebFetchProvider, resolveWebSearchProvider } from './providers'

const stubExaClient = () => ({ search: async () => ({ results: [] }), getContents: async () => ({ results: [] }) })
const noClient = () => null

describe('web provider resolution', () => {
  it('infers Exa when a key is present and no provider is named', () => {
    const settings = createTestSettings({ exaApiKey: 'key' })
    expect(resolveWebSearchProvider(settings, stubExaClient as never)?.id).toBe('exa')
    expect(resolveWebFetchProvider(settings, stubExaClient as never)?.id).toBe('exa')
  })

  it('resolves nothing when neither a key nor a provider is configured', () => {
    const settings = createTestSettings()
    expect(resolveWebSearchProvider(settings, noClient)).toBeNull()
    expect(resolveWebFetchProvider(settings, noClient)).toBeNull()
  })

  it('resolves nothing for a named provider whose credential is missing', () => {
    // Degrading to "no web access" beats throwing on every request: the client is
    // told the capability is off and withholds the tool, instead of the model
    // reaching for a tool that 500s mid-answer.
    const settings = createTestSettings({ webSearchProvider: 'exa', exaApiKey: '' })
    expect(resolveWebSearchProvider(settings, noClient)).toBeNull()
  })

  it('honours an explicit provider name when the credential is there', () => {
    const settings = createTestSettings({ webSearchProvider: 'exa', webFetchProvider: 'exa', exaApiKey: 'key' })
    expect(resolveWebSearchProvider(settings, stubExaClient as never)?.id).toBe('exa')
    expect(resolveWebFetchProvider(settings, stubExaClient as never)?.id).toBe('exa')
  })

  it('resolves each capability independently', () => {
    // The point of two settings. A deployment can serve search and not page fetch,
    // which is what a search-only backend looks like.
    const settings = createTestSettings({ webSearchProvider: 'exa', webFetchProvider: '', exaApiKey: 'key' })
    expect(resolveWebSearchProvider(settings, stubExaClient as never)?.id).toBe('exa')
    // `webFetchProvider` is empty, so it falls back to the key, which is present.
    expect(resolveWebFetchProvider(settings, stubExaClient as never)?.id).toBe('exa')
  })

  it('reports both capabilities off for an unconfigured deployment', () => {
    expect(getWebCapabilities(createTestSettings())).toEqual({ webSearchEnabled: false, webFetchEnabled: false })
  })

  it('reports both capabilities on when a key is present', () => {
    expect(getWebCapabilities(createTestSettings({ exaApiKey: 'key' }))).toEqual({
      webSearchEnabled: true,
      webFetchEnabled: true,
    })
  })

  it('reports a capability off when its provider is named but its credential is missing', () => {
    // The half-configured case. Advertising this as enabled is what would send the
    // model at a tool that 503s partway through an answer.
    expect(getWebCapabilities(createTestSettings({ webSearchProvider: 'exa', exaApiKey: '' }))).toEqual({
      webSearchEnabled: false,
      webFetchEnabled: false,
    })
  })
})
