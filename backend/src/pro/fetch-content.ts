/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { safeErrorHandler } from '@/middleware/error-handling'
import { getWebFetchProvider } from '@/web/providers'
import type { WebFetchProvider } from '@/web/types'
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

      const page = await provider.fetchContent(body.url, { maxCharacters })
      if (!page) {
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
