/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Assembles a Pi {@link AgentHarness} for the APP — the in-browser analogue of
 * the CLI's `buildHarness`. Where the CLI binds a `NodeExecutionEnv` (real bash +
 * `node:fs`) and lets Pi's anthropic provider read `ANTHROPIC_API_KEY`, the app
 * harness runs entirely inside the browser:
 *
 *   - the model is Pi's anthropic model wired through the caller's injected
 *     `fetch` (the app's CORS proxy) via {@link buildAnthropicModel};
 *   - the execution environment is a {@link BrowserExecutionEnv} over an
 *     OPFS-backed ZenFS mount ({@link mountAgentFs}), with an in-memory fallback;
 *   - the four coding tools (bash/read/write/edit) are bound to that same mount
 *     via {@link createBrowserCodingTools} — plain Pi `AgentTool`s over the
 *     {@link BrowserExecutionEnv}, with no `@earendil-works/pi-coding-agent` (and
 *     hence no Node child-process/`undici`/TUI) cascade on the app path.
 *
 * Extra `tools` (e.g. the app's MCP tools converted via `./mcp-tools.ts`) are
 * appended and made active alongside the coding tools.
 */

import type { AgentHarness, AgentHarnessOptions, AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { buildHarness, type PiModelDescriptor } from './build-harness.ts'
import { BrowserExecutionEnv } from './browser-env/browser-execution-env.ts'
import { mountAgentFs } from './browser-env/mount.ts'
import { createBrowserCodingTools } from './coding-tools/index.ts'
import { ensureBufferPolyfill } from './ensure-buffer.ts'
import type { SeedTurn } from './seed-history.ts'

/** Mount-relative root under which every thread carves its isolated workspace. */
const workspaceRoot = '/workspace'

/**
 * Absolute mount-relative workspace directory for a thread. Each thread gets its
 * own subtree under {@link workspaceRoot} so concurrent threads never see each
 * other's files even though they share the one process-global ZenFS mount.
 *
 * @param threadId - the chat thread id (an app-generated id, e.g. a UUID)
 * @returns the thread's absolute workspace directory, e.g. `/workspace/<threadId>`
 */
export const workspaceDirFor = (threadId: string): string => {
  // The workspace dir is also the jail boundary for every coding tool, so a
  // threadId containing `/` or `..` would move the boundary and defeat the jail.
  // App thread ids are UUID-shaped; reject anything else loudly rather than
  // silently weakening isolation.
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === '.' || threadId === '..') {
    throw new Error(`unsafe threadId for workspace: ${threadId}`)
  }
  return `${workspaceRoot}/${threadId}`
}

// `PiModelDescriptor` moved to `build-harness.ts` with the assembly that reads
// it. Re-exported here so existing importers are unaffected by the split.
export type { PiModelDescriptor } from './build-harness.ts'

/** Inputs for {@link buildAppHarness}. */
export type BuildAppHarnessOptions = {
  /** The model to run, tagged by Pi engine family. */
  readonly model: PiModelDescriptor
  /** System prompt sent with each model request. */
  readonly systemPrompt: AgentHarnessOptions['systemPrompt']
  /** Reasoning depth for the harness. */
  readonly thinkingLevel: ThinkingLevel
  /** Chat thread this harness serves. Its tools are bound to the thread's
   *  isolated workspace ({@link workspaceDirFor}). */
  readonly threadId: string
  /** Extra tools to register and activate alongside the four coding tools. */
  readonly tools?: AgentTool[]
  /** Prior conversation turns to seed into the session before the first prompt,
   *  so the agent has multi-turn context. Omitted/empty starts a blank session. */
  readonly history?: readonly SeedTurn[]
}

/**
 * Build a ready-to-run app harness for a thread. Mounts the ZenFS singleton
 * (once), carves the thread's isolated workspace under {@link workspaceRoot},
 * binds the coding tools to it, resolves the proxied model (anthropic or
 * openai-compatible), and returns the constructed harness. The workspace persists
 * with the harness; tear it down by removing {@link workspaceDirFor}`(threadId)`
 * when the thread is disposed.
 *
 * @param options - model descriptor, prompt, thinking level, thread id, extra tools, history
 * @returns the constructed {@link AgentHarness}
 */
export const buildAppHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
  ensureBufferPolyfill()
  await mountAgentFs()
  const workspaceDir = workspaceDirFor(options.threadId)
  const env = new BrowserExecutionEnv({ cwd: workspaceDir })
  const created = await env.createDir(workspaceDir)
  if (!created.ok) {
    throw created.error
  }

  return buildHarness({
    model: options.model,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    env,
    tools: [...createBrowserCodingTools(env, { cwd: workspaceDir }), ...(options.tools ?? [])],
    history: options.history,
  })
}
