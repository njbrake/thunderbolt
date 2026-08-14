/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readCappedBody } from '@/utils/capped-body'
import { createSafeFetch, ensureHttps, validateSafeUrl, type DnsLookup } from '@/utils/url-validation'
import { Readability } from '@mozilla/readability'
import { deriveFaviconUrl } from '@shared/url'
import { parseHTML } from 'linkedom'
import { WebFetchUnavailableError, type WebFetchOptions, type WebFetchProvider, type WebPageContent } from './types'

/**
 * Page fetch with no contents vendor: fetch the URL from the backend and extract
 * the article with Readability.
 *
 * This exists so a deployment can serve `fetch_content` without holding a
 * commercial credential, and because a search provider need not offer page fetch at
 * all: pointing search at a gateway or a SearXNG instance would otherwise leave the
 * tool permanently unavailable. Tracked on the gateway side in
 * mozilla-ai/otari#577, which would give Otari a fetch endpoint of its own; this
 * adapter is useful regardless, since it depends on nothing but the network.
 *
 * Opt-in by name (`WEB_FETCH_PROVIDER=readability`) and never inferred. It needs no
 * credential, so inferring it would silently turn an unconfigured deployment into
 * one that makes outbound requests to model-supplied URLs, which is a decision an
 * operator should make rather than inherit on upgrade.
 *
 * ## Fetching model-supplied URLs safely
 *
 * The URL comes from a tool call, so it is attacker-influenceable in the sense that
 * matters: a prompt can steer the model at `http://169.254.169.254/`. None of that
 * defence is new code. `createSafeFetch` resolves DNS, rejects every resolved
 * address in a private, loopback, or link-local range, connects to the pinned IP
 * with the original Host header (so a name that re-resolves between check and
 * connect cannot be used to slip past the check), and revalidates every redirect
 * hop under a hop cap. `validateSafeUrl` rejects non-HTTP schemes and literal
 * internal hosts up front. This adapter adds the three limits specific to reading a
 * body: a byte cap enforced while streaming rather than from a header, a timeout,
 * and a content-type check.
 */

/** HTML budget. Generous next to `/v1/preview`'s 2MB because that route only needs
 *  the `<head>`, while this one needs the article body. */
const maxHtmlBytes = 4 * 1024 * 1024
const defaultFetchTimeoutMs = 10_000

/** Matches the User-Agent `/v1/preview` sends: the same pages are being fetched, and
 *  a server-shaped agent gets a consent wall or a 403 from many of them. */
const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const readabilityProviderId = 'readability'

export type ReadabilityProviderOptions = {
  /** Injected by tests, and by the app when it threads its own fetch. */
  fetchFn?: typeof fetch
  dnsLookup?: DnsLookup
  /** Milliseconds before a hanging upstream is abandoned. A parameter so the guard
   *  is testable in milliseconds rather than in ten seconds. */
  timeoutMs?: number
}

const isHtmlContentType = (contentType: string | null): boolean => {
  if (!contentType) {
    // No header at all. Attempt the parse rather than refuse: plenty of small sites
    // omit it, and a non-HTML body simply yields no article below.
    return true
  }
  const essence = contentType.split(';')[0].trim().toLowerCase()
  return essence === 'text/html' || essence === 'application/xhtml+xml' || essence === ''
}

/** First non-empty attribute value among the given selectors. */
const metaContent = (document: Document, selectors: readonly string[]): string | null => {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute('content')?.trim()
    if (value) {
      return value
    }
  }
  return null
}

const resolveAgainst = (baseUrl: string, value: string | null): string | null => {
  if (!value) {
    return null
  }
  try {
    return ensureHttps(new URL(value, baseUrl).href)
  } catch {
    return null
  }
}

/** Collapse the runs of whitespace that fall out of stripping tags, so the model is
 *  not paying for indentation. */
const tidyText = (text: string): string =>
  text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const createReadabilityFetchProvider = (options: ReadabilityProviderOptions = {}): WebFetchProvider => {
  const safeFetch = createSafeFetch(options.fetchFn ?? globalThis.fetch, options.dnsLookup)
  const timeoutMs = options.timeoutMs ?? defaultFetchTimeoutMs

  return {
    id: readabilityProviderId,
    fetchContent: async (url: string, { maxCharacters }: WebFetchOptions): Promise<WebPageContent | null> => {
      const validation = validateSafeUrl(url)
      if (!validation.valid) {
        throw new WebFetchUnavailableError(validation.error ?? 'Invalid URL')
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      let html: string
      try {
        // `safeFetch` rejects for a refused connection, the abort above, and every
        // SSRF refusal. All of those are verdicts about this URL rather than faults
        // in the fetcher, so they carry through as the same typed failure below.
        const response = await safeFetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new WebFetchUnavailableError(`The page returned HTTP ${response.status}`)
        }
        if (!isHtmlContentType(response.headers.get('content-type'))) {
          // A PDF, an image, a download. Nothing to extract, and the port treats null
          // as "reached it, had nothing to return", which is what the model needs to
          // know.
          return null
        }
        if (!response.body) {
          return null
        }
        const buffer = await readCappedBody(response.body, maxHtmlBytes)
        if (!buffer) {
          throw new WebFetchUnavailableError(`The page is larger than ${maxHtmlBytes} bytes`)
        }
        html = new TextDecoder().decode(buffer)
      } catch (error) {
        if (error instanceof WebFetchUnavailableError) {
          throw error
        }
        const reason = controller.signal.aborted
          ? `The page did not respond within ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'The page could not be fetched'
        throw new WebFetchUnavailableError(reason)
      } finally {
        clearTimeout(timeoutId)
      }

      const { document } = parseHTML(html)
      // Readability mutates the document it is given, so read the metadata first.
      const ogImage = metaContent(document, ['meta[property="og:image"]', 'meta[name="og:image"]'])
      const metaAuthor = metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]'])
      const metaPublished = metaContent(document, [
        'meta[property="article:published_time"]',
        'meta[name="date"]',
        'meta[itemprop="datePublished"]',
      ])
      const linkIcon =
        document.querySelector('link[rel="icon"]')?.getAttribute('href') ??
        document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') ??
        null
      const documentTitle = document.querySelector('title')?.textContent?.trim() || null

      const article = new Readability(document as never).parse()
      // No article is a normal outcome for a homepage or a link dump. Fall back to the
      // page's own text so the model gets something rather than an empty result.
      const extracted = tidyText(article?.textContent ?? document.body?.textContent ?? '')

      // `>` not `>=`, unlike the Exa adapter: the truncation happens here, so the cap
      // being met exactly means nothing was dropped. Exa has to be conservative
      // because it cannot see what it discarded.
      const isTruncated = extracted.length > maxCharacters

      return {
        url,
        title: article?.title?.trim() || documentTitle,
        text: isTruncated ? extracted.slice(0, maxCharacters) : extracted,
        isTruncated,
        author: article?.byline?.trim() || metaAuthor,
        publishedDate: article?.publishedTime?.trim() || metaPublished,
        image: resolveAgainst(url, ogImage),
        favicon: resolveAgainst(url, linkIcon) ?? deriveFaviconUrl(url),
      }
    },
  }
}
