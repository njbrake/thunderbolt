/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Decides whether a turn can be handed to the server instead of run in this tab.
 *
 * A server-run turn survives the tab closing, which is the whole point, but the
 * server is a different machine with a different reach. Every condition below
 * exists because something the browser can do, it cannot:
 *
 *  - it has no credential for a model the user configured with their own key;
 *  - it cannot see an MCP server running on the user's machine;
 *  - it has no OPFS workspace, so the coding tools have nothing to act on.
 *
 * Ineligible turns run in the tab exactly as before. Detachment is an upgrade on
 * the cases that qualify, never a precondition for chatting.
 */

import type { Agent } from '@/types/acp'
import type { Model } from '@/types'
import { isBuiltInAgent } from '@/defaults/agents'

export type ServerTurnInputs = {
  /** Whether the deployment will run turns at all (`GET /config`). */
  readonly serverTurnsEnabled: boolean | undefined
  readonly agent: Agent | null | undefined
  readonly model: Pick<Model, 'provider'> | null | undefined
  /** MCP servers this thread has connected. Any at all disqualifies the turn:
   *  the browser holds those connections, and several are loopback-only. */
  readonly connectedMcpCount: number
}

/**
 * Whether this turn should be handed to the server.
 *
 * @returns `true` only when every condition holds; the caller falls back to the
 *          in-tab path otherwise.
 */
export const canRunTurnOnServer = ({
  serverTurnsEnabled,
  agent,
  model,
  connectedMcpCount,
}: ServerTurnInputs): boolean => {
  if (!serverTurnsEnabled || !agent || !model) {
    return false
  }
  // An ACP agent is reached over a transport this browser owns; the server has
  // no route to it.
  if (!isBuiltInAgent(agent)) {
    return false
  }
  // `thunderbolt` means "served by this deployment", which is exactly the case
  // where the credential lives on the server. Every other provider is the user's
  // own key, held in this browser.
  if (model.provider !== 'thunderbolt') {
    return false
  }
  return connectedMcpCount === 0
}
