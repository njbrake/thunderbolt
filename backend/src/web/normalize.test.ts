/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { normalizeSearchHits } from './normalize'

/**
 * These rules used to live inside the `/search` handler, where they were only
 * reachable through Exa's response shape. They are asserted here because they are
 * the policy every provider's hits pass through, so an adapter added later inherits
 * them without restating any of it.
 */
describe('normalizeSearchHits', () => {
  it('upgrades http URLs to https', () => {
    const [result] = normalizeSearchHits([{ url: 'http://example.org/page' }])
    expect(result.pageUrl).toBe('https://example.org/page')
  })

  it('drops a hit whose URL cannot be made https rather than rendering it', () => {
    expect(normalizeSearchHits([{ url: 'not-a-url' }, { url: 'https://ok.example/page' }])).toEqual([
      {
        title: 'ok.example',
        pageUrl: 'https://ok.example/page',
        snippet: null,
        faviconUrl: 'https://ok.example/favicon.ico',
        previewImageUrl: null,
      },
    ])
  })

  it('derives a favicon from the page origin when the provider gives none', () => {
    const [result] = normalizeSearchHits([{ url: 'https://example.com/deep/path?q=1' }])
    expect(result.faviconUrl).toBe('https://example.com/favicon.ico')
  })

  it('keeps a provider favicon but upgrades it', () => {
    const [result] = normalizeSearchHits([
      { url: 'https://example.com/p', faviconUrl: 'http://cdn.example.com/icon.png' },
    ])
    expect(result.faviconUrl).toBe('https://cdn.example.com/icon.png')
  })

  it('falls back to the hostname when the provider gives no title', () => {
    expect(normalizeSearchHits([{ url: 'https://example.com/p', title: null }])[0].title).toBe('example.com')
  })

  it('nulls a preview image it cannot upgrade instead of dropping the hit', () => {
    const [result] = normalizeSearchHits([{ url: 'https://example.com/p', previewImageUrl: 'javascript:alert(1)' }])
    expect(result.pageUrl).toBe('https://example.com/p')
    expect(result.previewImageUrl).toBeNull()
  })
})

describe('normalizeSearchHits snippet handling', () => {
  it('passes a normal snippet through, trimmed', () => {
    expect(normalizeSearchHits([{ url: 'https://e.com/p', snippet: '  a summary  ' }])[0].snippet).toBe('a summary')
  })

  it('nulls an absent or blank snippet rather than emitting an empty string', () => {
    expect(normalizeSearchHits([{ url: 'https://e.com/p' }])[0].snippet).toBeNull()
    expect(normalizeSearchHits([{ url: 'https://e.com/p', snippet: '   ' }])[0].snippet).toBeNull()
  })

  // Some backends return the whole extracted page in this field, otari's
  // `/v1/search` among them, so ten results could otherwise dump hundreds of KB
  // into the model's context in a single tool call.
  it('caps a snippet that is really a whole page', () => {
    const [result] = normalizeSearchHits([{ url: 'https://e.com/p', snippet: 'A'.repeat(50_000) }])
    expect(result.snippet).toHaveLength(1_001) // 1000 chars plus the ellipsis
    expect(result.snippet?.endsWith('…')).toBe(true)
  })

  it('leaves a snippet at the cap unmarked', () => {
    expect(normalizeSearchHits([{ url: 'https://e.com/p', snippet: 'A'.repeat(1_000) }])[0].snippet).toBe(
      'A'.repeat(1_000),
    )
  })
})
