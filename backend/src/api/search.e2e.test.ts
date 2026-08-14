/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'

import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import type { WebSearchProvider } from '@/web/types'

/** Build a stub search provider returning the canned hits below. Passed to
 *  createTestApp via dep injection — replaces `mock.module('exa-js')`, which would
 *  leak across files (see docs/development/testing.md).
 *
 *  Provider-shaped rather than Exa-shaped, which is the point of the seam: the
 *  hits still go through `normalizeSearchHits` in the route, so the HTTPS
 *  upgrades, favicon derivation, and title fallback asserted below are the ones
 *  every adapter's output gets. Exa's own field mapping is covered in
 *  `web/exa.test.ts`. */
const createStubSearchProvider = (): WebSearchProvider => ({
  id: 'stub',
  search: mock(async (_q: string, _opts: unknown) => [
    {
      title: 'Public site',
      url: 'https://example.com/post',
      previewImageUrl: 'http://example.com/cover.png', // forces http -> https upgrade
      faviconUrl: 'https://example.com/favicon.ico',
    },
    {
      title: null,
      url: 'http://example.org/another', // forces http -> https upgrade
      previewImageUrl: null,
      faviconUrl: null,
    },
  ]),
})

describe('GET /v1/search — e2e', () => {
  let handle: TestAppHandle

  afterEach(async () => {
    if (handle) {
      await handle.cleanup()
    }
  })

  it('returns normalised results with HTTPS-only URLs', async () => {
    handle = await createTestApp({ searchProvider: createStubSearchProvider() })
    const res = await handle.app.handle(
      new Request('http://localhost/v1/search?q=hello&limit=5', {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ title: string; pageUrl: string; faviconUrl: string | null; previewImageUrl: string | null }>
    }
    expect(body.results).toHaveLength(2)
    // pageUrl always HTTPS — the http://example.org URL is upgraded.
    for (const r of body.results) {
      expect(r.pageUrl.startsWith('https://')).toBe(true)
    }
    // First result keeps title; image is upgraded from http://.
    expect(body.results[0].title).toBe('Public site')
    expect(body.results[0].previewImageUrl).toBe('https://example.com/cover.png')
    expect(body.results[0].faviconUrl).toBe('https://example.com/favicon.ico')
    // Second result: title falls back to hostname; favicon is derived from origin.
    expect(body.results[1].title).toBe('example.org')
    expect(body.results[1].faviconUrl).toBe('https://example.org/favicon.ico')
    expect(body.results[1].previewImageUrl).toBeNull()
  })

  it('returns 401 for unauthenticated requests', async () => {
    handle = await createTestApp({ searchProvider: createStubSearchProvider() })
    const res = await handle.app.handle(new Request('http://localhost/v1/search?q=hello', { method: 'GET' }))
    expect(res.status).toBe(401)
  })
})
