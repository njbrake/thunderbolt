/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Environment-agnostic core of harness construction: pick the model, build the
 * {@link AgentHarness}, seed prior turns.
 *
 * Split out of `build-app-harness.ts` so the same assembly serves two hosts that
 * cannot share an execution environment. The browser binds a
 * `BrowserExecutionEnv` over an OPFS/ZenFS mount; the backend binds Pi's own
 * `NodeExecutionEnv`. Both of those pull host-only modules at import time, so the
 * shared part has to live in a file that imports neither — importing
 * `build-app-harness.ts` from the server would drag ZenFS and OPFS along with it.
 *
 * The caller owns the environment and the full tool list. That is deliberate:
 * which tools a host is willing to expose is a host decision, not a detail of
 * harness assembly. The backend passes none.
 */

import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessOptions,
  type AgentTool,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import { buildAnthropicModel, type AgentFetch } from './anthropic-model.ts'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'
import { buildSeedMessages, type SeedTurn } from './seed-history.ts'

/**
 * The model the harness runs, tagged by Pi engine family. Both variants route
 * their LLM HTTP through an injected `fetch` (the app's proxy / SSO fetch):
 *
 *   - `anthropic` resolves a model from Pi's built-in catalog and wires the
 *     `@anthropic-ai/sdk` client through `fetch` ({@link buildAnthropicModel}).
 *   - `openai-compat` synthesizes an `openai-completions` model for the app's
 *     OpenAI-wire providers (`openai`/`custom`/`openrouter`/`thunderbolt`) and
 *     injects `fetch` around client construction ({@link buildOpenAiCompatModel}).
 */
export type PiModelDescriptor =
  | {
      readonly kind: 'anthropic'
      /** Anthropic model id to resolve from Pi's catalog, e.g. `claude-opus-4-8`. */
      readonly modelId: string
      /** Anthropic API key (HTTP still flows through `fetch`). */
      readonly apiKey: string
      /** Fetch every request is routed through — the app's proxy fetch. */
      readonly fetch: AgentFetch
    }
  | {
      readonly kind: 'openai-compat'
      /** App provider name, also used as the Pi provider id. */
      readonly providerId: string
      /** Upstream model id sent on the wire. */
      readonly modelId: string
      /** OpenAI-compatible base URL. */
      readonly baseURL: string
      /** Bearer key for the OpenAI SDK (placeholder when `fetch` supplies auth). */
      readonly apiKey: string
      /** Provider-specific app fetch (proxy fetch, or thunderbolt SSO fetch). */
      readonly fetch: AgentFetch
      /** Whether to request a reasoning effort (else Pi sends none). */
      readonly reasoning: boolean
      /** Optional upstream context window. */
      readonly contextWindow?: number
      /** Whether the model accepts image input; drives the synthetic descriptor's
       *  input modalities (text-only strips images before the wire). */
      readonly supportsImages: boolean
    }

/** Inputs for {@link buildHarness}. */
export type BuildHarnessOptions = {
  /** The model to run, tagged by Pi engine family. */
  readonly model: PiModelDescriptor
  /** System prompt sent with each model request. */
  readonly systemPrompt: AgentHarnessOptions['systemPrompt']
  /** Reasoning depth for the harness. */
  readonly thinkingLevel: ThinkingLevel
  /** Execution environment the harness and its tools run against. */
  readonly env: AgentHarnessOptions['env']
  /** Every tool to register and activate. Already resolved by the host — this
   *  function adds none of its own. */
  readonly tools: AgentTool[]
  /** Prior conversation turns to seed into the session before the first prompt,
   *  so the agent has multi-turn context. Omitted/empty starts a blank session. */
  readonly history?: readonly SeedTurn[]
}

/** Resolve the Pi model pair for a descriptor. */
const resolveModel = (model: PiModelDescriptor) =>
  model.kind === 'anthropic'
    ? buildAnthropicModel({ apiKey: model.apiKey, fetch: model.fetch, modelId: model.modelId })
    : buildOpenAiCompatModel({
        providerId: model.providerId,
        modelId: model.modelId,
        baseURL: model.baseURL,
        apiKey: model.apiKey,
        fetch: model.fetch,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        supportsImages: model.supportsImages,
      })

/**
 * Assemble a harness against a caller-supplied environment and tool set.
 *
 * @param options - model descriptor, prompt, thinking level, environment, tools, history
 * @returns the constructed {@link AgentHarness}, already seeded with prior turns
 */
export const buildHarness = async (options: BuildHarnessOptions): Promise<AgentHarness> => {
  const session = await new InMemorySessionRepo().create({})
  const { models, model } = resolveModel(options.model)

  const harness = new AgentHarness({
    env: options.env,
    session,
    models,
    model,
    tools: options.tools,
    activeToolNames: options.tools.map((tool) => tool.name),
    thinkingLevel: options.thinkingLevel,
    systemPrompt: options.systemPrompt,
  })

  // Seed prior turns into the (idle) session so the first prompt runs with full
  // conversational context. `appendMessage` writes straight to the session while
  // idle; `prompt` then reads them back via `session.buildContext()`.
  for (const message of buildSeedMessages(options.history)) {
    await harness.appendMessage(message)
  }

  return harness
}
