/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DnsLookup } from '@/utils/url-validation'
import { describe, expect, it, mock } from 'bun:test'
import { createReadabilityFetchProvider } from './readability'

/** Every hostname resolves to one public address unless a test says otherwise, so
 *  the SSRF layer is exercised without touching real DNS. */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }]

const articleHtml = `<!doctype html><html><head>
<title>Fallback Title</title>
<meta property="og:image" content="/cover.png">
<meta name="author" content="A. Writer">
<meta property="article:published_time" content="2026-02-03T10:00:00Z">
<link rel="icon" href="/fav.ico">
</head><body>
<nav>Home About Contact Subscribe Newsletter</nav>
<article><h1>The Real Headline</h1>
<p>First paragraph with enough substance to survive the extractor's scoring heuristics, which discard short blocks of boilerplate text as noise.</p>
<p>Second paragraph, also reasonably long, so that the article body is clearly the densest region of this document by a wide margin.</p>
</article>
<footer>Copyright notice and a pile of navigation links</footer>
</body></html>`

const respondWith = (
  body: string,
  init: { status?: number; contentType?: string | null; headers?: Record<string, string> } = {},
) => {
  const headers = new Headers(init.headers)
  if (init.contentType !== null) {
    headers.set('Content-Type', init.contentType ?? 'text/html; charset=utf-8')
  }
  const fetchFn = mock(async () => new Response(body, { status: init.status ?? 200, headers }))
  return fetchFn as unknown as typeof fetch
}

const provider = (fetchFn: typeof fetch, dnsLookup: DnsLookup = publicDns) =>
  createReadabilityFetchProvider({ fetchFn, dnsLookup })

describe('readability fetch provider', () => {
  it('extracts the article and drops the page furniture', async () => {
    const page = await provider(respondWith(articleHtml)).fetchContent('https://example.com/post', {
      maxCharacters: 16_000,
    })

    expect(page?.text).toContain('First paragraph with enough substance')
    expect(page?.text).not.toContain('Subscribe')
    expect(page?.text).not.toContain('Copyright')
    expect(page?.isTruncated).toBe(false)
  })

  it('fills the metadata the source card renders', async () => {
    const page = await provider(respondWith(articleHtml)).fetchContent('https://example.com/post', {
      maxCharacters: 16_000,
    })

    expect(page?.url).toBe('https://example.com/post')
    expect(page?.title).toBe('Fallback Title')
    expect(page?.author).toBe('A. Writer')
    expect(page?.publishedDate).toBe('2026-02-03T10:00:00Z')
    // Relative URLs are resolved against the page and upgraded to https.
    expect(page?.image).toBe('https://example.com/cover.png')
    expect(page?.favicon).toBe('https://example.com/fav.ico')
  })

  it('derives a favicon from the origin when the page declares none', async () => {
    const page = await provider(respondWith('<html><body><p>Some words here.</p></body></html>')).fetchContent(
      'https://example.com/deep/path',
      { maxCharacters: 16_000 },
    )
    expect(page?.favicon).toBe('https://example.com/favicon.ico')
  })

  it('falls back to page text when there is no article to extract', async () => {
    // A homepage or link dump. An empty result would be worse than rough text.
    const page = await provider(
      respondWith('<html><body><div>Links</div><div>More links</div></body></html>'),
    ).fetchContent('https://example.com/', { maxCharacters: 16_000 })

    expect(page?.text).toContain('Links')
  })
})

describe('readability fetch provider limits', () => {
  it('truncates at the requested cap and reports it', async () => {
    const long = `<html><body><article><p>${'A'.repeat(5_000)}</p></article></body></html>`
    const page = await provider(respondWith(long)).fetchContent('https://example.com/long', { maxCharacters: 1_000 })

    expect(page?.text).toHaveLength(1_000)
    expect(page?.isTruncated).toBe(true)
  })

  // `>` not `>=`: this adapter does the cutting, so hitting the cap exactly means
  // nothing was dropped and the model should not be told to ask for more.
  it('does not report truncation when the text lands exactly on the cap', async () => {
    const body = 'A'.repeat(1_000)
    const page = await provider(
      respondWith(`<html><body><article><p>${body}</p></article></body></html>`),
    ).fetchContent('https://example.com/exact', { maxCharacters: 1_000 })

    expect(page?.text).toHaveLength(1_000)
    expect(page?.isTruncated).toBe(false)
  })

  it('refuses a body past the byte cap instead of buffering it', async () => {
    // 5MB of HTML against a 4MB cap. The cap is enforced while streaming, so a
    // lying or absent Content-Length cannot get around it.
    const huge = `<html><body><p>${'A'.repeat(5 * 1024 * 1024)}</p></body></html>`
    await expect(
      provider(respondWith(huge)).fetchContent('https://example.com/huge', { maxCharacters: 16_000 }),
    ).rejects.toThrow('larger than')
  })

  it('returns nothing for a body that is not HTML', async () => {
    const page = await provider(respondWith('%PDF-1.7 binary bytes', { contentType: 'application/pdf' })).fetchContent(
      'https://example.com/paper.pdf',
      { maxCharacters: 16_000 },
    )

    expect(page).toBeNull()
  })

  it('attempts the parse when the upstream sends no content type at all', async () => {
    const page = await provider(respondWith(articleHtml, { contentType: null })).fetchContent(
      'https://example.com/post',
      { maxCharacters: 16_000 },
    )
    expect(page?.text).toContain('First paragraph')
  })

  it('surfaces a non-2xx upstream rather than returning an empty page', async () => {
    await expect(
      provider(respondWith('nope', { status: 404 })).fetchContent('https://example.com/gone', {
        maxCharacters: 16_000,
      }),
    ).rejects.toThrow('404')
  })
})

