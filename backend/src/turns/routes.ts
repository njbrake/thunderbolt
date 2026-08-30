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

export type CreateTurnRoutesOptions = {
  readonly auth: Auth
  readonly settings: Settings
  readonly database: Pick<typeof db, 'select' | 'insert'>
}

/**
 * Whether this deployment may run turns server-side at all.
 *
 * Server-side execution requires reading the conversation in plaintext, which is
 * precisely what a zero-knowledge deployment promises never happens. The two
 * features are mutually exclusive on the same data, so a deployment that has
 * turned encryption on does not get this one. Refusing loudly is the point: a
 * silent client-side fallback would leave an operator believing detached turns
 * work when they never run.
 */
export const serverTurnsAvailable = (settings: Settings): boolean =>
  !settings.e2eeEnabled && !!settings.thunderboltInferenceUrl && !!settings.thunderboltInferenceApiKey

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
        const { history, tailMessageId } = await loadThread(database, ctx.user.id, threadId)

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
                userId: ctx.user.id,
                threadId,
                modelId,
                parentId: tailMessageId,
                text: collector.text(),
              })
            },
            { initial: { modelId } },
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
        }),
      },
    )
