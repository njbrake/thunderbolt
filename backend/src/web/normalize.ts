/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ensureHttps } from '@/utils/url-validation'
import { deriveFaviconUrl } from '@shared/url'
import type { SearchResultDto, WebSearchHit } from './types'

/**
 * Turn a provider's hits into what the client renders.
 *
 * Deliberately outside the providers. Every rule here is one the app wants applied
 * whatever answered the search: a hit whose URL will not upgrade to HTTPS is
 * dropped rather than rendered as a mixed-content link, a missing favicon is
 * derived from the host so a source card is never blank, and a missing title falls
 * back to the hostname. A provider that did its own normalization could quietly
 * change any of those by being swapped in.
 */
export const normalizeSearchHits = (hits: readonly WebSearchHit[]): SearchResultDto[] => {
  const results: SearchResultDto[] = []
  for (const hit of hits) {
    const pageUrl = ensureHttps(hit.url)
    if (!pageUrl) {
      continue
    }
    results.push({
      // `??`, not `||`: keeps the route's existing behaviour for an empty-string
      // title rather than folding an unrelated change into the provider split.
      title: hit.title ?? new URL(pageUrl).hostname,
      pageUrl,
      snippet: capSnippet(hit.snippet),
      faviconUrl: ensureHttps(hit.faviconUrl ?? null) ?? deriveFaviconUrl(pageUrl),
      previewImageUrl: ensureHttps(hit.previewImageUrl ?? null),
    })
  }
  return results
}

/**
 * Per-result text budget.
 *
 * A snippet is not always a snippet: some backends return the whole extracted page
 * in that field (otari's `/v1/search` does whenever contents are requested), so a
 * ten-result search could otherwise put hundreds of KB into the model's context in
 * one tool call. Capping here rather than in each adapter means a provider added
 * later cannot forget to, and the model still has `fetch_content` when it needs a
 * full page.
 */
const snippetMaxChars = 1_000

const capSnippet = (snippet: string | null | undefined): string | null => {
  const trimmed = snippet?.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > snippetMaxChars ? `${trimmed.slice(0, snippetMaxChars).trimEnd()}…` : trimmed
}
