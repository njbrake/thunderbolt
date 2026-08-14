/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { memoize } from '@/lib/memoize'
import { Exa } from 'exa-js'
import type {
  WebFetchOptions,
  WebFetchProvider,
  WebPageContent,
  WebSearchHit,
  WebSearchOptions,
  WebSearchProvider,
} from './types'

/**
 * Memoized Exa client.
 *
 * Lives beside the adapters rather than in a route module, which is what lets both
 * routes depend on a provider without depending on each other: `/search` used to
 * import this from `pro/exa.ts`, the fetch route's own file.
 */
export const getExaClient = memoize((): Exa | null => {
  const apiKey = getSettings().exaApiKey
  if (!apiKey) {
    return null
  }
  return new Exa(apiKey)
})

/** The slices of Exa the adapters call, so a test can stand in for either. */
export type ExaSearchClient = { search: Exa['search'] }
export type ExaContentsClient = { getContents: Exa['getContents'] }

export const exaProviderId = 'exa'

export const createExaSearchProvider = (client: ExaSearchClient): WebSearchProvider => ({
  id: exaProviderId,
  search: async (query: string, { limit }: WebSearchOptions): Promise<WebSearchHit[]> => {
    const response = await client.search(query, {
      numResults: limit,
      useAutoprompt: true,
      type: 'fast',
    })
    return response.results.map((result) => ({
      url: result.url,
      title: result.title ?? null,
      faviconUrl: result.favicon ?? null,
      previewImageUrl: result.image ?? null,
    }))
  },
})

export const createExaFetchProvider = (client: ExaContentsClient): WebFetchProvider => ({
  id: exaProviderId,
  fetchContent: async (url: string, { maxCharacters }: WebFetchOptions): Promise<WebPageContent | null> => {
    const response = await client.getContents([url], {
      livecrawlTimeout: 5_000,
      extras: { imageLinks: 1 },
      text: { maxCharacters },
    })

    const result = response.results[0]
    if (!result) {
      return null
    }

    return {
      url: result.url,
      title: result.title ?? null,
      text: result.text ?? '',
      // Use >= as a conservative check: if Exa returns exactly maxCharacters,
      // the original content was likely longer and got truncated by Exa's API
      isTruncated: (result.text?.length ?? 0) >= maxCharacters,
      author: result.author ?? null,
      publishedDate: result.publishedDate ?? null,
      image: result.image ?? null,
      favicon: result.favicon ?? null,
    }
  },
})
