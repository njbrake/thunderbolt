/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Hands a turn to `POST /v1/turns` and returns its stream.
 *
 * The response body is the same UI message stream the in-browser harness
 * produces, because both come from `piHarnessToUiMessageStream`. That is what
 * lets this slot into the existing transport without touching rendering: the
 * only thing that changes is which machine ran the loop.
 *
 * The server names the assistant message on the stream's `start` chunk, so the
 * row it writes and the row this client saves in `onFinish` are the same row.
 * Two writers that agree on an id produce one message; two that do not produce
 * two, which is the failure this design exists to avoid.
 */

import type { HttpClient } from '@/lib/http'
import type { ThunderboltUIMessage } from '@/types'

/** Prior turns reduced to what the server seeds a harness with. */
type SeedTurn = { role: 'user' | 'assistant'; text: string }

export type ServerTurnRequest = {
  readonly threadId: string
  readonly modelId: string
  readonly messages: ThunderboltUIMessage[]
}

/** Concatenated text of a message's text parts. */
const messageText = (message: ThunderboltUIMessage): string =>
  message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()

/**
 * Split the transcript into the prompt (this turn) and the history behind it.
 *
 * The trailing user message is the prompt; everything before it is context.
 * Empty turns are dropped rather than sent, since a content-less message would
 * seed the transcript with a blank turn.
 */
export const splitTurn = (messages: ThunderboltUIMessage[]): { prompt: string; history: SeedTurn[] } => {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex === -1) {
    return { prompt: '', history: [] }
  }
  return {
    prompt: messageText(messages[lastUserIndex]!),
    history: messages
      .slice(0, lastUserIndex)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', text: messageText(message) }))
      .filter((turn) => turn.text.length > 0),
  }
}

/**
 * Run this turn on the server.
 *
 * @returns the streaming response, or `null` when the server declined it — the
 *          caller then answers in the tab. Declining is not an error: a
 *          deployment can stop offering server turns between the config the
 *          client cached and the request it makes.
 */
export const runTurnOnServer = async (httpClient: HttpClient, request: ServerTurnRequest): Promise<Response | null> => {
  const { prompt, history } = splitTurn(request.messages)
  if (!prompt) {
    return null
  }

  const response = await httpClient.post('turns', {
    json: { threadId: request.threadId, modelId: request.modelId, prompt, history },
  })

  // 501 is the deployment saying it will not run turns. Anything else that is
  // not a stream is equally unusable here, and the in-tab path is a working
  // answer rather than a consolation.
  if (!response.ok || !response.body) {
    return null
  }
  return response
}
