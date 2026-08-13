/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AuthClient } from '@/contexts'
import { consumePendingSsoSync, markSsoSignInPending, pendingSsoSyncKey } from './sync-sso-bridge'

/** Minimal auth client: the bridge only ever calls getSession(). */
const authClientReturning = (user: { isAnonymous?: boolean } | null) =>
  ({
    getSession: async () => ({ data: user ? { user } : null }),
  }) as unknown as AuthClient

const deps = (overrides: Parameters<typeof consumePendingSsoSync>[1] = {}) => ({
  needsWizard: mock(async () => false),
  enableSync: mock(async () => {}),
  syncAlreadyEnabled: mock(() => false),
  track: mock(() => {}),
  ...overrides,
})

describe('markSsoSignInPending', () => {
  afterEach(() => {
    sessionStorage.removeItem(pendingSsoSyncKey)
  })

  it('records the marker so it survives the redirect to the identity provider', () => {
    markSsoSignInPending()
    expect(sessionStorage.getItem(pendingSsoSyncKey)).not.toBeNull()
  })
})

describe('consumePendingSsoSync', () => {
  afterEach(() => {
    sessionStorage.removeItem(pendingSsoSyncKey)
  })

  it('enables sync after a completed SSO sign-in', async () => {
    markSsoSignInPending()
    const d = deps()

    await consumePendingSsoSync(authClientReturning({}), d)

    // The whole point: PowerSync only connects when this flag is set, and nothing
    // else in the SSO path sets it.
    expect(d.enableSync).toHaveBeenCalledWith(true)
    expect(d.track).toHaveBeenCalledWith('settings_sync_enabled')
  })

  it('does nothing without a marker, so an ordinary page load is untouched', async () => {
    const d = deps()

    await consumePendingSsoSync(authClientReturning({}), d)

    expect(d.enableSync).not.toHaveBeenCalled()
  })

  it('clears the marker so a reload does not re-enable sync the user just turned off', async () => {
    markSsoSignInPending()
    const d = deps()

    await consumePendingSsoSync(authClientReturning({}), d)
    expect(sessionStorage.getItem(pendingSsoSyncKey)).toBeNull()

    const second = deps()
    await consumePendingSsoSync(authClientReturning({}), second)
    expect(second.enableSync).not.toHaveBeenCalled()
  })

  it('leaves sync alone when the sign-in did not actually land', async () => {
    // The marker only proves an attempt. An abandoned or failed round trip comes
    // back with no session, and must not flip sync on.
    markSsoSignInPending()
    const d = deps()

    await consumePendingSsoSync(authClientReturning(null), d)

    expect(d.enableSync).not.toHaveBeenCalled()
  })

  it('leaves sync alone for an anonymous session', async () => {
    markSsoSignInPending()
    const d = deps()

    await consumePendingSsoSync(authClientReturning({ isAnonymous: true }), d)

    expect(d.enableSync).not.toHaveBeenCalled()
  })

  it('skips the redundant write when sync is already on', async () => {
    markSsoSignInPending()
    const d = deps({ syncAlreadyEnabled: mock(() => true) })

    await consumePendingSsoSync(authClientReturning({}), d)

    expect(d.enableSync).not.toHaveBeenCalled()
    expect(d.track).not.toHaveBeenCalled()
  })

  it('defers to the setup wizard rather than enabling sync without a passphrase', async () => {
    // Encryption needs input this bridge has no UI to collect. Leaving sync off
    // matches useSyncEnabledToggle: the user flips the toggle and gets the wizard.
    markSsoSignInPending()
    const d = deps({ needsWizard: mock(async () => true) })

    await consumePendingSsoSync(authClientReturning({}), d)

    expect(d.enableSync).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(pendingSsoSyncKey)).toBeNull()
  })
})
