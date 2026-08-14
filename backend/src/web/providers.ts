/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings, type Settings } from '@/config/settings'
import {
  createExaFetchProvider,
  createExaSearchProvider,
  exaProviderId,
  getExaClient,
  type ExaContentsClient,
  type ExaSearchClient,
} from './exa'
import {
  createPerplexityCompatibleSearchProvider,
  createSearxngSearchProvider,
  perplexityCompatibleProviderId,
  searxngProviderId,
} from './http-search'
import type { WebFetchProvider, WebSearchProvider } from './types'

/**
 * Resolve which adapter serves each web capability.
 *
 * `null` means the capability is unavailable, which is a supported state and not an
 * error: `/config` reports it, the client withholds the matching tool, and the
 * route answers 503 if something calls it anyway.
 *
 * Selection is by config, falling back to Exa when `EXA_API_KEY` is set, so a
 * deployment that sets neither new variable behaves as it did. A named provider
 * with no usable credential resolves to `null` rather than throwing, so a
 * half-finished configuration degrades to "no web access" instead of failing every
 * request. The name itself is an enum in the settings schema, so a typo is a
 * boot-time error naming the field rather than a silent no-op.
 */

type ProviderSettings = Pick<
  Settings,
  'webSearchProvider' | 'webFetchProvider' | 'exaApiKey' | 'webSearchUrl' | 'webSearchApiKey' | 'webSearchToolName'
>

const httpSearchConfig = (settings: ProviderSettings) => ({
  baseUrl: settings.webSearchUrl,
  apiKey: settings.webSearchApiKey || undefined,
  toolName: settings.webSearchToolName || undefined,
})

/**
 * Empty means "infer from whichever credential is present".
 *
 * Only Exa is inferred. The HTTP adapters are not, because `WEB_SEARCH_URL` alone
 * does not say which shape the backend speaks, and guessing would send a SearXNG
 * query to a Perplexity-shaped endpoint. Those are opt-in by name.
 */
const selectedProvider = (configured: string, settings: ProviderSettings): string =>
  configured || (settings.exaApiKey ? exaProviderId : '')

/**
 * The client factory is a parameter because `getExaClient` is memoized for the
 * process, so a test cannot get a second one by changing the environment.
 * @internal Exported for testing; production reads through the getters below.
 */
export const resolveWebSearchProvider = (
  settings: ProviderSettings,
  exaClientFactory: () => ExaSearchClient | null = getExaClient,
): WebSearchProvider | null => {
  switch (selectedProvider(settings.webSearchProvider, settings)) {
    case exaProviderId: {
      const client = exaClientFactory()
      return client ? createExaSearchProvider(client) : null
    }
    case perplexityCompatibleProviderId:
      return settings.webSearchUrl ? createPerplexityCompatibleSearchProvider(httpSearchConfig(settings)) : null
    case searxngProviderId:
      return settings.webSearchUrl ? createSearxngSearchProvider(httpSearchConfig(settings)) : null
    default:
      return null
  }
}

/** @internal Exported for testing; production reads through the getters below. */
export const resolveWebFetchProvider = (
  settings: ProviderSettings,
  exaClientFactory: () => ExaContentsClient | null = getExaClient,
): WebFetchProvider | null => {
  switch (selectedProvider(settings.webFetchProvider, settings)) {
    case exaProviderId: {
      const client = exaClientFactory()
      return client ? createExaFetchProvider(client) : null
    }
    default:
      return null
  }
}

/**
 * Resolved per call rather than cached, matching `getExaClient`'s own laziness:
 * settings are read at call time and the SDK client underneath is already
 * memoized, so this allocates an adapter object and nothing more.
 */
export const getWebSearchProvider = (): WebSearchProvider | null => resolveWebSearchProvider(getSettings())
export const getWebFetchProvider = (): WebFetchProvider | null => resolveWebFetchProvider(getSettings())

/**
 * Whether the selected provider has what it needs to answer a request.
 *
 * Credential-aware rather than merely "is a name set", because reporting a
 * capability that 503s puts back the failure the flag exists to prevent: the model
 * reaches for the tool mid-answer and the call fails. A provider added later states
 * its own requirement here.
 */
const providerIsUsable = (providerId: string, settings: ProviderSettings): boolean => {
  switch (providerId) {
    case exaProviderId:
      return !!settings.exaApiKey
    case perplexityCompatibleProviderId:
    case searxngProviderId:
      // A URL is the whole requirement: both shapes are reachable unauthenticated
      // (a self-hosted SearXNG, an otari on a private network), so an API key is
      // optional and its absence is not a misconfiguration.
      return !!settings.webSearchUrl
    default:
      return false
  }
}

/**
 * What `/config` advertises to the client.
 *
 * Answered from settings alone, without constructing a client: this is a config
 * question, and for every provider "configured" and "constructible" are the same
 * condition, so there is nothing to learn by instantiating one.
 */
export const getWebCapabilities = (
  settings: ProviderSettings,
): { webSearchEnabled: boolean; webFetchEnabled: boolean } => ({
  webSearchEnabled: providerIsUsable(selectedProvider(settings.webSearchProvider, settings), settings),
  webFetchEnabled: providerIsUsable(selectedProvider(settings.webFetchProvider, settings), settings),
})
