/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Longest-edge ceiling. A >10MB image is almost always a phone photo or huge
 * screenshot far larger than any model needs; 2048px keeps fine detail (small
 * text stays legible for vision models) while shedding most of the bytes.
 */
const maxDimension = 2048

/** WebP quality — high enough to be visually lossless for photos, low enough
 *  to win big on size. WebP also preserves alpha, so PNG transparency survives. */
const quality = 0.82

/** Encode a canvas to a WebP blob, preferring OffscreenCanvas and falling back
 *  to a detached `<canvas>` element for browsers without it. */
const encodeWebp = async (bitmap: ImageBitmap, width: number, height: number): Promise<Blob> => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('2D context unavailable')
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: 'image/webp', quality })
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D context unavailable')
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/webp', quality)
  })
}

/** Longest edge capped at {@link maxDimension}, preserving aspect ratio. */
const scaledSize = (bitmap: ImageBitmap): { width: number; height: number } => {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  return { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) }
}

/**
 * Decode to a bitmap and re-encode as a downscaled WebP.
 *
 * Phone photos usually store rotation as an EXIF orientation tag rather than
 * baked-in pixels, and canvas → WebP drops EXIF entirely. `from-image` bakes the
 * tag into the drawn bitmap so a portrait photo doesn't come out sideways with
 * no metadata left to fix it downstream.
 */
const toWebp = async (blob: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const { width, height } = scaledSize(bitmap)
  try {
    return await encodeWebp(bitmap, width, height)
  } finally {
    bitmap.close()
  }
}

/**
 * Normalize a raster image to WebP when it exceeds either budget, else `null` so
 * the caller keeps the original bytes.
 *
 * Two budgets, because they are not the same question:
 *
 * - **Pixels**, always enforced ({@link maxDimension}). A phone photo is a few MB
 *   on disk and around 12 megapixels to a vision encoder, and it is the second
 *   number that decides whether a model can read it. Gating this on file size is
 *   what let full-resolution photos reach an upstream that then stalled in
 *   prefill and returned no stream at all.
 * - **Bytes**, only when `maxBytes` is supplied. That is a storage-and-transfer
 *   concern the caller owns.
 *
 * An image inside both budgets is returned untouched rather than round-tripped:
 * re-encoding is lossy, and a screenshot of text would lose exactly the detail a
 * model is usually being asked to read.
 *
 * May throw on a decode/encode failure; the caller treats that as "couldn't
 * compress" and falls back to the original.
 */
export const compressImage = async (blob: Blob, maxBytes = Number.POSITIVE_INFINITY): Promise<Blob | null> => {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const { width, height } = scaledSize(bitmap)
    const overDimension = width !== bitmap.width || height !== bitmap.height
    if (!overDimension && blob.size <= maxBytes) {
      return null
    }
    const out = await encodeWebp(bitmap, width, height)
    // A downscale is about pixel count, so keep it even in the rare case the
    // re-encode is not smaller on disk. A byte-only pass keeps the original when
    // it failed to win anything.
    return overDimension || out.size < blob.size ? out : null
  } finally {
    bitmap.close()
  }
}

/**
 * Re-encode to WebP regardless of whether it saves bytes.
 *
 * For a format the platform can decode but no model accepts (HEIC/HEIF, which
 * is what an iPhone shoots by default), the container is the point, not the
 * byte count: a HEIC that grows slightly as WebP is still the only version a
 * model can read. Throws when the browser has no decoder for the input — today
 * only Safari ships one for HEIC — which the caller reports rather than storing
 * bytes nothing downstream can use.
 */
export const transcodeImage = async (blob: Blob): Promise<Blob> => toWebp(blob)
