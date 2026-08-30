/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Attachment compression orchestrator (THU-671). When a user attaches a file
 * larger than {@link compressionThresholdBytes}, we attempt to shrink it before
 * storing/sending — but only where it's actually possible and beneficial for
 * the type. Everything falls back to the original bytes untouched.
 *
 * Scope:
 * - Raster images (png/jpeg/webp) → downscale + re-encode to WebP.
 * - HEIC/HEIF → always re-encoded to WebP regardless of size (see
 *   {@link prepareAttachment}); no model accepts the container.
 * - GIF → skipped: canvas re-encoding would flatten animation to one frame.
 * - PDF → best-effort lossless re-save.
 * - Everything else (docx, text, csv, json) → passthrough: generic byte
 *   compression is useless here because the model has to read the bytes.
 */

/** Only try to compress files larger than this. */
export const compressionThresholdBytes = 10 * 1024 * 1024

/** Raster image types worth re-encoding. GIF is intentionally excluded so we
 *  don't flatten animated frames. */
const compressibleImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Extension fallbacks for when the browser reports an empty/odd MIME type (a
 *  pasted screenshot, a drag from some sources) — the same reason the
 *  acceptance check keys on extension too. Kept in lock-step with the MIME sets
 *  above: GIF is omitted so animated frames still pass through untouched. */
const compressibleImageExtensions = ['.png', '.jpg', '.jpeg', '.webp']
const pdfExtensions = ['.pdf']

/** Formats a browser may be able to decode but no model accepts. Unlike
 *  compression these are about the container, not the byte count, so they are
 *  converted at any size and bypass {@link compressionThresholdBytes}. iPhones
 *  shoot HEIC by default, which is how most of these arrive. */
const transcodeOnlyMimeTypes = new Set(['image/heic', 'image/heif'])
const transcodeOnlyExtensions = ['.heic', '.heif']

const hasExtension = (name: string, extensions: readonly string[]): boolean => {
  const lower = name.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext))
}

const isCompressibleImage = (file: File): boolean =>
  compressibleImageMimeTypes.has(file.type) || hasExtension(file.name, compressibleImageExtensions)

const isPdf = (file: File): boolean => file.type === 'application/pdf' || hasExtension(file.name, pdfExtensions)

/** Whether this file's container must be converted before it can be stored. */
export const needsTranscode = (file: File): boolean =>
  transcodeOnlyMimeTypes.has(file.type) || hasExtension(file.name, transcodeOnlyExtensions)

/** Injectable so the orchestrator's routing/fallback logic is unit-testable
 *  without a canvas or pdf-lib in the test environment. */
export type CompressDeps = {
  compressImage: (blob: Blob) => Promise<Blob | null>
  compressPdf: (blob: Blob) => Promise<Blob | null>
  transcodeImage: (blob: Blob) => Promise<Blob>
}

const defaultDeps: CompressDeps = {
  compressImage: async (blob) => (await import('./compress-image')).compressImage(blob),
  compressPdf: async (blob) => (await import('./compress-pdf')).compressPdf(blob),
  transcodeImage: async (blob) => (await import('./compress-image')).transcodeImage(blob),
}

/** Swap a filename's extension (e.g. `photo.PNG` → `photo.webp`). */
const withExtension = (name: string, ext: string): string => {
  const dot = name.lastIndexOf('.')
  return `${dot === -1 ? name : name.slice(0, dot)}.${ext}`
}

/**
 * Return a compressed {@link File} when compression is possible and beneficial,
 * otherwise the original file unchanged. Small files and unsupported types are
 * returned immediately without loading the heavy compressors. Any compression
 * failure is swallowed in favour of the original — best-effort by design.
 */
export const maybeCompressAttachment = async (file: File, deps: CompressDeps = defaultDeps): Promise<File> => {
  if (file.size <= compressionThresholdBytes) {
    return file
  }

  try {
    if (isCompressibleImage(file)) {
      const compressed = await deps.compressImage(file)
      return compressed ? new File([compressed], withExtension(file.name, 'webp'), { type: 'image/webp' }) : file
    }
    if (isPdf(file)) {
      const compressed = await deps.compressPdf(file)
      return compressed ? new File([compressed], file.name, { type: 'application/pdf' }) : file
    }
  } catch (error) {
    console.error(`Attachment compression failed for "${file.name}", sending original:`, error)
  }

  return file
}

/**
 * Outcome of preparing a picked file for storage. `undecodable` is a normal
 * user-facing outcome rather than an exception: a browser without a HEIC
 * decoder is an expected environment, not a bug, and the caller turns it into a
 * message beside the composer.
 */
export type PreparedAttachment = { ok: true; file: File } | { ok: false; reason: 'undecodable' }

/** Re-encode a must-convert container to WebP, keeping the original basename. */
const transcodeAttachment = async (file: File, deps: CompressDeps): Promise<PreparedAttachment> => {
  try {
    const transcoded = await deps.transcodeImage(file)
    return { ok: true, file: new File([transcoded], withExtension(file.name, 'webp'), { type: 'image/webp' }) }
  } catch (error) {
    // Storing the original would be worse than refusing it: the bytes would sit
    // in IndexedDB and every send would ship a container the model rejects.
    console.error(`Could not decode "${file.name}" — this browser has no decoder for it:`, error)
    return { ok: false, reason: 'undecodable' }
  }
}

/**
 * Prepare a picked file for storage and sending: convert containers no model
 * accepts, shrink oversized ones, pass everything else through untouched.
 *
 * The two are exclusive by design. A transcode already downscales to the same
 * ceiling {@link maybeCompressAttachment} would apply, so a converted HEIC never
 * needs a second decode/encode pass.
 */
export const prepareAttachment = async (file: File, deps: CompressDeps = defaultDeps): Promise<PreparedAttachment> =>
  needsTranscode(file) ? transcodeAttachment(file, deps) : { ok: true, file: await maybeCompressAttachment(file, deps) }
