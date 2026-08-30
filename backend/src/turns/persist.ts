/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Writes a server-produced assistant message into `powersync.chat_messages`.
 *
 * This is what makes a server-run turn outlive its HTTP response. PowerSync
 * replicates the row from Postgres to every device on its next connection, so
 * the delivery problem — "my phone was closed, give me what I missed" — is
 * already solved by the sync layer and needs no protocol of its own.
 *
 * The backend has never written user content before; the client has always been
 * the sole author of this table. Two rules keep that transition safe:
 *
 *  - **The server owns the rows it creates.** It mints the id, so no client is
 *    ever writing the same row from the other side.
 *  - **Writes are idempotent on that id.** A retried turn, or a redelivery after
 *    a crash, must not leave a second copy of the same answer in the thread.
 */

import { chatMessagesTable } from '@/db/powersync-schema'
import type { db } from '@/db/client'
import { v7 as uuidv7 } from 'uuid'

export type PersistDatabase = Pick<typeof db, 'insert'>

export type PersistAssistantMessageInput = {
  /** Stable id for this turn's message. Supply it to make a retry idempotent. */
  readonly id?: string
  readonly userId: string
  readonly threadId: string
  readonly modelId: string
  /** Message this one descends from — the tail of the thread when the turn began. */
  readonly parentId: string | null
  /** The assistant's answer. */
  readonly text: string
}

/**
 * Serialize text into the AI SDK part array the client stores and renders.
 *
 * The shape has to match what the client writes for its own turns, because the
 * reader cannot tell where a message was produced and must not need to.
 */
export const assistantParts = (text: string): string => JSON.stringify([{ type: 'text', text }])

/**
 * Insert (or re-affirm) the assistant message for a server-run turn.
 *
 * @returns the row id, whether it was newly written or already present
 */
export const persistAssistantMessage = async (
  database: PersistDatabase,
  input: PersistAssistantMessageInput,
): Promise<string> => {
  const id = input.id ?? uuidv7()
  await database
    .insert(chatMessagesTable)
    .values({
      id,
      role: 'assistant',
      content: input.text,
      parts: assistantParts(input.text),
      chatThreadId: input.threadId,
      modelId: input.modelId,
      parentId: input.parentId,
      userId: input.userId,
    })
    // A replay must not fork the thread. Re-running the same turn id overwrites
    // the answer rather than appending a sibling, which is what a client
    // regenerating in place would also do.
    .onConflictDoUpdate({
      target: chatMessagesTable.id,
      set: { content: input.text, parts: assistantParts(input.text) },
    })
  return id
}
