/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads a chat thread out of Postgres and reduces it to the {@link SeedTurn}
 * list a harness is seeded with.
 *
 * This is the server's counterpart to the client's `built-in-conversation.ts`,
 * and it is deliberately narrower. The client can hydrate attachments from
 * IndexedDB and rasterize PDFs; the server has neither, so a turn whose meaning
 * lives in an attachment is not one the server should be running. The eligibility
 * check that decides what may run here lives with the caller.
 */

import { chatMessagesTable } from '@/db/powersync-schema'
import type { SeedTurn } from '@shared/agent-core/seed-history'
import { and, eq, isNull } from 'drizzle-orm'
import type { db } from '@/db/client'

export type TurnHistoryDatabase = Pick<typeof db, 'select'>

/** A message row reduced to what ordering and seeding need. */
type Row = {
  id: string
  role: string | null
  parts: string | null
  content: string | null
  parentId: string | null
}

/**
 * Concatenated text of a message.
 *
 * `parts` is the authoritative AI SDK representation and `content` is the older
 * flat column; rows exist in both shapes, so fall back rather than assuming.
 * Non-text parts (tool calls, attachment references, reasoning) are dropped:
 * seeding carries conversational context, not a replayable transcript.
 */
export const messageText = (row: Pick<Row, 'parts' | 'content'>): string => {
  if (row.parts) {
    try {
      const parsed: unknown = JSON.parse(row.parts)
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (part): part is { type: 'text'; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
          )
          .map((part) => part.text)
          .join('')
          .trim()
      }
    } catch {
      // A malformed `parts` blob is not worth failing a turn over; the `content`
      // column below is the older representation of the same message.
    }
  }
  return (row.content ?? '').trim()
}

/**
 * Order rows by walking the `parent_id` chain.
 *
 * `chat_messages` carries no timestamp — the client threads messages as a linked
 * list, and a thread can hold sibling branches from regeneration. Walking back
 * from the tail follows exactly one branch, which is the one the user is looking
 * at; sorting by anything else would interleave abandoned regenerations into the
 * transcript.
 */
export const orderByParentChain = (rows: readonly Row[]): Row[] => {
  if (rows.length === 0) {
    return []
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const referenced = new Set(rows.map((row) => row.parentId).filter((id): id is string => id !== null))
  // The tail is the row nobody claims as a parent. With several (parallel
  // branches) any is a valid leaf; take the last for determinism.
  const tail = rows.filter((row) => !referenced.has(row.id)).at(-1) ?? rows.at(-1)!

  const chain: Row[] = []
  const seen = new Set<string>()
  for (let cursor: Row | undefined = tail; cursor && !seen.has(cursor.id); ) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain.reverse()
}

/**
 * Load a thread's conversation as ordered seed turns.
 *
 * Scoped to `userId` as well as the thread so a thread id from a request can
 * never read another account's messages.
 */
export const loadThreadHistory = async (
  database: TurnHistoryDatabase,
  userId: string,
  threadId: string,
): Promise<SeedTurn[]> => {
  const rows = await database
    .select({
      id: chatMessagesTable.id,
      role: chatMessagesTable.role,
      parts: chatMessagesTable.parts,
      content: chatMessagesTable.content,
      parentId: chatMessagesTable.parentId,
    })
    .from(chatMessagesTable)
    .where(
      and(
        eq(chatMessagesTable.chatThreadId, threadId),
        eq(chatMessagesTable.userId, userId),
        isNull(chatMessagesTable.deletedAt),
      ),
    )

  return orderByParentChain(rows)
    .filter((row): row is Row & { role: 'user' | 'assistant' } => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, text: messageText(row) }))
    .filter((turn) => turn.text.length > 0)
}
