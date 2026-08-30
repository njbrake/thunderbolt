/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `POST /v1/turns` — run one chat turn on the server.
 *
 * Stage 1 of detached turns: the client stays connected and consumes the stream
 * exactly as it consumes its own in-browser harness, because the translation is
 * the same shared `piHarnessToUiMessageStream`. Nothing is durable yet; closing
 * the tab still loses the turn. What this establishes is that the loop, the
 * prompt assembly, and the wire format all work with the server driving.
 */

import { createAuthMacro, type Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import { parseGatewayVisionModelIds } from '@/inference/gateway-models'
import { safeErrorHandler } from '@/middleware/error-handling'
import { collectAssistantText, piHarnessToUiMessageStream } from '@shared/agent-core/pi-to-aisdk-stream'
import { Elysia, t } from 'elysia'
import { loadThread } from './history'
import { buildServerHarness } from './harness'
import { persistAssistantMessage } from './persist'
import { createTurnRun, markSucceeded } from './store'
import { startTurnRun } from './runner'

export type CreateTurnRoutesOptions = {
  readonly auth: Auth
  readonly settings: Settings
  readonly database: Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>
}

// Lives in its own module so `GET /config` can read it without pulling the Pi
// engine in through this file's harness import. Re-exported here because
// callers have always found it on the routes module.
export { serverTurnsAvailable } from './availability'
import { serverTurnsAvailable } from './availability'

export const createTurnRoutes = ({ auth, settings, database }: CreateTurnRoutesOptions) =>
  new Elysia({ prefix: '/turns' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/',
      async (ctx) => {
        if (!serverTurnsAvailable(settings)) {
          ctx.set.status = 501
          return {
            error: settings.e2eeEnabled
              ? 'Server-side turns are unavailable while end-to-end encryption is enabled.'
              : 'Server-side turns require an inference gateway to be configured.',
          }
        }

        const { threadId, modelId, prompt } = ctx.body
        const stored = await loadThread(database, ctx.user.id, threadId)
        // The client's view wins when it sends one: it is authoritative and
        // current, where the stored copy is whatever has synced so far.
        const history = ctx.body.history ?? stored.history
        const { tailMessageId } = stored

        // Detached: record the turn, start it, and return. The answer arrives as
        // a `chat_messages` row that PowerSync replicates whenever the device
        // next connects, so the caller is free to disappear immediately.
        if (ctx.body.detach) {
          const run = await createTurnRun(database, {
            userId: ctx.user.id,
            chatThreadId: threadId,
            modelId,
            prompt,
            parentMessageId: tailMessageId,
          })
          // The inserted row itself, so the runner can never disagree with what
          // is actually in the table.
          startTurnRun({ settings, database }, run)
          ctx.set.status = 202
          return { turnRunId: run.id, assistantMessageId: run.assistantMessageId }
        }

        const harness = await buildServerHarness({
          model: {
            kind: 'openai-compat',
            providerId: 'thunderbolt',
            modelId,
            baseURL: settings.thunderboltInferenceUrl,
            apiKey: settings.thunderboltInferenceApiKey,
            // Server-side, so no CORS proxy stands between us and the gateway.
            fetch: (input, init) => fetch(input as RequestInfo, init),
            reasoning: false,
            // Same operator declaration the client reads off `/config`, so a turn
            // does not gain or lose vision by virtue of where it runs.
            supportsImages: parseGatewayVisionModelIds(settings.thunderboltInferenceVisionModels).includes(modelId),
          },
          systemPrompt: ctx.body.systemPrompt ?? '',
          thinkingLevel: 'medium',
          history,
        })

        // A run record even for an attached turn: it reserves the assistant
        // message id, which the stream announces so the client saves to the same
        // row the server writes, and it makes the turn recoverable if the
        // process dies mid-answer.
        const run = await createTurnRun(database, {
          userId: ctx.user.id,
          chatThreadId: threadId,
          modelId,
          prompt,
          parentMessageId: tailMessageId,
        })

        // Subscribed before the run so no early delta is missed.
        const collector = collectAssistantText(harness)

        return new Response(
          piHarnessToUiMessageStream(
            harness,
            async () => {
              try {
                await harness.prompt(prompt)
                await harness.waitForIdle()
              } finally {
                collector.stop()
              }
              // Inside the run, so the stream does not report done until the
              // answer is durable. A reader that sees the end of the stream can
              // rely on the message being in the thread.
              await persistAssistantMessage(database, {
                id: run.assistantMessageId,
                userId: ctx.user.id,
                threadId,
                modelId,
                parentId: tailMessageId,
                text: collector.text(),
              })
              await markSucceeded(database, run.id)
            },
            {
              messageId: run.assistantMessageId,
              initial: { modelId },
              // A reader that goes away is the expected case, not a cancellation:
              // the phone locked. The answer's destination is `chat_messages`,
              // which PowerSync delivers on the next connection, so the run
              // continues and persists without anyone watching.
              abortOnCancel: false,
            },
          ),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
      {
        auth: true,
        body: t.Object({
          threadId: t.String({ minLength: 1 }),
          modelId: t.String({ minLength: 1 }),
          prompt: t.String({ minLength: 1 }),
          systemPrompt: t.Optional(t.String()),
          /** Prior turns as the client sees them. Preferred over reading them
           *  back from Postgres, which lags the client's own local write by a
           *  sync round-trip and would otherwise run the turn a message short. */
          history: t.Optional(
            t.Array(t.Object({ role: t.Union([t.Literal('user'), t.Literal('assistant')]), text: t.String() })),
          ),
          /** Run without holding this request open. The answer is delivered
           *  through sync rather than through the response body. */
          detach: t.Optional(t.Boolean()),
        }),
      },
    )
