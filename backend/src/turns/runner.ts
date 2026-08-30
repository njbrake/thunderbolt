/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Executes turn runs off the request that created them.
 *
 * The whole point of stage 3: nothing here holds a client connection, so the
 * phone that started a turn can lock, sleep, or lose signal without affecting
 * whether the answer gets produced. The result lands in `chat_messages` and
 * PowerSync delivers it whenever the device next connects.
 */

import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import type { turnRuns } from '@/db/turn-run-schema'
import { parseGatewayVisionModelIds } from '@/inference/gateway-models'
import { collectAssistantText } from '@shared/agent-core/pi-to-aisdk-stream'
import { buildServerHarness } from './harness'
import { loadThread } from './history'
import { persistAssistantMessage } from './persist'
import { claimQueuedRuns, claimRun, markFailed, markSucceeded } from './store'

type TurnRunRow = typeof turnRuns.$inferSelect

export type TurnRunnerDeps = {
  readonly settings: Settings
  readonly database: Pick<typeof db, 'select' | 'insert' | 'update'>
  readonly logger?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void }
}

/**
 * Run one turn to completion and record the outcome.
 *
 * Never throws. A detached run has no caller left to catch for it, so every
 * failure has to end as a `failed` row carrying a reason — a turn that merely
 * stops leaves the user staring at a thread that never answers.
 */
export const executeTurnRun = async (deps: TurnRunnerDeps, run: TurnRunRow): Promise<void> => {
  const { settings, database, logger } = deps
  if (!(await claimRun(database, run.id))) {
    // Someone else got there first, or the run is no longer queued. Standing
    // down is the correct response: the other holder will finish it.
    logger?.info({ event: 'turn_run_not_claimed', runId: run.id }, 'Turn run already claimed elsewhere')
    return
  }

  try {
    const { history } = await loadThread(database, run.userId, run.chatThreadId)
    const harness = await buildServerHarness({
      model: {
        kind: 'openai-compat',
        providerId: 'thunderbolt',
        modelId: run.modelId,
        baseURL: settings.thunderboltInferenceUrl,
        apiKey: settings.thunderboltInferenceApiKey,
        fetch: (input, init) => fetch(input as RequestInfo, init),
        reasoning: false,
        supportsImages: parseGatewayVisionModelIds(settings.thunderboltInferenceVisionModels).includes(run.modelId),
      },
      systemPrompt: '',
      thinkingLevel: 'medium',
      history,
    })

    const collector = collectAssistantText(harness)
    try {
      await harness.prompt(run.prompt)
      await harness.waitForIdle()
    } finally {
      collector.stop()
    }

    // Persist before marking succeeded. A crash between the two leaves the run
    // `running`, which boot recovery retries; the write is keyed on the run's own
    // assistant message id, so the retry overwrites rather than duplicates.
    await persistAssistantMessage(database, {
      id: run.assistantMessageId,
      userId: run.userId,
      threadId: run.chatThreadId,
      modelId: run.modelId,
      parentId: run.parentMessageId,
      text: collector.text(),
    })
    await markSucceeded(database, run.id)
    logger?.info({ event: 'turn_run_succeeded', runId: run.id, model: run.modelId }, 'Detached turn finished')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markFailed(database, run.id, message)
    logger?.error({ event: 'turn_run_failed', runId: run.id, error: message }, 'Detached turn failed')
  }
}

/**
 * Start a run in the background.
 *
 * Intentionally not awaited by callers: the request that created the run returns
 * immediately and the work continues without it. The promise is swallowed here
 * rather than at each call site so a forgotten `void` cannot turn into an
 * unhandled rejection that takes the process down mid-turn.
 */
export const startTurnRun = (deps: TurnRunnerDeps, run: TurnRunRow): void => {
  void executeTurnRun(deps, run).catch((error: unknown) => {
    deps.logger?.error(
      { event: 'turn_run_crashed', runId: run.id, error: error instanceof Error ? error.message : String(error) },
      'Detached turn crashed outside its own error handling',
    )
  })
}

/** Pick up queued runs and start them. Used at boot, after recovery requeues. */
export const drainQueuedRuns = async (deps: TurnRunnerDeps, limit = 20): Promise<number> => {
  const queued = await claimQueuedRuns(deps.database, limit)
  for (const run of queued) {
    startTurnRun(deps, run)
  }
  return queued.length
}
