/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { messageText, orderByParentChain } from './history'

const row = (id: string, parentId: string | null, over: Partial<{ parts: string; content: string }> = {}) => ({
  id,
  role: 'user',
  parts: over.parts ?? null,
  content: over.content ?? null,
  parentId,
})

describe('messageText', () => {
  it('concatenates text parts and ignores everything else', () => {
    const parts = JSON.stringify([
      { type: 'text', text: 'hello ' },
      { type: 'data-attachment', data: { filename: 'photo.jpg' } },
      { type: 'tool-call', toolName: 'search' },
      { type: 'text', text: 'world' },
    ])
    expect(messageText({ parts, content: null })).toBe('hello world')
  })

  it('falls back to the flat content column when parts is absent', () => {
    expect(messageText({ parts: null, content: '  older row  ' })).toBe('older row')
  })

  it('falls back rather than throwing on a malformed parts blob', () => {
    // A bad blob must not take down a turn that has a usable `content`.
    expect(messageText({ parts: '{not json', content: 'fallback' })).toBe('fallback')
    expect(messageText({ parts: '"a string, not an array"', content: 'fallback' })).toBe('fallback')
  })

  it('is empty when a message carries no text at all', () => {
    const parts = JSON.stringify([{ type: 'tool-call', toolName: 'search' }])
    expect(messageText({ parts, content: null })).toBe('')
  })
})

describe('orderByParentChain', () => {
  it('orders a linear thread oldest first regardless of row order', () => {
    const rows = [row('c', 'b'), row('a', null), row('b', 'a')]
    expect(orderByParentChain(rows).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('follows one branch and drops abandoned regenerations', () => {
    // `b2` is a regeneration of `b1`; the transcript must not contain both.
    const rows = [row('a', null), row('b1', 'a'), row('b2', 'a')]
    const ids = orderByParentChain(rows).map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('a')
    expect(['b1', 'b2']).toContain(ids[1]!)
  })

  it('returns empty for no rows', () => {
    expect(orderByParentChain([])).toEqual([])
  })

  it('terminates on a cycle instead of looping forever', () => {
    // Defensive: a parent cycle should never reach the database, but a hang here
    // would take out the whole turn runner rather than one request.
    const rows = [row('a', 'b'), row('b', 'a')]
    expect(orderByParentChain(rows).length).toBeLessThanOrEqual(2)
  })

  it('keeps a thread whose head is missing, rather than returning nothing', () => {
    // A soft-deleted ancestor is filtered out by the query, so the chain can
    // legitimately start mid-thread.
    const rows = [row('b', 'deleted-parent'), row('c', 'b')]
    expect(orderByParentChain(rows).map((r) => r.id)).toEqual(['b', 'c'])
  })
})
