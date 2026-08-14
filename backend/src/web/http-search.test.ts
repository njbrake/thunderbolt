/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import {
  createPerplexityCompatibleSearchProvider,
  createSearxngSearchProvider,
  WebSearchBackendError,
} from './http-search'
import { normalizeSearchHits } from './normalize'

/** Record the request and answer with a canned body. */
const stubFetch = (body: unknown, init: { status?: number; text?: string } = {}) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = mock(async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} })
    if (init.text !== undefined) {
      return new Response(init.text, { status: init.status ?? 200 })
    }
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

describe('perplexity-compatible search adapter', () => {
  it('posts the query and result count to {base}/search', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://gateway.example/v1', fetchFn }).search('cats', {
      limit: 5,
    })

    expect(calls[0].url).toBe('https://gateway.example/v1/search')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'cats', max_results: 5 })
  })

  it('maps title, url, and snippet onto neutral hits', async () => {
    const { fetchFn } = stubFetch({
      results: [{ title: 'A page', url: 'https://example.com/a', snippet: 'Some text', date: '2026-01-02' }],
    })
    const hits = await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', {
      limit: 3,
    })

    expect(hits).toEqual([{ url: 'https://example.com/a', title: 'A page', snippet: 'Some text' }])
  })

  it('sends a bearer token when one is configured, and none when not', async () => {
    const withKey = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({
      baseUrl: 'https://g.example',
      apiKey: 'secret',
      fetchFn: withKey.fetchFn,
    }).search('q', { limit: 1 })
    expect((withKey.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret')

    const withoutKey = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({
      baseUrl: 'https://g.example',
      fetchFn: withoutKey.fetchFn,
    }).search('q', { limit: 1 })
    expect((withoutKey.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  // A backend hosting several search tools needs to know which one. As a path
  // segment, not a body field, so a backend without tools is not sent something it
  // would reject.
  it('addresses a named tool by path', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({
      baseUrl: 'https://gateway.example/v1',
      toolName: 'exa-search',
      fetchFn,
    }).search('q', { limit: 1 })

    expect(calls[0].url).toBe('https://gateway.example/v1/search/exa-search')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'q', max_results: 1 })
  })

  it('tolerates a trailing slash on the configured base URL', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://gateway.example/v1/', fetchFn }).search('q', {
      limit: 1,
    })
    expect(calls[0].url).toBe('https://gateway.example/v1/search')
  })

  it('skips a result with no usable URL rather than emitting a broken hit', async () => {
    const { fetchFn } = stubFetch({ results: [{ title: 'No link' }, { title: 'Fine', url: 'https://e.com/p' }] })
    const hits = await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', {
      limit: 5,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].url).toBe('https://e.com/p')
  })

  it('treats a missing or malformed results array as no results', async () => {
    const { fetchFn } = stubFetch({ unexpected: true })
    expect(
      await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', {
        limit: 5,
      }),
    ).toEqual([])
  })
})

describe('searxng search adapter', () => {
  it('gets {base}/search with the JSON format flag', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createSearxngSearchProvider({ baseUrl: 'http://searxng:8080', fetchFn }).search('cats & dogs', { limit: 5 })

    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('http://searxng:8080/search')
    expect(url.searchParams.get('q')).toBe('cats & dogs')
    expect(url.searchParams.get('format')).toBe('json')
    expect(calls[0].init.method).toBe('GET')
  })

  it('maps content into the snippet and img_src into the preview image', async () => {
    const { fetchFn } = stubFetch({
      results: [{ url: 'https://e.com/p', title: 'A page', content: 'Body text', img_src: 'https://e.com/i.png' }],
    })
    expect(await createSearxngSearchProvider({ baseUrl: 'http://s:8080', fetchFn }).search('q', { limit: 3 })).toEqual([
      {
        url: 'https://e.com/p',
        title: 'A page',
        snippet: 'Body text',
        previewImageUrl: 'https://e.com/i.png',
      },
    ])
  })

  it('prefers extracted_content when a fronting adapter supplies it', async () => {
    const { fetchFn } = stubFetch({
      results: [{ url: 'https://e.com/p', content: 'Short blurb', extracted_content: 'The fuller extraction' }],
    })
    const [hit] = await createSearxngSearchProvider({ baseUrl: 'http://s:8080', fetchFn }).search('q', { limit: 1 })
    expect(hit.snippet).toBe('The fuller extraction')
  })

  // SearXNG has no result-count parameter, so honouring the limit is the adapter's
  // job. Without this the route's clamp would not bound what reaches the model.
  it('trims the response to the requested limit', async () => {
    const { fetchFn } = stubFetch({
      results: Array.from({ length: 25 }, (_, i) => ({ url: `https://e.com/${i}` })),
    })
    expect(
      await createSearxngSearchProvider({ baseUrl: 'http://s:8080', fetchFn }).search('q', { limit: 4 }),
    ).toHaveLength(4)
  })
})

