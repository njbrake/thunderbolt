/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One fetched page, as returned by `POST /v1/pro/fetch-content`.
 *
 * Declared here rather than derived from a provider SDK. This used to be
 * `SearchResult<…> & { isTruncated }` imported from `exa-js`, which made a
 * vendor's type the wire contract: the route spread the provider's object
 * straight onto the response, so its field names and its incidental fields (id,
 * score, highlights) reached the client, and a second provider would have had to
 * imitate Exa rather than satisfy a contract of ours.
 *
 * It also hid a live bug. The client read `published_date`, Exa returns
 * `publishedDate`, and nothing typed the boundary, so the publication date never
 * once reached a source card. Every field below is one the app renders or hands
 * to the model, named the way the rest of the codebase names things, and a
 * provider adapter maps into it explicitly.
 */
export type WebPageContent = {
  url: string
  title: string | null
  /** Extracted page text, capped by the request's `max_length`. */
  text: string
  /** True when `text` hit the cap; the model is told it can ask for more. */
  isTruncated: boolean
  author: string | null
  /** The provider's guess at a publication date. Free-form, not a parsed timestamp. */
  publishedDate: string | null
  image: string | null
  favicon: string | null
}

export type FetchContentResponse = {
  data: WebPageContent | null
  success: boolean
  error?: string | null
}
