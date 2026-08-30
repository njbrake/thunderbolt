/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Web Push subscription management.
 *
 * Notifications tell you a turn finished while you were away. They are strictly
 * additive: the answer arrives through sync whether or not any of this works,
 * which is why every path here degrades to "no notifications" rather than to an
 * error the user has to deal with.
 *
 * iOS deserves a specific note. Safari delivers Web Push only to a PWA the user
 * has added to the Home Screen, on 16.4 and later. In a normal iOS browser tab
 * `PushManager` is absent, so {@link pushSupported} is false and the app simply
 * never offers it.
 */

import type { HttpClient } from './http'
import { useConfigStore } from '@/api/config-store'

/** Whether this browser can subscribe at all. */
export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined'

/**
 * Decode a base64url VAPID key into the `Uint8Array` `PushManager` demands.
 *
 * The key is distributed base64url (no padding, `-`/`_`), and the subscribe call
 * accepts only raw bytes, so the conversion is mandatory rather than stylistic.
 */
export const decodeVapidKey = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=')
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  // Backed by a plain ArrayBuffer on purpose: `applicationServerKey` rejects a
  // view over a SharedArrayBuffer, which is what the inferred type would allow.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Serialize a browser subscription into what the backend stores. */
export const serializeSubscription = (subscription: PushSubscription) => {
  const json = subscription.toJSON()
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  }
}

/**
 * Ask for permission and register this browser for notifications.
 *
 * Must be called from a user gesture: browsers reject a permission prompt that
 * no one asked for, and Safari is strictest about it.
 *
 * @returns whether this browser is now subscribed
 */
export const enablePushNotifications = async (httpClient: HttpClient): Promise<boolean> => {
  const vapidPublicKey = useConfigStore.getState().config.vapidPublicKey
  if (!pushSupported() || !vapidPublicKey) {
    return false
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return false
  }

  const registration = await navigator.serviceWorker.ready
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Required by every browser: a push that cannot show a notification is not
      // allowed, which suits us since ours always shows one.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(vapidPublicKey),
    }))

  await httpClient.post('push/subscriptions', { json: serializeSubscription(subscription) })
  return true
}

/** Stop notifications for this browser, on both sides. */
export const disablePushNotifications = async (httpClient: HttpClient): Promise<void> => {
  if (!pushSupported()) {
    return
  }
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    return
  }
  // Tell the server first: a browser that unsubscribed locally but stayed in the
  // table would be pushed to forever.
  await httpClient.delete('push/subscriptions', { json: { endpoint: subscription.endpoint } })
  await subscription.unsubscribe()
}
