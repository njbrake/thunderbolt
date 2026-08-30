/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Server-side counterpart to the browser's `buildAppHarness`.
 *
 * The difference that matters is the tool list: this passes **none**. The browser
 * harness binds four coding tools to an OPFS workspace the user's own tab owns;
 * the equivalent here would be file and shell access on the deployment's server,
 * driven by model output, shared by every account on it. That is a materially
 * different risk posture and is not something a chat turn needs, so the server
 * runs chat-only.
 *
 * Pi still requires an execution environment even with no tools bound to it.
 * `NodeExecutionEnv` is Pi's own, pointed at a per-turn scratch directory so
 * nothing it touches by default lands anywhere meaningful.
 */

import { buildHarness, type PiModelDescriptor } from '@shared/agent-core/build-harness'
import type { SeedTurn } from '@shared/agent-core/seed-history'
import type { AgentHarness, AgentHarnessOptions, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type BuildServerHarnessOptions = {
  readonly model: PiModelDescriptor
  readonly systemPrompt: AgentHarnessOptions['systemPrompt']
  readonly thinkingLevel: ThinkingLevel
  readonly history?: readonly SeedTurn[]
}

/** Per-turn scratch directory. Fresh each time so two turns never share state. */
const createScratchDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'thunderbolt-turn-'))

/**
 * Build a chat-only harness for one server-side turn.
 *
 * @param options - model descriptor, prompt, thinking level, prior turns
 * @returns the constructed harness, seeded with history and holding no tools
 */
export const buildServerHarness = async (options: BuildServerHarnessOptions): Promise<AgentHarness> => {
  const cwd = await createScratchDir()
  return buildHarness({
    model: options.model,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    env: new NodeExecutionEnv({ cwd }),
    tools: [],
    history: options.history,
  })
}
