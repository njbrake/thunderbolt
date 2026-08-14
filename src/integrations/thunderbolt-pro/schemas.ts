/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Schema for web search requests
 */
export const searchSchema = z
  .object({
    query: z.string().describe('The search query string'),
    max_results: z.number().describe('Maximum number of results to return'),
  })
  .strict()

/**
 * Schema for fetching webpage content
 */
export const fetchContentSchema = z
  .object({
    url: z.string().describe('Webpage URL to fetch content from'),
    max_length: z
      .number()
      .optional()
      .describe(
        'Maximum content length in characters (default: 16000, max: 64000). Increase if content was truncated.',
      ),
  })
  .strict()

/**
 * Schema for link preview metadata requests
 */
export const linkPreviewSchema = z
  .object({
    url: z.string().describe('URL to fetch preview metadata from'),
  })
  .strict()

export type SearchParams = z.infer<typeof searchSchema>
export type FetchContentParams = z.infer<typeof fetchContentSchema>
export type LinkPreviewParams = z.infer<typeof linkPreviewSchema>

/**
 * Data type for search results returned by the universal search API. Shape
 * matches `GET /v1/search` — only the four fields that the app actually
 * renders, all HTTPS-only.
 */
export type SearchResultData = {
  title: string
  pageUrl: string
  faviconUrl: string | null
  previewImageUrl: string | null
  /** Optional source index assigned client-side when results are merged into a chat. */
  sourceIndex?: number
}

/**
 * Data type for fetched webpage content. Mirrors the backend's `WebPageContent`,
 * which `POST /v1/pro/fetch-content` returns.
 * - text: May be truncated to ~16K chars to prevent context overflow
 * - isTruncated: True if text was truncated
 *
 * This is a hand-written mirror of a contract declared in another package, so the
 * two can drift without a compiler noticing, and they had: this named the field
 * `published_date` while the route has always emitted `publishedDate`, so the
 * date silently never arrived. Change one side and change the other.
 */
export type FetchContentData = {
  url: string
  title: string | null
  text: string
  isTruncated?: boolean
  favicon: string | null
  image: string | null
  author: string | null
  publishedDate: string | null
  /** Optional source index assigned client-side when results are merged into a chat. */
  sourceIndex?: number
} | null

/**
 * Data type for link preview metadata returned by GET /v1/preview.
 * Field names match the universal API exactly so the widget can consume them
 * without a translation layer.
 */
export type LinkPreviewData = {
  previewImageUrl: string | null
  summary: string | null
  title: string | null
  siteName: string | null
}
