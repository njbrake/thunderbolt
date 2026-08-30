/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Register and remove the browsers a user wants notified. */

import { createAuthMacro, type Auth } from '@/auth/elysia-plugin'
import type { db } from '@/db/client'
import { pushSubscriptions } from '@/db/push-subscription-schema'
import { safeErrorHandler } from '@/middleware/error-handling'
import { and, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

export type CreatePushRoutesOptions = {
  readonly auth: Auth
  readonly database: Pick<typeof db, 'insert' | 'delete'>
}

export const createPushRoutes = ({ auth, database }: CreatePushRoutesOptions) =>
  new Elysia({ prefix: '/push/subscriptions' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/',
      async (ctx) => {
        const { endpoint, p256dh, auth: authSecret } = ctx.body
        await database
          .insert(pushSubscriptions)
          .values({ endpoint, userId: ctx.user.id, p256dh, auth: authSecret })
          // Re-subscribing in the same browser reissues the same endpoint. Treat
          // it as the same subscription rather than a conflict, and let it move
          // accounts if someone else signs in on this device.
          .onConflictDoUpdate({
            target: pushSubscriptions.endpoint,
            set: { userId: ctx.user.id, p256dh, auth: authSecret },
          })
        ctx.set.status = 204
      },
      {
        auth: true,
        body: t.Object({
          endpoint: t.String({ minLength: 1 }),
          p256dh: t.String({ minLength: 1 }),
          auth: t.String({ minLength: 1 }),
        }),
      },
    )
    .delete(
      '/',
      async (ctx) => {
        // Scoped to the caller so an endpoint string cannot unsubscribe someone else.
        await database
          .delete(pushSubscriptions)
          .where(and(eq(pushSubscriptions.endpoint, ctx.body.endpoint), eq(pushSubscriptions.userId, ctx.user.id)))
        ctx.set.status = 204
      },
      { auth: true, body: t.Object({ endpoint: t.String({ minLength: 1 }) }) },
    )
