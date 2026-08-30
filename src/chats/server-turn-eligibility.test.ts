/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { canRunTurnOnServer } from './server-turn-eligibility'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

const acpAgent = { ...builtInAgent, id: 'remote', type: 'acp' } as unknown as Agent

const eligible = {
  serverTurnsEnabled: true,
  agent: builtInAgent,
  model: { provider: 'thunderbolt' as const },
  connectedMcpCount: 0,
}

describe('canRunTurnOnServer', () => {
  test('accepts a deployment-served model on the built-in agent with no MCP', () => {
    expect(canRunTurnOnServer(eligible)).toBe(true)
  })

  test('declines when the deployment does not offer server turns', () => {
    // Covers both an un-configured gateway and an encrypted deployment; the
    // client cannot tell them apart and does not need to.
    expect(canRunTurnOnServer({ ...eligible, serverTurnsEnabled: false })).toBe(false)
    expect(canRunTurnOnServer({ ...eligible, serverTurnsEnabled: undefined })).toBe(false)
  })

  test('declines a model whose key lives in this browser', () => {
    for (const provider of ['openai', 'custom', 'openrouter', 'anthropic'] as const) {
      expect(canRunTurnOnServer({ ...eligible, model: { provider } })).toBe(false)
    }
  })

  test('declines an ACP agent, which the server has no route to', () => {
    expect(canRunTurnOnServer({ ...eligible, agent: acpAgent })).toBe(false)
  })

  test('declines when MCP servers are connected', () => {
    // The browser holds those connections and some are loopback-only, so the
    // server would silently run the turn without tools the user configured.
    expect(canRunTurnOnServer({ ...eligible, connectedMcpCount: 1 })).toBe(false)
  })

  test('declines when there is no model or agent yet', () => {
    expect(canRunTurnOnServer({ ...eligible, model: null })).toBe(false)
    expect(canRunTurnOnServer({ ...eligible, agent: null })).toBe(false)
  })
})
