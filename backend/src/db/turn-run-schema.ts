/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Durable record of a server-run chat turn.
 *
 * Server-only and deliberately not in the `powersync` schema. What the client
 * needs is the answer, which arrives as a `chat_messages` row; this table is the
 * bookkeeping that gets it there, and syncing it would put scheduling state in
 * front of users for no benefit.
 *
 * It exists because a detached turn outlives its request. Without a record, a
 * turn interrupted by a deploy leaves nothing behind: no answer, no error, and
 * no way for anyone to find out it was ever running. A row that survives the
 * process is what makes "resume or fail visibly, never disappear" possible.
 */

import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

/**
 * Lifecycle of one turn.
 *
 * `running` is the only state a crash can strand, which is why boot recovery
 * looks for exactly it.
 */
export const turnRunStates = ['queued', 'running', 'succeeded', 'failed'] as const
export type TurnRunState = (typeof turnRunStates)[number]

export const turnRuns = pgTable(
  'turn_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Thread the turn belongs to. Not a foreign key: `chat_threads` lives in the
     *  `powersync` schema and is client-owned, so a cascade across that boundary
     *  would let sync deletes reach into server bookkeeping. */
    chatThreadId: text('chat_thread_id').notNull(),
    modelId: text('model_id').notNull(),
    /** The user's prompt for this turn, kept so an interrupted run can be retried
     *  without depending on the client still being there to resend it. */
    prompt: text('prompt').notNull(),
    /** Message the answer will descend from — the thread tail when the turn began. */
    parentMessageId: text('parent_message_id'),
    /** Id the answer is written under. Reserved up front so a retry overwrites
     *  its own row rather than appending a second answer to the thread. */
    assistantMessageId: text('assistant_message_id').notNull(),
    state: text('state').notNull().$type<TurnRunState>(),
    /** Why it failed, for a user-visible message rather than a silent stall. */
    error: text('error'),
    /** Incremented on each start. Bounds crash-loop retries: a turn that kills
     *  the process would otherwise take the server down on every boot. */
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_turn_runs_user_id').on(table.userId),
    // Boot recovery scans by state; without this it degrades to a full scan on a
    // table that only ever grows.
    index('idx_turn_runs_state').on(table.state),
  ],
)
