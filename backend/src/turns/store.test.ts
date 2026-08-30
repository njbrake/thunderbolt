/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Recovery is the behaviour a deploy exercises, so it is tested against a fake
 * that records the writes rather than a live database: what matters is which
 * rows get requeued versus given up on, and that the two never overlap.
 */

import { describe, expect, it, mock } from 'bun:test'
import { claimRun, maxTurnAttempts, recoverInterruptedRuns, type TurnStoreDatabase } from './store'

type Stranded = { id: string; attempts: number }

/**
 * Minimal stand-in: `select` yields the stranded rows and `update` records the
 * values written. The `where` clause is ignored deliberately — it is a cyclic
 * Drizzle object, and which rows each update targets is already asserted through
 * the returned id lists.
 */
const fakeDatabase = (stranded: Stranded[]) => {
  const updates: Record<string, unknown>[] = []
  const database = {
    select: () => ({ from: () => ({ where: async () => stranded }) }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push(set)
        },
      }),
    }),
    insert: mock(),
  } as unknown as TurnStoreDatabase
  return { database, updates }
}

describe('recoverInterruptedRuns', () => {
  it('requeues a run that still has attempts left', async () => {
    const { database } = fakeDatabase([{ id: 'a', attempts: 1 }])
    const { requeued, abandoned } = await recoverInterruptedRuns(database)
    expect(requeued).toEqual(['a'])
    expect(abandoned).toEqual([])
  })

  it('gives up on a run that has used its attempts', async () => {
    // Bounds the crash loop: a prompt that kills the process must not take the
    // server down on every boot forever.
    const { database } = fakeDatabase([{ id: 'a', attempts: maxTurnAttempts }])
    const { requeued, abandoned } = await recoverInterruptedRuns(database)
    expect(requeued).toEqual([])
    expect(abandoned).toEqual(['a'])
  })

  it('splits a mixed batch without a run landing in both', async () => {
    const { database } = fakeDatabase([
      { id: 'fresh', attempts: 0 },
      { id: 'spent', attempts: maxTurnAttempts },
      { id: 'nearly', attempts: maxTurnAttempts - 1 },
    ])
    const { requeued, abandoned } = await recoverInterruptedRuns(database)
    expect(requeued.sort()).toEqual(['fresh', 'nearly'])
    expect(abandoned).toEqual(['spent'])
    expect(requeued.filter((id) => abandoned.includes(id))).toEqual([])
  })

  it('writes nothing when nothing was stranded', async () => {
    const { database, updates } = fakeDatabase([])
    const { requeued, abandoned } = await recoverInterruptedRuns(database)
    expect(requeued).toEqual([])
    expect(abandoned).toEqual([])
    expect(updates).toEqual([])
  })

  it('gives an abandoned run a reason a person can read', async () => {
    const { database, updates } = fakeDatabase([{ id: 'a', attempts: maxTurnAttempts }])
    await recoverInterruptedRuns(database)
    const failed = updates.find((u) => u.state === 'failed')
    expect(failed).toBeDefined()
    expect(String(failed!.error)).toContain('server restarted')
  })
})

describe('claimRun', () => {
  /** `update` yields whatever the caller says the CAS matched. */
  const claimDatabase = (matched: { id: string }[]) =>
    ({
      update: () => ({ set: () => ({ where: () => ({ returning: async () => matched }) }) }),
    }) as unknown as TurnStoreDatabase

  it('claims a run when the compare-and-set matches', async () => {
    expect(await claimRun(claimDatabase([{ id: 'a' }]), 'a')).toBe(true)
  })

  it('stands down when another process already claimed it', async () => {
    // Two processes draining the queue at once must not both spend the tokens.
    expect(await claimRun(claimDatabase([]), 'a')).toBe(false)
  })
})
