/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createExaFetchProvider } from '@/web/exa'
import { createReadabilityFetchProvider } from '@/web/readability'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createFetchContentPlugin } from './fetch-content'

/**
 * Mount the real route over the real Exa adapter, with only the SDK call stubbed.
 *
 * This file used to define its own Elysia app with both route bodies copied into
 * it, so nothing here ever executed the route. Two things followed: the response
 * mapping was never actually asserted, and the copy kept a `/search` route that
 * the plugin does not define, so a dozen tests exercised a handler that ships
 * nowhere. Those are gone; `/v1/search` lives in `api/search.ts`.
 *
 * Going through the adapter rather than injecting a bare provider keeps the
 * `getContents` assertions below meaningful: they check that the route's clamped
 * `max_length` reaches the SDK. `null` means no provider configured.
 */
const mountFetchContent = (exaClient: unknown) =>
  new Elysia().use(
    createFetchContentPlugin({
      fetchProvider: exaClient ? createExaFetchProvider(exaClient as never) : null,
    }),
  )

describe('Pro - fetch-content route', () => {
  let app: ReturnType<typeof mountFetchContent>
  let mockGetContents: any

  beforeEach(() => {
    mockGetContents = mock(() => Promise.resolve({ results: [] }))
    app = mountFetchContent({ getContents: mockGetContents })
  })

  describe('POST /fetch-content', () => {
    it('should fetch content successfully with API key configured', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'This is the fetched content',
          author: 'Test Author',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'This is the fetched content',
          isTruncated: false,
          author: 'Test Author',
          publishedDate: null,
          image: null,
          favicon: null,
        },
        success: true,
      })
      expect(mockGetContents).toHaveBeenCalledWith(['https://example.com'], {
        livecrawlTimeout: 5_000,
        extras: { imageLinks: 1 },
        text: { maxCharacters: 16_000 },
      })
    })

    // The reason `WebPageContent` exists. The route used to spread the provider's
    // object onto the response, so these two assertions could not both hold: the
    // date arrived under Exa's spelling and every incidental provider field came
    // with it. Revert the mapping in `web/exa.ts` and this fails on the first assert.
    it('publishes the provider date under the DTO name and drops provider-only fields', async () => {
      mockGetContents.mockResolvedValueOnce({
        results: [
          {
            url: 'https://example.com/dated',
            title: 'Dated Page',
            text: 'body',
            publishedDate: '2024-01-01',
            author: 'A. Writer',
            image: 'https://example.com/i.png',
            favicon: 'https://example.com/f.ico',
            // Fields Exa returns that no client reads. They must not reach the wire.
            id: 'exa-internal-id',
            score: 0.87,
            highlights: ['a highlight'],
            highlightScores: [0.5],
          },
        ],
      })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/dated' }),
        }),
      )

      const { data } = await response.json()
      expect(data.publishedDate).toBe('2024-01-01')
      expect(Object.keys(data).sort()).toEqual([
        'author',
        'favicon',
        'image',
        'isTruncated',
        'publishedDate',
        'text',
        'title',
        'url',
      ])
    })

    it('nulls the optional fields the provider omitted rather than leaving them undefined', async () => {
      mockGetContents.mockResolvedValueOnce({ results: [{ url: 'https://example.com/bare', text: 'body' }] })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/bare' }),
        }),
      )

      const { data } = await response.json()
      // Present and null, not absent: a client destructuring these gets a value it
      // can render a fallback for, and JSON drops `undefined` silently.
      expect(data).toMatchObject({ title: null, author: null, publishedDate: null, image: null, favicon: null })
    })

    it('should throw error when API key is not configured', async () => {
      // No provider resolved, which is what an unconfigured deployment looks like
      const appNoKey = mountFetchContent(null)

      const response = await appNoKey.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(500)
      // Sanitized, not the thrown message. This assertion used to expect
      // "Fetch content service is not configured" to appear in the body, which is
      // what the copied error handler did; the real `safeErrorHandler` returns a
      // standard reason phrase because `getSafeErrorMessage` is documented never to
      // return internal detail. Asserting the leak would have rewarded a
      // regression that reintroduced it.
      expect(await response.json()).toEqual({ success: false, data: null, error: 'Internal Server Error' })
    })

    // 422, not 400: Elysia's own status for a body that fails the `t.Object`
    // schema. The previous expectation of 400 came from the copied error handler,
    // which mapped `code === 'VALIDATION'` itself.
    it('should return 422 when url is missing', async () => {
      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(response.status).toBe(422)
      // Elysia's own validation payload, naming the offending property. The old
      // assertions here were `success: false` plus an `error` string, which is the
      // envelope the copied handler produced and not what a client receives.
      expect(await response.json()).toMatchObject({ type: 'validation', on: 'body', property: '/url' })
    })

    it('should return 422 when url is not a string', async () => {
      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 123 }), // should be string
        }),
      )

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ type: 'validation', on: 'body', property: '/url' })
    })

    it('should handle fetch API errors gracefully', async () => {
      mockGetContents.mockRejectedValueOnce(new Error('Network error'))

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should handle empty content results', async () => {
      mockGetContents.mockResolvedValueOnce({ results: [] })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: null,
        success: true,
      })
    })

    it('should handle different URL formats', async () => {
      const testCases = [
        'https://example.com',
        'http://example.com',
        'https://subdomain.example.com/path?query=1',
        'https://example.com/page#anchor',
      ]

      for (const url of testCases) {
        mockGetContents.mockResolvedValueOnce({ results: [{ url, text: 'content' }] })

        const response = await app.handle(
          new Request('http://localhost/fetch-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          }),
        )

        expect(response.status).toBe(200)
        expect(mockGetContents).toHaveBeenCalledWith([url], {
          livecrawlTimeout: 5_000,
          extras: { imageLinks: 1 },
          text: { maxCharacters: 16_000 },
        })
      }
    })

    it('should set isTruncated to true and append instruction when text reaches max characters limit', async () => {
      // Create text that is exactly at the limit (16,000 chars)
      const longText = 'A'.repeat(16_000)
      const mockContent = [
        {
          url: 'https://example.com/long',
          title: 'Long Page',
          text: longText,
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/long' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.isTruncated).toBe(true)
      expect(data.data.text).toContain('[Content truncated. Call fetch_content with max_length=32000 for more.]')
    })

    it('should set isTruncated to false when text is under the limit', async () => {
      const shortText = 'Short content'
      const mockContent = [
        {
          url: 'https://example.com/short',
          title: 'Short Page',
          text: shortText,
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/short' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.isTruncated).toBe(false)
    })

    it('should handle content with no text field', async () => {
      const mockContent = [
        {
          url: 'https://example.com/no-text',
          title: 'Page Without Text',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/no-text' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.isTruncated).toBe(false)
    })

    it('should respect custom max_length parameter', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'Short content',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', max_length: 32000 }),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockGetContents).toHaveBeenCalledWith(['https://example.com'], {
        livecrawlTimeout: 5_000,
        extras: { imageLinks: 1 },
        text: { maxCharacters: 32_000 },
      })
    })

    it('should enforce hard cap of 64000 characters', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'Content',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', max_length: 100000 }),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockGetContents).toHaveBeenCalledWith(['https://example.com'], {
        livecrawlTimeout: 5_000,
        extras: { imageLinks: 1 },
        text: { maxCharacters: 64_000 },
      })
    })

    it('should enforce minimum of 1000 characters', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'Content',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', max_length: 100 }),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockGetContents).toHaveBeenCalledWith(['https://example.com'], {
        livecrawlTimeout: 5_000,
        extras: { imageLinks: 1 },
        text: { maxCharacters: 1_000 },
      })
    })

    it('should not append instruction when at hard cap', async () => {
      const longText = 'A'.repeat(64_000)
      const mockContent = [
        {
          url: 'https://example.com/long',
          title: 'Long Page',
          text: longText,
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/long', max_length: 64000 }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.isTruncated).toBe(true)
      expect(data.data.text).not.toContain('[Content truncated.')
    })

    it('should suggest doubling max_length in truncation instruction', async () => {
      const longText = 'A'.repeat(32_000)
      const mockContent = [
        {
          url: 'https://example.com/long',
          title: 'Long Page',
          text: longText,
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/long', max_length: 32000 }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.isTruncated).toBe(true)
      expect(data.data.text).toContain('[Content truncated. Call fetch_content with max_length=64000 for more.]')
    })
  })
})

