/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * State transitions for durable turn runs.
 *
 * Every transition is a write, because the process that made the last one may
 * not be the process that makes the next: a deploy lands mid-turn and a new
 * container inherits whatever the old one left in the table.
 */

import type { db } from '@/db/client'
import { turnRuns, type TurnRunState } from '@/db/turn-run-schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type TurnStoreDatabase = Pick<typeof db, 'insert' | 'update' | 'select'>

/**
 * How many times a turn may be started before it is given up on.
 *
 * Bounds a crash loop. A prompt that reliably kills the process would otherwise
 * be picked up again on every boot and take the server down each time, turning
 * one bad turn into an outage.
 */
export const maxTurnAttempts = 3

export type CreateTurnRunInput = {
  readonly userId: string
  readonly chatThreadId: string
  readonly modelId: string
  readonly prompt: string
  readonly parentMessageId: string | null
}

export type TurnRunRecord = {
  readonly id: string
  readonly assistantMessageId: string
}

/**
 * Record a turn as queued.
 *
 * The assistant message id is minted here rather than at write time so a retry
 * overwrites its own answer instead of appending a second one to the thread.
 */
export const createTurnRun = async (database: TurnStoreDatabase, input: CreateTurnRunInput): Promise<TurnRunRecord> => {
  const id = uuidv7()
  const assistantMessageId = uuidv7()
  await database.insert(turnRuns).values({
    id,
    userId: input.userId,
    chatThreadId: input.chatThreadId,
    modelId: input.modelId,
    prompt: input.prompt,
    parentMessageId: input.parentMessageId,
    assistantMessageId,
    state: 'queued',
  })
  return { id, assistantMessageId }
}

/** Move a run to a terminal or in-flight state. */
const setState = async (
  database: TurnStoreDatabase,
  id: string,
  state: TurnRunState,
  error?: string,
): Promise<void> => {
  await database
    .update(turnRuns)
    .set({ state, error: error ?? null, updatedAt: new Date() })
    .where(eq(turnRuns.id, id))
}

/** Claim a queued run and count the attempt. */
export const markRunning = async (database: TurnStoreDatabase, id: string): Promise<void> => {
  await database
    .update(turnRuns)
    .set({ state: 'running', attempts: sql`${turnRuns.attempts} + 1`, updatedAt: new Date() })
    .where(eq(turnRuns.id, id))
}

export const markSucceeded = (database: TurnStoreDatabase, id: string): Promise<void> =>
  setState(database, id, 'succeeded')

export const markFailed = (database: TurnStoreDatabase, id: string, error: string): Promise<void> =>
  setState(database, id, 'failed', error)

/** A run left mid-flight by a process that died. */
export type InterruptedRun = {
  readonly id: string
  readonly attempts: number
}

/**
 * Requeue runs stranded in `running` by a process that did not survive to finish
 * them, and give up on the ones that have used their attempts.
 *
 * Called at boot. `running` is the only state a crash can strand: `queued` has
 * not started, and the terminal states are already resolved. Requeuing rather
 * than failing is the difference between a deploy costing a user their answer
 * and merely delaying it.
 *
 * @returns the ids requeued and the ids given up on
 */
export const recoverInterruptedRuns = async (
  database: TurnStoreDatabase,
): Promise<{ requeued: string[]; abandoned: string[] }> => {
  const stranded = await database
    .select({ id: turnRuns.id, attempts: turnRuns.attempts })
    .from(turnRuns)
    .where(eq(turnRuns.state, 'running'))

  const requeued: string[] = []
  const abandoned: string[] = []
  for (const run of stranded) {
    if (run.attempts < maxTurnAttempts) {
      requeued.push(run.id)
    } else {
      abandoned.push(run.id)
    }
  }

  // Both updates target explicit id lists. Selecting by state again would make
  // the second write depend on the first having already run, which is the kind
  // of ordering assumption that survives review and breaks on refactor.
  if (requeued.length > 0) {
    await database
      .update(turnRuns)
      .set({ state: 'queued', updatedAt: new Date() })
      .where(inArray(turnRuns.id, requeued))
  }
  if (abandoned.length > 0) {
    await database
      .update(turnRuns)
      .set({
        state: 'failed',
        // Surfaced to the reader, so it says what happened rather than "error".
        error: 'The server restarted while this response was being generated, too many times to retry.',
        updatedAt: new Date(),
      })
      .where(inArray(turnRuns.id, abandoned))
  }

  return { requeued, abandoned }
}

/** Queued runs awaiting execution, oldest first. */
export const claimQueuedRuns = async (database: TurnStoreDatabase, limit: number) =>
  database.select().from(turnRuns).where(eq(turnRuns.state, 'queued')).limit(limit)
