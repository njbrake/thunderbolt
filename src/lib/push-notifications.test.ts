/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { decodeVapidKey, serializeSubscription } from './push-notifications'

describe('decodeVapidKey', () => {
  test('decodes an unpadded base64url key', () => {
    // VAPID keys ship base64url and unpadded; `atob` needs standard base64 with
    // padding, so getting either wrong yields a key the push service rejects.
    expect(Array.from(decodeVapidKey('SGVsbG8'))).toEqual([72, 101, 108, 108, 111])
  })

  test('translates the base64url alphabet', () => {
    // `-` and `_` stand in for `+` and `/`; leaving them produces wrong bytes
    // rather than an error, which is the failure mode worth a test.
    const standard = Uint8Array.from(atob('++//'), (c) => c.charCodeAt(0))
    expect(Array.from(decodeVapidKey('--__'))).toEqual(Array.from(standard))
  })

  test('is backed by a plain ArrayBuffer, which PushManager requires', () => {
    expect(decodeVapidKey('SGVsbG8').buffer).toBeInstanceOf(ArrayBuffer)
  })
})

describe('serializeSubscription', () => {
  test('flattens the browser subscription into what the server stores', () => {
    const subscription = {
      endpoint: 'https://push.example.com/abc',
      toJSON: () => ({ keys: { p256dh: 'public-key', auth: 'auth-secret' } }),
    } as unknown as PushSubscription
    expect(serializeSubscription(subscription)).toEqual({
      endpoint: 'https://push.example.com/abc',
      p256dh: 'public-key',
      auth: 'auth-secret',
    })
  })

  test('degrades to empty strings rather than undefined when keys are absent', () => {
    // The server validates non-empty, so this surfaces as a rejected request
    // instead of a row that can never be delivered to.
    const subscription = {
      endpoint: 'https://push.example.com/abc',
      toJSON: () => ({}),
    } as unknown as PushSubscription
    expect(serializeSubscription(subscription)).toEqual({
      endpoint: 'https://push.example.com/abc',
      p256dh: '',
      auth: '',
    })
  })
})
