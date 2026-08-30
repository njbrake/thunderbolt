/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Push handlers for the generated service worker.
 *
 * Plain JS in `public/` rather than a module in `src/`, because the app's
 * service worker is produced by Workbox in `generateSW` mode: its contents are
 * generated, and the sanctioned way to add behaviour is `importScripts`. That
 * keeps the precache manifest generated (the alternative, `injectManifest`,
 * would hand us the whole worker to maintain by hand for the sake of these two
 * listeners).
 *
 * Delivery is best-effort by design. The answer is already in the thread before
 * any of this runs, so a dropped notification costs a nudge, not a result.
 */

self.addEventListener('push', (event) => {
  if (!event.data) {
    return
  }

  let payload
  try {
    payload = event.data.json()
  } catch {
    // A push with an unreadable body still means something finished; a generic
    // notification beats silence.
    payload = {}
  }

  const title = payload.title || 'Thunderbolt'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/pwa-icon-192.png',
      badge: '/pwa-icon-192.png',
      // Collapses repeats: a second answer replaces the first rather than
      // stacking, which matters on a lock screen.
      tag: 'thunderbolt-turn',
      data: { url: payload.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer focusing a window that is already open. Opening a second one
      // would leave the user with two copies of an app that syncs between them.
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
