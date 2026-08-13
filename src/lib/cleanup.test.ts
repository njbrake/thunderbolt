/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { clearLocalData } from './cleanup'

/**
 * Only the sync and encryption teardowns are under test. The other steps (app-dir
 * reset, token clearing) each swallow their own errors by design, so they are left
 * to run and are irrelevant to the assertions here.
 */
const syncDeps = () => ({
  setSyncEnabled: mock(async (_enabled: boolean) => {}),
  disconnectSync: mock(async () => {}),
})

const encryptionDeps = () => ({
  fullWipe: mock(async () => {}),
  resetCodec: mock(() => {}),
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

describe('clearLocalData encryption teardown', () => {
  // The bug: both the log-out modal and the revoked-device modal pass only
  // `clearDatabase`, so the old `clearEncryptionKeys = true` default wiped the keys
  // out of IndexedDB while leaving the encrypted rows on disk. Choosing "leave data
  // on device" produced a database nothing could decrypt, which reads to the user as
  // an account that forgot everything.
  it('keeps the persisted keys when the data is retained', async () => {
    const deps = encryptionDeps()

    await clearLocalData({ clearDatabase: false, encryptionDeps: deps })

    expect(deps.fullWipe).not.toHaveBeenCalled()
    // In-memory key material still goes, so it does not outlive the identity.
    expect(deps.resetCodec).toHaveBeenCalled()
  })

  it('destroys the keys when the data is being deleted', async () => {
    const deps = encryptionDeps()

    await clearLocalData({ clearDatabase: true, encryptionDeps: deps })

    expect(deps.fullWipe).toHaveBeenCalled()
    expect(deps.resetCodec).not.toHaveBeenCalled()
  })

  // Account deletion, the database reset in settings, and the 401 handler all call
  // with no arguments and must still get a full wipe.
  it('destroys the keys by default', async () => {
    const deps = encryptionDeps()

    await clearLocalData({ encryptionDeps: deps })

    expect(deps.fullWipe).toHaveBeenCalled()
  })

  // Following `clearDatabase` is only a default. A caller that means it can still
  // ask for the keys to go while the rows stay.
  it('honours an explicit request to wipe keys while retaining data', async () => {
    const deps = encryptionDeps()

    await clearLocalData({ clearDatabase: false, clearEncryptionKeys: true, encryptionDeps: deps })

    expect(deps.fullWipe).toHaveBeenCalled()
    expect(deps.resetCodec).not.toHaveBeenCalled()
  })

  // `clearEncryptionKeys: false` scopes down to the cache reset; it is not a way to
  // leave a decrypted CK sitting in memory across an identity change.
  it('still drops cached key material when the caller declines the wipe', async () => {
    const deps = encryptionDeps()

    await clearLocalData({ clearDatabase: true, clearEncryptionKeys: false, encryptionDeps: deps })

    expect(deps.fullWipe).not.toHaveBeenCalled()
    expect(deps.resetCodec).toHaveBeenCalled()
  })
})
