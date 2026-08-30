/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import {
  compressionThresholdBytes,
  maybeCompressAttachment,
  needsTranscode,
  prepareAttachment,
  type CompressDeps,
} from './compress-attachment'

/** Build a File of a given logical size without allocating real bytes. */
const fakeFile = (name: string, type: string, size: number): File => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const overThreshold = compressionThresholdBytes + 1

const smallerBlob = (size: number, type: string): Blob => new Blob([new Uint8Array(size)], { type })

const deps = (over: Partial<CompressDeps> = {}): CompressDeps => ({
  compressImage: mock(async () => null),
  compressPdf: mock(async () => null),
  transcodeImage: mock(async () => smallerBlob(512, 'image/webp')),
  ...over,
})

describe('maybeCompressAttachment', () => {
  test('leaves a non-image at or below the threshold untouched, without invoking a compressor', async () => {
    const d = deps()
    const file = fakeFile('notes.pdf', 'application/pdf', compressionThresholdBytes)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressPdf).not.toHaveBeenCalled()
    expect(d.compressImage).not.toHaveBeenCalled()
  })

  test('inspects an image below the threshold, since its binding limit is pixels not bytes', async () => {
    // The regression this guards: a few-MB phone photo is far under the byte
    // threshold and far over the model's pixel budget, and used to go upstream
    // at full resolution.
    const d = deps({ compressImage: mock(async () => smallerBlob(2048, 'image/webp')) })
    const result = await maybeCompressAttachment(fakeFile('IMG_0042.jpg', 'image/jpeg', 3 * 1024 * 1024), d)
    expect(d.compressImage).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('IMG_0042.webp')
  })

  test('passes its byte budget down so the compressor can apply both limits', async () => {
    const d = deps()
    await maybeCompressAttachment(fakeFile('small.png', 'image/png', 1024), d)
    expect(d.compressImage).toHaveBeenCalledWith(expect.anything(), compressionThresholdBytes)
  })

  test('keeps the original when the compressor declines (already inside both budgets)', async () => {
    const d = deps({ compressImage: mock(async () => null) })
    const file = fakeFile('screenshot.png', 'image/png', 200 * 1024)
    // A lossless screenshot must not be round-tripped through a lossy encoder.
    expect(await maybeCompressAttachment(file, d)).toBe(file)
  })

  test('compresses a large image to WebP and renames the extension', async () => {
    const d = deps({ compressImage: mock(async () => smallerBlob(1024, 'image/webp')) })
    const result = await maybeCompressAttachment(fakeFile('Photo.PNG', 'image/png', overThreshold), d)
    expect(d.compressImage).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('Photo.webp')
    expect(result.size).toBe(1024)
  })

  test('compresses a large image identified only by extension (empty/odd MIME)', async () => {
    const d = deps({ compressImage: mock(async () => smallerBlob(1024, 'image/webp')) })
    const result = await maybeCompressAttachment(fakeFile('screenshot.PNG', '', overThreshold), d)
    expect(d.compressImage).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('screenshot.webp')
  })

  test('compresses a large PDF identified only by extension (empty/odd MIME)', async () => {
    const d = deps({ compressPdf: mock(async () => smallerBlob(2048, 'application/pdf')) })
    const result = await maybeCompressAttachment(fakeFile('report.pdf', '', overThreshold), d)
    expect(d.compressPdf).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('application/pdf')
  })

  test('keeps the original image when compression is not smaller', async () => {
    const d = deps({ compressImage: mock(async () => null) })
    const file = fakeFile('photo.jpg', 'image/jpeg', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
  })

  test('skips GIFs to preserve animation', async () => {
    const d = deps()
    const file = fakeFile('loop.gif', 'image/gif', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressImage).not.toHaveBeenCalled()
  })

  test('compresses a large PDF, keeping its name and mime', async () => {
    const d = deps({ compressPdf: mock(async () => smallerBlob(2048, 'application/pdf')) })
    const result = await maybeCompressAttachment(fakeFile('report.pdf', 'application/pdf', overThreshold), d)
    expect(d.compressPdf).toHaveBeenCalledTimes(1)
    expect(result.name).toBe('report.pdf')
    expect(result.type).toBe('application/pdf')
    expect(result.size).toBe(2048)
  })

  test('passes non-image/pdf types through even when large', async () => {
    const d = deps()
    const file = fakeFile('data.csv', 'text/csv', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
    expect(d.compressImage).not.toHaveBeenCalled()
    expect(d.compressPdf).not.toHaveBeenCalled()
  })

  test('falls back to the original when a compressor throws', async () => {
    const d = deps({
      compressImage: mock(async () => {
        throw new Error('decode failed')
      }),
    })
    const file = fakeFile('broken.png', 'image/png', overThreshold)
    expect(await maybeCompressAttachment(file, d)).toBe(file)
  })
})

describe('needsTranscode', () => {
  test('matches HEIC/HEIF by mime and by extension', () => {
    expect(needsTranscode(fakeFile('a.heic', 'image/heic', 10))).toBe(true)
    expect(needsTranscode(fakeFile('a.heif', 'image/heif', 10))).toBe(true)
    // iOS often hands over an empty type, so the extension has to carry it.
    expect(needsTranscode(fakeFile('IMG_0042.HEIC', '', 10))).toBe(true)
  })

  test('leaves formats models already accept alone', () => {
    expect(needsTranscode(fakeFile('a.png', 'image/png', 10))).toBe(false)
    expect(needsTranscode(fakeFile('a.jpg', 'image/jpeg', 10))).toBe(false)
    expect(needsTranscode(fakeFile('a.pdf', 'application/pdf', 10))).toBe(false)
  })
})

describe('prepareAttachment', () => {
  test('transcodes a HEIC to WebP even when it is far below the compression threshold', async () => {
    const d = deps()
    const result = await prepareAttachment(fakeFile('IMG_0042.HEIC', 'image/heic', 2048), d)
    expect(d.transcodeImage).toHaveBeenCalledTimes(1)
    // Size is not the trigger, so the compressor must stay out of it.
    expect(d.compressImage).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.file.type).toBe('image/webp')
    expect(result.file.name).toBe('IMG_0042.webp')
  })

  test('reports undecodable rather than falling back to the original bytes', async () => {
    const d = deps({
      transcodeImage: mock(async () => {
        throw new Error('no HEIC decoder')
      }),
    })
    const result = await prepareAttachment(fakeFile('IMG_0042.HEIC', 'image/heic', 2048), d)
    // Storing the original would ship a container the model rejects on every send.
    expect(result).toEqual({ ok: false, reason: 'undecodable' })
  })

  test('routes a non-transcode file through compression unchanged', async () => {
    const d = deps({ compressImage: mock(async () => smallerBlob(1024, 'image/webp')) })
    const result = await prepareAttachment(fakeFile('big.png', 'image/png', overThreshold), d)
    expect(d.transcodeImage).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.file.name).toBe('big.webp')
  })

  test('passes a small ordinary file straight through', async () => {
    const d = deps()
    const file = fakeFile('small.png', 'image/png', 10)
    const result = await prepareAttachment(file, d)
    expect(result).toEqual({ ok: true, file })
  })
})
