/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { needsSyncSetupWizard } from '@/db/encryption'
import { isSyncEnabled, setSyncEnabled } from '@/db/powersync/sync-state'
import { trackEvent } from '@/lib/posthog'
import type { AuthClient } from '@/contexts'

/** Module-private sessionStorage key, written before the IdP redirect. */
export const pendingSsoSyncKey = 'thunderbolt_pending_sso_sync'

/**
 * Record that an SSO sign-in is in flight, so sync can be enabled once the
 * browser comes back.
 *
 * The consumer sign-in modal enables sync inline, because that flow never leaves
 * the page. SSO cannot: the browser navigates out to the identity provider and
 * returns to a freshly booted app with no memory of having signed in. This is the
 * same sessionStorage hand-off `persistForSso` uses for the anonymous id, and it
 * survives the round trip because sessionStorage is per-tab and per-origin, not
 * per-navigation.
 *
 * Best-effort: sessionStorage throws in some private-browsing modes, and failing
 * to enable sync is not a reason to block a sign-in.
 */
export const markSsoSignInPending = (): void => {
  try {
    sessionStorage.setItem(pendingSsoSyncKey, '1')
  } catch {
    // Storage unavailable; the user can still enable sync from settings.
  }
}

type ConsumeDeps = {
  /** Test seams. Production omits these and uses the real implementations. */
  needsWizard?: typeof needsSyncSetupWizard
  enableSync?: typeof setSyncEnabled
  syncAlreadyEnabled?: typeof isSyncEnabled
  track?: typeof trackEvent
}

/**
 * Enable sync after a completed SSO sign-in, matching what the consumer sign-in
 * flow does inline.
 *
 * Without this, `syncEnabled` stayed at its `false` default on every SSO-mode
 * deployment unless the user found the toggle in settings, so PowerSync never
 * connected and nothing was ever uploaded. `PowerSyncDatabase` only connects when
 * the persisted flag is set, so the flag is the whole gate.
 *
 * Idempotent: the sessionStorage key is removed as soon as it is read, so repeat
 * calls within a page session are no-ops. Mount once, with a ref guard against
 * StrictMode double-invocation.
 */
export const consumePendingSsoSync = async (authClient: AuthClient, deps: ConsumeDeps = {}): Promise<void> => {
  const {
    needsWizard = needsSyncSetupWizard,
    enableSync = setSyncEnabled,
    syncAlreadyEnabled = isSyncEnabled,
    track = trackEvent,
  } = deps

  if (sessionStorage.getItem(pendingSsoSyncKey) === null) {
    return
  }
  sessionStorage.removeItem(pendingSsoSyncKey)

  // The marker only says a sign-in was attempted. Confirm it actually landed
  // before turning sync on, so an abandoned or failed round trip changes nothing.
  const { data } = await authClient.getSession()
  if (!data?.user || data.user.isAnonymous === true) {
    return
  }

  if (syncAlreadyEnabled()) {
    return
  }

  // Encryption needs a passphrase this bridge has no UI to collect. Leaving sync
  // off is the same resolution `useSyncEnabledToggle` reaches for pre-encryption
  // users: the user sees sync is off, flips the toggle, and gets the wizard
  // through the normal flow.
  if (await needsWizard()) {
    return
  }

  await enableSync(true)
  track('settings_sync_enabled')
}
