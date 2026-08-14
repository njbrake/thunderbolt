/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WebPageContent } from '@/web/types'

// `WebPageContent` lives with the provider contract that has to satisfy it.
// Re-exported here so existing importers keep working.
export type { WebPageContent } from '@/web/types'

export type FetchContentResponse = {
  data: WebPageContent | null
  success: boolean
  error?: string | null
}
