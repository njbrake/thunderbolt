/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Web Push delivery.
 *
 * Notifications are a courtesy layered on top of the durable result, never the
 * carrier of it. The answer is already a `chat_messages` row by the time
 * anything here runs, so every failure below is swallowed: a push that does not
 * land costs the user a buzz, while an exception thrown into a completed turn
 * would cost them the turn.
 */

import type { Settings } from '@/config/settings'
import type { db } from '@/db/client'
import { pushSubscriptions } from '@/db/push-subscription-schema'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'

export type PushDatabase = Pick<typeof db, 'select' | 'delete'>

/** Whether this deployment can send push at all. */
export const pushConfigured = (settings: Settings): boolean =>
  !!settings.vapidPublicKey && !!settings.vapidPrivateKey && !!settings.vapidSubject

export type PushPayload = {
  readonly title: string
  readonly body: string
  /** Where clicking the notification should land. */
  readonly url: string
}

/**
 * HTTP statuses meaning the subscription is dead rather than the send being
 * unlucky. Browsers issue these once a user clears site data or uninstalls the
 * app, and the row will never work again.
 */
const goneStatuses = new Set([404, 410])

/**
 * Send one payload to every browser the user has registered.
 *
 * Dead subscriptions are deleted as they are discovered. Without that the table
 * accumulates endpoints that fail forever, and every future notification pays
 * for them.
 */
export const sendPushToUser = async (
  database: PushDatabase,
  settings: Settings,
  userId: string,
  payload: PushPayload,
  logger?: { info: (obj: object, msg: string) => void },
): Promise<number> => {
  if (!pushConfigured(settings)) {
    return 0
  }
  webpush.setVapidDetails(settings.vapidSubject, settings.vapidPublicKey, settings.vapidPrivateKey)

  const subscriptions = await database.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
  let delivered = 0

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
      )
      delivered++
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status !== undefined && goneStatuses.has(status)) {
        await database.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, subscription.endpoint))
        logger?.info({ event: 'push_subscription_gone', status }, 'Removed a dead push subscription')
        continue
      }
      logger?.info({ event: 'push_send_failed', status }, 'Push notification failed; the answer is still in the thread')
    }
  }
  return delivered
}
