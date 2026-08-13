/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { disposeAllAdapters } from '@/acp/adapter-cache'
import { clearIrohClientSecret } from '@/acp/iroh/iroh-transport'
import { disconnectSync, setSyncEnabled } from '@/db/powersync/sync-state'
import { clearAuthToken, clearDeviceId, clearUserCacheSecret } from '@/lib/auth-token'
import { resetCodecState } from '@/db/encryption'
import { resetAppDir } from '@/lib/fs'
import { clearCachedSession } from '@/lib/session-cache'
import { handleFullWipe } from '@/services/encryption'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'

type ClearLocalDataOptions = {
  /** Disable PowerSync sync connection (default: true) */
  disableSync?: boolean
  /** Delete the database and app files via resetAppDir (default: true) */
  clearDatabase?: boolean
  /**
   * Delete the persisted encryption keys from IndexedDB (default: follows
   * {@link clearDatabase}).
   *
   * Defaulting to `clearDatabase` rather than `true` is deliberate: the keys are
   * the only thing that makes retained rows readable, so destroying them while
   * keeping the data leaves the user with a database they cannot decrypt. Pass it
   * explicitly to override.
   */
  clearEncryptionKeys?: boolean
  /** Clear auth token and device ID from localStorage (default: true) */
  clearAuth?: boolean
  /** Test seams for the sync teardown. Production omits these. */
  syncDeps?: {
    setSyncEnabled?: typeof setSyncEnabled
    disconnectSync?: typeof disconnectSync
  }
  /** Test seams for the encryption teardown. Production omits these. */
  encryptionDeps?: {
    fullWipe?: typeof handleFullWipe
    resetCodec?: typeof resetCodecState
  }
}

/**
 * Clears local data in a consistent order. Each step is independent — failures
 * are logged but don't prevent subsequent steps from running.
 *
 * Does NOT reload the page or navigate — callers handle that.
 */
export const clearLocalData = async (options?: ClearLocalDataOptions): Promise<void> => {
  // `clearEncryptionKeys` is destructured after `clearDatabase` so it can default
  // to it.
  const {
    disableSync = true,
    clearDatabase = true,
    clearEncryptionKeys = clearDatabase,
    clearAuth = true,
  } = options ?? {}
  const forgetSyncPreference = options?.syncDeps?.setSyncEnabled ?? setSyncEnabled
  const closeSyncConnection = options?.syncDeps?.disconnectSync ?? disconnectSync
  const destroyKeys = options?.encryptionDeps?.fullWipe ?? handleFullWipe
  const forgetCachedKeys = options?.encryptionDeps?.resetCodec ?? resetCodecState

  // Tear down every warm ACP connection first so no agent transport survives
  // across user identities (sign-out, account deletion, device revocation all
  // funnel through here).
  try {
    await disposeAllAdapters()
  } catch (error) {
    console.error('[clearLocalData] Failed to dispose ACP adapters:', error)
  }

  if (disableSync) {
    try {
      // Whether to forget the *preference* follows whether the data is going too.
      //
      // Either way the live connection must close, since the auth token is
      // cleared below and the open stream would only 401. But `setSyncEnabled`
      // persists to localStorage, and the SSO sign-in path never re-enables it
      // (only the consumer sign-in modal and the settings toggle do). So calling
      // it unconditionally meant a "keep my data" sign-out turned sync off for
      // good: the next sign-in reconnected nothing and the account looked empty.
      if (clearDatabase) {
        await forgetSyncPreference(false)
      } else {
        await closeSyncConnection()
      }
    } catch (error) {
      console.error('[clearLocalData] Failed to disable sync:', error)
    }
  }

  try {
    if (clearEncryptionKeys) {
      await destroyKeys()
    } else {
      // The data is staying, so the keys that decrypt it have to stay too. Drop
      // the in-memory CK and the cross-tab setup flag anyway, so no live key
      // material outlives the identity that unlocked it.
      forgetCachedKeys()
    }
  } catch (error) {
    console.error('[clearLocalData] Failed to clear encryption keys:', error)
  }

  if (clearDatabase) {
    try {
      await resetAppDir()
    } catch (error) {
      console.error('[clearLocalData] Failed to reset app directory:', error)
    }

    // Reset local settings to defaults (previously these lived in the DB and were deleted with it)
    useLocalSettingsStore.setState(initialLocalSettings)
  }

  if (clearAuth) {
    clearAuthToken()
    clearDeviceId()
    clearUserCacheSecret()
    // The iroh client secret is the bridge access credential (plaintext localStorage),
    // so it must be wiped with the other local creds on every identity teardown.
    clearIrohClientSecret()
    clearCachedSession()
  }
}
