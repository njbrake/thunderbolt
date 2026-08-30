/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Cancel semantics are the whole difference between a turn that survives a
 * locked phone and one that does not, so they are pinned here directly.
 */

import { describe, expect, it } from 'bun:test'
import { piHarnessToUiMessageStream } from './pi-to-aisdk-stream.ts'
import type { AgentHarness } from '@earendil-works/pi-agent-core'

/** Harness stub recording whether the stream tried to abort it. */
const fakeHarness = () => {
  const state = { aborted: false, promptFinished: false }
  const harness = {
    subscribe: () => () => {},
    abort: async () => {
      state.aborted = true
    },
  } as unknown as AgentHarness
  return { harness, state }
}

describe('piHarnessToUiMessageStream cancel', () => {
  it('aborts the harness by default, which is what a browser tab wants', async () => {
    const { harness, state } = fakeHarness()
    const stream = piHarnessToUiMessageStream(harness, () => new Promise(() => {}))
    await stream.cancel()
    expect(state.aborted).toBe(true)
  })

  it('leaves the run alone when the reader is not its owner', async () => {
    // A server run's product is a chat_messages row, not the response body, so a
    // disconnected reader must not destroy work that is still useful.
    const { harness, state } = fakeHarness()
    const stream = piHarnessToUiMessageStream(harness, () => new Promise(() => {}), { abortOnCancel: false })
    await stream.cancel()
    expect(state.aborted).toBe(false)
  })

  it('lets the prompt run to completion after the reader disconnects', async () => {
    const { harness, state } = fakeHarness()
    let resolvePrompt: (() => void) | undefined
    const stream = piHarnessToUiMessageStream(
      harness,
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = () => {
            state.promptFinished = true
            resolve()
          }
        }),
      { abortOnCancel: false },
    )
    await stream.cancel()
    // The run is driven by its own promise in `start`, so cancelling the reader
    // does not unwind it; this is what makes persistence still happen.
    resolvePrompt?.()
    await Promise.resolve()
    expect(state.promptFinished).toBe(true)
  })
})
