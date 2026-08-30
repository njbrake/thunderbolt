/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { serverTurnsAvailable } from './routes'

const configured = {
  thunderboltInferenceUrl: 'https://gateway.example.com/v1',
  thunderboltInferenceApiKey: 'key',
}

describe('serverTurnsAvailable', () => {
  it('is available on a configured deployment with encryption off', () => {
    expect(serverTurnsAvailable(createTestSettings({ ...configured, e2eeEnabled: false }))).toBe(true)
  })

  it('is refused whenever end-to-end encryption is on', () => {
    // Running a turn server-side means reading the conversation in plaintext,
    // which is the one thing a zero-knowledge deployment promises never happens.
    expect(serverTurnsAvailable(createTestSettings({ ...configured, e2eeEnabled: true }))).toBe(false)
  })

  it('is refused without a gateway to run against', () => {
    expect(serverTurnsAvailable(createTestSettings({ e2eeEnabled: false }))).toBe(false)
    expect(
      serverTurnsAvailable(
        createTestSettings({ e2eeEnabled: false, thunderboltInferenceUrl: 'https://gateway.example.com/v1' }),
      ),
    ).toBe(false)
  })

  it('keeps encryption dominant over configuration', () => {
    // A fully configured gateway must not smuggle the feature past the gate.
    expect(serverTurnsAvailable(createTestSettings({ ...configured, e2eeEnabled: true }))).toBe(false)
  })
})
