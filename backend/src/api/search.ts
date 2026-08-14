/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { normalizeSearchHits } from '@/web/normalize'
import { getWebSearchProvider } from '@/web/providers'
import type { SearchResponseDto, WebSearchProvider } from '@/web/types'
import { Elysia, t, type AnyElysia } from 'elysia'

// Re-exported from their new home so existing importers keep working. The DTOs
// belong with the provider contract now, since a provider is what has to satisfy
// them; see `web/types.ts`.
export type { SearchResponseDto, SearchResultDto } from '@/web/types'

type SearchDeps = {
  /** Stand-in provider used by tests via `createApp({ searchProvider })`. */
  searchProvider?: WebSearchProvider | null
}

export const createSearchRoutes = (auth: Auth, rateLimit?: AnyElysia, deps: SearchDeps = {}) =>
  new Elysia({ name: 'search-routes' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        g.use(rateLimit)
      }
      return g.get(
        '/search',
        async ({ query, set }): Promise<SearchResponseDto | { error: string }> => {
          const provider = 'searchProvider' in deps ? deps.searchProvider : getWebSearchProvider()
          if (!provider) {
            set.status = 503
            return { error: 'Search service is not configured' }
          }

          const limit = query.limit ? Math.min(Math.max(query.limit, 1), 25) : 10
          // Normalization stays here rather than in the provider so every adapter
          // gets the same HTTPS enforcement, favicon derivation, and title
          // fallback.
          return { results: normalizeSearchHits(await provider.search(query.q, { limit })) }
        },
        {
          query: t.Object({
            q: t.String(),
            limit: t.Optional(t.Numeric()),
          }),
        },
      )
    })
