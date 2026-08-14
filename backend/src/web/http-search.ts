/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WebSearchHit, WebSearchOptions, WebSearchProvider } from './types'

/**
 * Search adapters for the two request shapes that already cover the field, named
 * for the wire format rather than for any vendor.
 *
 * Naming them after formats is deliberate. Each reaches several backends, and a
 * deployment picks a shape and a URL instead of waiting for its vendor to be added
 * here:
 *
 * - `perplexity-compatible` is Perplexity's Search API shape, which LiteLLM's proxy
 *   reimplements and mozilla-ai/otari serves at `/v1/search`.
 * - `searxng` is the shape self-hosted SearXNG exposes, which is also the contract
 *   otari's own web-search backends speak, including its Brave and Tavily fronting
 *   adapters. So commercial APIs are reachable through it without a per-vendor
 *   adapter here.
 */

export const perplexityCompatibleProviderId = 'perplexity-compatible'
export const searxngProviderId = 'searxng'

export type HttpSearchConfig = {
  /** Base URL. A trailing slash is tolerated; the adapter appends its own path. */
  baseUrl: string
  apiKey?: string
  /**
   * Names a specific search tool on backends that host several. Sent as a path
   * segment (`/search/<name>`) rather than a body field, because a backend that
   * does not host tools would reject the unknown field, while the plain
   * `/search` path stays valid for everyone.
   */
  toolName?: string
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number
  /** Injected by tests. `mock.module('node:fetch')`-style patching leaks across
   *  files, so the seam is a parameter, as it is for the inference clients. */
  fetchFn?: typeof fetch
}

const defaultTimeoutMs = 10_000

/** Non-2xx and transport failures both surface as this, so the route can say which
 *  upstream failed without leaking a body it has not validated. */
export class WebSearchBackendError extends Error {
  constructor(providerId: string, detail: string) {
    super(`Search backend (${providerId}) failed: ${detail}`)
    this.name = 'WebSearchBackendError'
  }
}

const requestJson = async (
  providerId: string,
  url: string,
  init: RequestInit,
  { timeoutMs = defaultTimeoutMs, fetchFn = fetch }: Pick<HttpSearchConfig, 'timeoutMs' | 'fetchFn'>,
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    // A DNS failure, a refused connection, or the timeout above. The operator needs
    // to know which of their backends is unreachable, so name it.
    throw new WebSearchBackendError(providerId, error instanceof Error ? error.message : 'unreachable')
  }
  if (!response.ok) {
    throw new WebSearchBackendError(providerId, `HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new WebSearchBackendError(providerId, 'response was not JSON')
  }
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const asRecordArray = (value: unknown, key: string): Record<string, unknown>[] => {
  const results = (value as Record<string, unknown> | null)?.[key]
  return Array.isArray(results) ? results.filter((entry): entry is Record<string, unknown> => !!entry) : []
}

/** A field that should be a non-empty string, or null. Backends vary on which of
 *  these they send and on whether they send `null` or omit them. */
const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

const asUrl = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/**
 * `POST {base}/search` with `{query, max_results}`, returning
 * `{results: [{title, url, snippet, date}]}`.
 */
export const createPerplexityCompatibleSearchProvider = (config: HttpSearchConfig): WebSearchProvider => ({
  id: perplexityCompatibleProviderId,
  search: async (query: string, { limit }: WebSearchOptions): Promise<WebSearchHit[]> => {
    const base = trimTrailingSlash(config.baseUrl)
    const endpoint = config.toolName ? `${base}/search/${encodeURIComponent(config.toolName)}` : `${base}/search`
    const body = await requestJson(
      perplexityCompatibleProviderId,
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: limit }),
      },
      config,
    )

    return asRecordArray(body, 'results').flatMap((result) => {
      const resultUrl = asUrl(result.url)
      return resultUrl ? [{ url: resultUrl, title: asText(result.title), snippet: asText(result.snippet) }] : []
    })
  },
})

/**
 * `GET {base}/search?q=&format=json`, returning `{results: [{url, title, content}]}`.
 *
 * SearXNG puts the result text in `content`, and some adapters fronting a
 * commercial API add `extracted_content` for a fuller extraction, so prefer that
 * when present.
 */
export const createSearxngSearchProvider = (config: HttpSearchConfig): WebSearchProvider => ({
  id: searxngProviderId,
  search: async (query: string, { limit }: WebSearchOptions): Promise<WebSearchHit[]> => {
    const endpoint = new URL(`${trimTrailingSlash(config.baseUrl)}/search`)
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('format', 'json')
    const body = await requestJson(
      searxngProviderId,
      endpoint.toString(),
      { method: 'GET', headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} },
      config,
    )

    // SearXNG has no result-count parameter, so the cap is applied on the way out.
    return asRecordArray(body, 'results')
      .flatMap((result) => {
        const resultUrl = asUrl(result.url)
        if (!resultUrl) {
          return []
        }
        return [
          {
            url: resultUrl,
            title: asText(result.title),
            snippet: asText(result.extracted_content) ?? asText(result.content),
            previewImageUrl: asUrl(result.img_src),
          },
        ]
      })
      .slice(0, limit)
  },
})