describe('readability fetch provider SSRF guards', () => {
  it('refuses a non-HTTP scheme before any request is made', async () => {
    const fetchFn = respondWith(articleHtml)
    await expect(provider(fetchFn).fetchContent('file:///etc/passwd', { maxCharacters: 16_000 })).rejects.toThrow(
      'HTTP',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a literal internal address', async () => {
    const fetchFn = respondWith(articleHtml)
    await expect(
      provider(fetchFn).fetchContent('http://169.254.169.254/latest/meta-data/', { maxCharacters: 16_000 }),
    ).rejects.toThrow('Internal URLs are not allowed')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a public hostname that resolves into a private range', async () => {
    // DNS rebinding: the name looks fine, the address does not. `createSafeFetch`
    // checks after resolution and pins the connection to the address it checked.
    const fetchFn = respondWith(articleHtml)
    const rebinding: DnsLookup = async () => [{ address: '10.0.0.5', family: 4 }]
    await expect(
      provider(fetchFn, rebinding).fetchContent('https://evil.example/', { maxCharacters: 16_000 }),
    ).rejects.toThrow('private/internal')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('revalidates a redirect hop rather than following it blindly', async () => {
    const calls: string[] = []
    const fetchFn = mock(async (url: string | URL | Request) => {
      calls.push(String(url))
      if (calls.length === 1) {
        return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8000/admin' } })
      }
      return new Response(articleHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })
    }) as unknown as typeof fetch

    await expect(
      provider(fetchFn).fetchContent('https://example.com/redirect', { maxCharacters: 16_000 }),
    ).rejects.toThrow('127.0.0.1 is a private/internal address')
    // The first hop was made; the loopback destination never was.
    expect(calls).toHaveLength(1)
  })
})

describe('readability fetch provider timeout', () => {
  it('abandons an upstream that never responds', async () => {
    // Black-holed host: resolves, accepts the connection, sends nothing. Without the
    // abort the tool call would hang until the model's own request gave up.
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })) as unknown as typeof fetch

    await expect(
      createReadabilityFetchProvider({ fetchFn: hanging, dnsLookup: publicDns, timeoutMs: 25 }).fetchContent(
        'https://slow.example/',
        { maxCharacters: 16_000 },
      ),
    ).rejects.toThrow('did not respond within 25ms')
  })
})

describe('readability fetch provider failure reasons', () => {
  // Every one of these is a verdict about the URL rather than a fault in the
  // fetcher, so each carries a reason the model can read and act on. The route
  // turns them into a readable envelope instead of an opaque 500.
  it('marks each expected failure as unavailable rather than a fault', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'upstream status',
        () => provider(respondWith('gone', { status: 404 })).fetchContent('https://e.com/x', { maxCharacters: 100 }),
      ],
      [
        'refused URL',
        () => provider(respondWith(articleHtml)).fetchContent('http://127.0.0.1/x', { maxCharacters: 100 }),
      ],
      [
        'oversized body',
        () =>
          provider(respondWith(`<html><body><p>${'A'.repeat(5 * 1024 * 1024)}</p></body></html>`)).fetchContent(
            'https://e.com/big',
            { maxCharacters: 100 },
          ),
      ],
    ]
    for (const [label, run] of cases) {
      let caught: unknown
      try {
        await run()
      } catch (error) {
        caught = error
      }
      expect((caught as Error).name, label).toBe('WebFetchUnavailableError')
      expect((caught as Error).message.length, label).toBeGreaterThan(0)
    }
  })
})