/**
 * The route over the readability provider, which is the combination a deployment
 * with no contents vendor runs. Asserted here rather than only in the adapter's own
 * tests because the truncation hint is the route's contribution, and the model's
 * behaviour depends on the two halves agreeing.
 */
describe('Pro - fetch-content over the readability provider', () => {
  const pageHtml = (body: string) =>
    `<!doctype html><html><head><title>A Page</title></head><body><article><p>${body}</p></article></body></html>`

  const mountReadability = (html: string) =>
    new Elysia().use(
      createFetchContentPlugin({
        fetchProvider: createReadabilityFetchProvider({
          fetchFn: (async () =>
            new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch,
          dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        }),
      }),
    )

  const fetchContentOnce = async (html: string, maxLength?: number) => {
    const response = await mountReadability(html).handle(
      new Request('http://localhost/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/post', ...(maxLength ? { max_length: maxLength } : {}) }),
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()).data
  }

  it('returns extracted text with no credential configured anywhere', async () => {
    const data = await fetchContentOnce(pageHtml('A paragraph long enough to be treated as the article body here.'))

    expect(data.text).toContain('A paragraph long enough')
    expect(data.title).toBe('A Page')
    expect(data.isTruncated).toBe(false)
    expect(data.text).not.toContain('[Content truncated')
  })

  it('appends the same truncation hint the Exa path produces', async () => {
    // `max_length` is clamped to a 1000 minimum by the route, so ask for that and
    // hand back more than it.
    const data = await fetchContentOnce(pageHtml('B'.repeat(4_000)), 1_000)

    expect(data.isTruncated).toBe(true)
    expect(data.text).toContain('[Content truncated. Call fetch_content with max_length=2000 for more.]')
  })
})
