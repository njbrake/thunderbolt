/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read up to `maxBytes` from a body stream, returning null if the cap is exceeded.
 * Avoids buffering an entire response when Content-Length is missing or lying.
 *
 * Shared by the two routes that fetch arbitrary user-supplied pages, `/v1/preview`
 * and the page-fetch provider, so neither can drift into trusting a header.
 */
export const readCappedBody = async (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
