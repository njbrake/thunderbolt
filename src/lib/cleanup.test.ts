/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { clearLocalData } from './cleanup'

/**
 * Only the sync teardown is under test. The other steps (encryption wipe, app-dir
 * reset, token clearing) each swallow their own errors by design, so they are left
 * to run and are irrelevant to the assertions here.
 */
const syncDeps = () => ({
  setSyncEnabled: mock(async (_enabled: boolean) => {}),
  disconnectSync: mock(async () => {}),
})

describe('clearLocalData sync teardown', () => {
  // "Keep my data" must not forget that the user wanted sync. `setSyncEnabled`
  // persists to localStorage, and the SSO sign-in path never re-enables it, so
  // doing that here turned sync off permanently: the next sign-in reconnected
  // nothing and the account looked empty despite the data still being on disk.
  it('closes the connection but keeps the preference when data is retained', async () => {
    const deps = syncDeps()

    await clearLocalData({ clearDatabase: false, clearEncryptionKeys: false, syncDeps: deps })

    expect(deps.disconnectSync).toHaveBeenCalled()
    expect(deps.setSyncEnabled).not.toHaveBeenCalled()
  })

  // Deleting the data is a full identity teardown, so the preference goes too.
  it('forgets the preference when the database is being deleted', async () => {
    const deps = syncDeps()

    await clearLocalData({ clearDatabase: true, clearEncryptionKeys: false, syncDeps: deps })

    expect(deps.setSyncEnabled).toHaveBeenCalledWith(false)
    expect(deps.disconnectSync).not.toHaveBeenCalled()
  })

  // Full wipe is the default shape used by account deletion and the 401 handler.
  it('forgets the preference by default', async () => {
    const deps = syncDeps()

    await clearLocalData({ clearEncryptionKeys: false, syncDeps: deps })

    expect(deps.setSyncEnabled).toHaveBeenCalledWith(false)
  })

  it('touches neither when the caller opts out of the sync teardown', async () => {
    const deps = syncDeps()

    await clearLocalData({ disableSync: false, clearEncryptionKeys: false, clearDatabase: false, syncDeps: deps })

    expect(deps.setSyncEnabled).not.toHaveBeenCalled()
    expect(deps.disconnectSync).not.toHaveBeenCalled()
  })
})
