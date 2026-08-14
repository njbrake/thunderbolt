/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { safeErrorHandler } from '@/middleware/error-handling'
import { getWebFetchProvider } from '@/web/providers'
import { WebFetchUnavailableError, type WebFetchProvider } from '@/web/types'
import { Elysia, t } from 'elysia'
import type { FetchContentResponse } from './types'

type FetchContentDeps = {
  /** Stand-in provider for tests. Omit to resolve from settings. */
  fetchProvider?: WebFetchProvider | null
}

const defaultMaxChars = 16_000
const hardCap = 64_000
const minChars = 1_000

/**
 * `POST /v1/pro/fetch-content`.
 *
 * A factory so the route is reachable with an injected provider. The previous
 * module-level plugin resolved its Exa client at import time, which left its test
 * no way in: the test had copied the route body into itself and asserted against
 * the copy, so this handler was never executed by a test.
 */
export const createFetchContentPlugin = (deps: FetchContentDeps = {}) =>
  new Elysia({ name: 'fetch-content' }).onError(safeErrorHandler).post(
    '/fetch-content',
    async ({ body }): Promise<FetchContentResponse> => {
      const provider = 'fetchProvider' in deps ? deps.fetchProvider : getWebFetchProvider()
      if (!provider) {
        throw new Error('Fetch content service is not configured.')
      }

      const requestedMax = body.max_length ?? defaultMaxChars
      const maxCharacters = Math.min(Math.max(requestedMax, minChars), hardCap)

      let page: Awaited<ReturnType<typeof provider.fetchContent>>
      try {
        page = await provider.fetchContent(body.url, { maxCharacters })
      } catch (error) {
        if (!(error instanceof WebFetchUnavailableError)) {
          // A real fault. Let it reach `safeErrorHandler` as a 500 rather than
          // dressing it up as a verdict about the page.
          throw error
        }
        // Answered as 200 with `success: false`, not as a 5xx. Two reasons: the
        // envelope already carries `success` and the client is written to throw on
        // it, and a 5xx body is not reliably readable by the browser here (an edge
        // can substitute its own response for an origin 5xx, which is how a clear
        // message became a generic NetworkError while debugging this). The model
        // gets the reason and can try another URL.
        console.warn('[fetch-content] page unavailable:', error.message)
        return { data: null, success: false, error: error.message }
      }
      if (!page) {
        // Reached, nothing to extract: a PDF, an image, an empty body.
        return { data: null, success: true }
      }

      // The hint is appended here, not in the provider: it is a model-facing
      // instruction naming this route's own `max_length` parameter, so every
      // provider should produce the same one. A provider only reports whether it
      // hit the cap.
      const truncationHint =
        page.isTruncated && maxCharacters < hardCap
          ? `\n\n[Content truncated. Call fetch_content with max_length=${Math.min(maxCharacters * 2, hardCap)} for more.]`
          : ''

      return { data: { ...page, text: page.text + truncationHint }, success: true }
    },
    {
      body: t.Object({
        url: t.String(),
        max_length: t.Optional(t.Number()),
      }),
    },
  )

/** The plugin the app mounts, bound to the configured provider. */
export const fetchContentPlugin = createFetchContentPlugin()
