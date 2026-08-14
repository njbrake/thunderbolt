/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The two web capabilities a deployment can offer, and the contracts a provider
 * satisfies to offer them.
 *
 * They are separate ports because they are separately available. A search backend
 * need not fetch pages (a SearXNG instance does not), and a page fetcher is not a
 * search engine, so a deployment can hold one credential and not the other. The
 * `/config` endpoint reports them independently and the client offers the matching
 * tool for each.
 *
 * Providers translate a wire format. They do not decide policy: the normalization
 * in `normalize.ts` and the model-facing truncation hint in the fetch route apply
 * to every provider alike, so swapping one cannot quietly change what the client
 * renders or what the model is told.
 */

/** One search hit as a provider reports it, before normalization. */
export type WebSearchHit = {
  url: string
  title?: string | null
  /**
   * Text the provider returned for the result, if any. Length is the provider's
   * choice and some return a whole page here, so normalization caps it.
   */
  snippet?: string | null
  /** The provider's own favicon, if it supplies one. Derived from the URL when not. */
  faviconUrl?: string | null
  previewImageUrl?: string | null
}

/** One normalized search hit, as `GET /v1/search` returns it. */
export type SearchResultDto = {
  title: string
  pageUrl: string
  /**
   * Result text for the model to answer from, capped by normalization. `null` from
   * a provider that returns none, in which case the model has titles and URLs and
   * has to fetch a page to read anything.
   */
  snippet: string | null
  faviconUrl: string | null
  previewImageUrl: string | null
}

export type SearchResponseDto = {
  results: SearchResultDto[]
}

/**
 * One fetched page, as `POST /v1/pro/fetch-content` returns it.
 *
 * Declared here rather than derived from a provider SDK. This was once
 * `SearchResult<…> & { isTruncated }` imported from `exa-js`, which made a
 * vendor's type the wire contract: the route spread the provider's object straight
 * onto the response, so its field names and its incidental fields (id, score,
 * highlights) reached the client. It also hid a live bug, since the client read
 * `published_date` while Exa returns `publishedDate`, so the date never once
 * reached a source card.
 */
export type WebPageContent = {
  url: string
  title: string | null
  /** Extracted page text, capped by the request's `max_length`. */
  text: string
  /** True when `text` hit the cap; the route turns this into the model's hint. */
  isTruncated: boolean
  author: string | null
  /** The provider's guess at a publication date. Free-form, not a parsed timestamp. */
  publishedDate: string | null
  image: string | null
  favicon: string | null
}

export type WebSearchOptions = {
  /** Hits to ask for. The route clamps this before calling. */
  limit: number
}

export type WebSearchProvider = {
  /** Identifies the adapter in logs and in the `/config` payload. */
  readonly id: string
  search(query: string, options: WebSearchOptions): Promise<WebSearchHit[]>
}

export type WebFetchOptions = {
  /** Character cap for the extracted text. The route clamps this before calling. */
  maxCharacters: number
}

export type WebFetchProvider = {
  readonly id: string
  /** `null` when the provider reached the page but had nothing to return. */
  fetchContent(url: string, options: WebFetchOptions): Promise<WebPageContent | null>
}