describe('http search adapter failures', () => {
  it('names the provider when the backend answers non-2xx', async () => {
    const { fetchFn } = stubFetch({}, { status: 503 })
    const provider = createSearxngSearchProvider({ baseUrl: 'http://s:8080', fetchFn })
    await expect(provider.search('q', { limit: 1 })).rejects.toThrow(WebSearchBackendError)
    await expect(provider.search('q', { limit: 1 })).rejects.toThrow('searxng')
  })

  it('reports a body that is not JSON rather than throwing a parse error', async () => {
    const { fetchFn } = stubFetch(null, { text: '<html>gateway timeout</html>' })
    await expect(
      createSearxngSearchProvider({ baseUrl: 'http://s:8080', fetchFn }).search('q', { limit: 1 }),
    ).rejects.toThrow('response was not JSON')
  })

  it('reports an unreachable backend with the transport message', async () => {
    const fetchFn = mock(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', { limit: 1 }),
    ).rejects.toThrow('connect ECONNREFUSED')
  })
})

/**
 * The configuration this whole change exists to make possible: a gateway serving
 * Perplexity's shape, with the result text arriving in `snippet` as a full page,
 * reaching the client capped and normalized. Exercises the adapter and the
 * normalization together, which is the seam a provider swap moves across.
 */
describe('gateway-backed search, end to end through normalization', () => {
  it('turns a gateway response into capped, HTTPS-only results', async () => {
    const { fetchFn, calls } = stubFetch({
      results: [
        {
          title: 'Quantization survey',
          url: 'http://arxiv.org/abs/2401.00001',
          snippet: 'P'.repeat(40_000),
        },
        { title: 'No URL here' },
      ],
    })

    const provider = createPerplexityCompatibleSearchProvider({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'gateway-key',
      toolName: 'exa-search',
      fetchFn,
    })
    const results = normalizeSearchHits(await provider.search('post-training quantization', { limit: 5 }))

    expect(calls[0].url).toBe('https://gateway.example/v1/search/exa-search')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: 'Quantization survey',
      pageUrl: 'https://arxiv.org/abs/2401.00001',
      snippet: `${'P'.repeat(1_000)}…`,
      faviconUrl: 'https://arxiv.org/favicon.ico',
      previewImageUrl: null,
    })
  })
})

describe('perplexity-compatible max_results ceiling', () => {
  // Our route clamps `limit` to 25 and the `search` tool's schema bounds nothing, so
  // the model can ask for more than this shape accepts. otari validates
  // `max_results` at 20 and answers 422, which would surface to the model as a
  // failed search rather than as fewer results.
  it('clamps a request above the shape ceiling of 20', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', { limit: 25 })
    expect(JSON.parse(String(calls[0].init.body)).max_results).toBe(20)
  })

  it('passes a request below the ceiling through untouched', async () => {
    const { fetchFn, calls } = stubFetch({ results: [] })
    await createPerplexityCompatibleSearchProvider({ baseUrl: 'https://g.example', fetchFn }).search('q', { limit: 7 })
    expect(JSON.parse(String(calls[0].init.body)).max_results).toBe(7)
  })
})
