/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { messageText } from './history'
import { assistantParts } from './persist'

describe('assistantParts', () => {
  it('writes the same part shape the client stores for its own turns', () => {
    // A reader cannot tell where a message was produced and must not need to.
    expect(JSON.parse(assistantParts('hello'))).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('round-trips through the reader that parses it back', () => {
    const text = 'multi\nline "quoted" answer'
    expect(messageText({ parts: assistantParts(text), content: null })).toBe(text)
  })
})
