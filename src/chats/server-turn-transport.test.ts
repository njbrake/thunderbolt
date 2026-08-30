/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { runTurnOnServer, splitTurn } from './server-turn-transport'
import type { HttpClient } from '@/lib/http'
import type { ThunderboltUIMessage } from '@/types'

const message = (role: 'user' | 'assistant', text: string): ThunderboltUIMessage =>
  ({ id: `${role}-${text}`, role, parts: [{ type: 'text', text }] }) as unknown as ThunderboltUIMessage

describe('splitTurn', () => {
  test('takes the trailing user message as the prompt and the rest as history', () => {
    const { prompt, history } = splitTurn([
      message('user', 'first'),
      message('assistant', 'reply'),
      message('user', 'second'),
    ])
    expect(prompt).toBe('second')
    expect(history).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
    ])
  })

  test('excludes the prompt from its own history', () => {
    // Sending it twice would make the model see the question repeated.
    const { history } = splitTurn([message('user', 'only')])
    expect(history).toEqual([])
  })

  test('drops content-less turns rather than seeding blank ones', () => {
    const empty = { id: 'e', role: 'assistant', parts: [{ type: 'tool-call' }] } as unknown as ThunderboltUIMessage
    const { history } = splitTurn([message('user', 'a'), empty, message('user', 'b')])
    expect(history).toEqual([{ role: 'user', text: 'a' }])
  })

  test('yields an empty prompt when nothing was asked', () => {
    expect(splitTurn([message('assistant', 'unprompted')]).prompt).toBe('')
  })
})

describe('runTurnOnServer', () => {
  const client = (response: Partial<Response>) =>
    ({ post: mock(async () => response as Response) }) as unknown as HttpClient

  test('returns the stream when the server takes the turn', async () => {
    const httpClient = client({ ok: true, body: new ReadableStream() })
    const result = await runTurnOnServer(httpClient, { threadId: 't', modelId: 'm', messages: [message('user', 'hi')] })
    expect(result).not.toBeNull()
  })

  test('declines rather than throwing when the server will not run it', async () => {
    // `HttpClient` throws on any non-2xx, so a 501 arrives as an exception, not
    // as a response to inspect. Letting it escape would fail the user's send
    // over a turn this tab can run perfectly well.
    const httpClient = {
      post: mock(async () => {
        throw new Error('HttpError: 501')
      }),
    } as unknown as HttpClient
    const result = await runTurnOnServer(httpClient, { threadId: 't', modelId: 'm', messages: [message('user', 'hi')] })
    expect(result).toBeNull()
  })

  test('declines when the network fails outright', async () => {
    const httpClient = {
      post: mock(async () => {
        throw new TypeError('Failed to fetch')
      }),
    } as unknown as HttpClient
    const result = await runTurnOnServer(httpClient, { threadId: 't', modelId: 'm', messages: [message('user', 'hi')] })
    expect(result).toBeNull()
  })

  test('declines a response with no body to stream', async () => {
    const httpClient = client({ ok: true, body: null })
    expect(
      await runTurnOnServer(httpClient, { threadId: 't', modelId: 'm', messages: [message('user', 'hi')] }),
    ).toBeNull()
  })

  test('does not call the server when there is no prompt', async () => {
    const httpClient = client({ ok: true, body: new ReadableStream() })
    const result = await runTurnOnServer(httpClient, {
      threadId: 't',
      modelId: 'm',
      messages: [message('assistant', 'unprompted')],
    })
    expect(result).toBeNull()
    expect(httpClient.post).not.toHaveBeenCalled()
  })
})
