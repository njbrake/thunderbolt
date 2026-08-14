/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createExaFetchProvider, createExaSearchProvider } from './exa'

/**
 * The Exa-specific half: which SDK fields become which neutral ones, and which SDK
 * options a request turns into. Everything downstream of this is provider-agnostic
 * and covered elsewhere (`normalize.test.ts` for search policy,
 * `pro/fetch-content.test.ts` for the route).
 *
 * The search mapping needs its own home because the `/search` e2e test injects a
 * provider now, so nothing there would notice if Exa's field names moved.
 */
describe('createExaSearchProvider', () => {
  it('maps Exa result fields onto neutral hits', async () => {
    const search = mock(async () => ({
      results: [
        {
          id: 'internal',
          score: 0.9,
          title: 'A page',
          url: 'https://example.com/a',
          favicon: 'https://example.com/f.ico',
          image: 'https://example.com/i.png',
        },
      ],
    }))

    const hits = await createExaSearchProvider({ search } as never).search('query', { limit: 3 })

    expect(hits).toEqual([
      {
        url: 'https://example.com/a',
        title: 'A page',
        faviconUrl: 'https://example.com/f.ico',
        previewImageUrl: 'https://example.com/i.png',
      },
    ])
  })

  it('passes the requested limit through as numResults', async () => {
    const search = mock(async () => ({ results: [] }))
    await createExaSearchProvider({ search } as never).search('query', { limit: 7 })
    expect(search).toHaveBeenCalledWith('query', { numResults: 7, useAutoprompt: true, type: 'fast' })
  })

  it('nulls absent optional fields rather than passing undefined along', async () => {
    const search = mock(async () => ({ results: [{ url: 'https://example.com/bare' }] }))
    expect(await createExaSearchProvider({ search } as never).search('q', { limit: 1 })).toEqual([
      { url: 'https://example.com/bare', title: null, faviconUrl: null, previewImageUrl: null },
    ])
  })
})

describe('createExaFetchProvider', () => {
  it('reports isTruncated when the text reaches the requested cap', async () => {
    const getContents = mock(async () => ({ results: [{ url: 'https://e.com', text: 'A'.repeat(100) }] }))
    const page = await createExaFetchProvider({ getContents } as never).fetchContent('https://e.com', {
      maxCharacters: 100,
    })
    expect(page?.isTruncated).toBe(true)
  })

  it('does not report isTruncated one character below the cap', async () => {
    const getContents = mock(async () => ({ results: [{ url: 'https://e.com', text: 'A'.repeat(99) }] }))
    const page = await createExaFetchProvider({ getContents } as never).fetchContent('https://e.com', {
      maxCharacters: 100,
    })
    expect(page?.isTruncated).toBe(false)
  })

  it('returns null when the provider had no result for the URL', async () => {
    const getContents = mock(async () => ({ results: [] }))
    expect(
      await createExaFetchProvider({ getContents } as never).fetchContent('https://e.com', { maxCharacters: 16_000 }),
    ).toBeNull()
  })

  it('leaves the truncation hint to the route', async () => {
    const getContents = mock(async () => ({ results: [{ url: 'https://e.com', text: 'A'.repeat(100) }] }))
    const page = await createExaFetchProvider({ getContents } as never).fetchContent('https://e.com', {
      maxCharacters: 100,
    })
    // The hint names this route's `max_length` parameter, so it is the route's to
    // add for every provider alike. A provider that added its own would produce two.
    expect(page?.text).not.toContain('[Content truncated')
  })
})
