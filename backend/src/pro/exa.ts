/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { memoize } from '@/lib/memoize'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { Exa } from 'exa-js'
import type { FetchContentResponse, WebPageContent } from './types'

/** Memoized Exa client — exported so other modules (e.g. /search) reuse the same instance. */
export const getExaClient = memoize((): Exa | null => {
  const apiKey = getSettings().exaApiKey
  if (!apiKey) {
    return null
  }
  return new Exa(apiKey)
})

/** The slice of Exa this route calls, so a test can stand in for it. Mirrors
 *  `SearchExaClient` in `api/search.ts`. */
export type FetchContentExaClient = { getContents: Exa['getContents'] }

type ExaDeps = { exaClient?: FetchContentExaClient | null }

/**
 * Elysia plugin that provides Exa client in state.
 *
 * A factory so the routes are reachable with an injected client. The previous
 * module-level plugin read `getExaClient()` at import time, which left its test
 * no way in: `exa.test.ts` had copied both route bodies into itself and asserted
 * against the copy, so the real handler below was never executed by a test and
 * kept a `/search` route that production had already dropped.
 */
export const createExaPlugin = (deps: ExaDeps = {}) =>
  new Elysia({ name: 'exa' })
    .onError(safeErrorHandler)
    // `in` rather than `??`: an explicit `null` is a test asking for the
    // unconfigured path, and `null ?? getExaClient()` would hand it a real client.
    .state('exaClient', 'exaClient' in deps ? deps.exaClient : getExaClient())
    .post(
      '/fetch-content',
      async ({ body, store }): Promise<FetchContentResponse> => {
        if (!store.exaClient) {
          throw new Error('Fetch content service is not configured.')
        }

        const defaultMaxChars = 16_000
        const hardCap = 64_000
        const minChars = 1_000
        const requestedMax = body.max_length ?? defaultMaxChars
        const maxCharacters = Math.min(Math.max(requestedMax, minChars), hardCap)

        const response = await store.exaClient.getContents([body.url], {
          livecrawlTimeout: 5_000,
          extras: { imageLinks: 1 },
          text: { maxCharacters },
        })

        const result = response.results[0]
        if (!result) {
          return { data: null, success: true }
        }

        // Use >= as a conservative check: if Exa returns exactly maxCharacters,
        // the original content was likely longer and got truncated by Exa's API
        const isTruncated = (result.text?.length ?? 0) >= maxCharacters

        // If truncated and not at hard cap, suggest fetching more
        const truncationHint =
          isTruncated && maxCharacters < hardCap
            ? `\n\n[Content truncated. Call fetch_content with max_length=${Math.min(maxCharacters * 2, hardCap)} for more.]`
            : ''

        // Mapped field by field rather than spread. The spread put Exa's own
        // names and its incidental fields (id, score, highlights) on the wire,
        // which is what made `WebPageContent` necessary; listing them here is
        // what keeps a provider swap from changing the response.
        const data: WebPageContent = {
          url: result.url,
          title: result.title ?? null,
          text: (result.text ?? '') + truncationHint,
          isTruncated,
          author: result.author ?? null,
          publishedDate: result.publishedDate ?? null,
          image: result.image ?? null,
          favicon: result.favicon ?? null,
        }

        return { data, success: true }
      },
      {
        body: t.Object({
          url: t.String(),
          max_length: t.Optional(t.Number()),
        }),
      },
    )

/** The plugin the app mounts, bound to the settings-derived client. */
export const exaPlugin = createExaPlugin()
