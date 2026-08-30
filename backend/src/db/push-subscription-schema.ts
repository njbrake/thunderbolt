/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Web Push subscriptions, one row per browser that has granted permission.
 *
 * Keyed on the endpoint because that is what the push service issues and what
 * uniquely identifies a subscription: the same account on a phone and a laptop
 * has two, and re-granting permission in the same browser can mint a new one.
 *
 * Not synced. A subscription is a property of one browser, so replicating it to
 * a user's other devices would only invite them to send to endpoints they cannot
 * own.
 */

import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    /** Push service URL. Issued by the browser's push service, globally unique. */
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Client public key for payload encryption. */
    p256dh: text('p256dh').notNull(),
    /** Client auth secret for payload encryption. */
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_push_subscriptions_user_id').on(table.userId)],
)
