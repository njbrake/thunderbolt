/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { clearGatewayModelCache, ensureGatewayModels } from '@/inference/gateway-models'
import { supportedModels } from '@/inference/routes'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { createConfigRoutes } from './config'

/**
 * Resolve a bundled model by the provider it routes to, rather than naming one.
 * The shipped lineup gets version-bumped (opus-4.8 became opus-5), and a
 * hardcoded id turns that routine bump into an unrelated test failure.
 */
const bundledModelRoutedTo = (provider: string): string => {
  const model = defaultModels.find((m) => supportedModels[m.model]?.provider === provider)
  if (!model) {
    throw new Error(`No bundled model routes to ${provider}; update this helper.`)
  }
  return model.model
}

const fetchConfig = async (settings: Parameters<typeof createConfigRoutes>[0]) => {
  const app = new Elysia().use(createConfigRoutes(settings))
  const response = await app.handle(new Request('http://localhost/config'))
  return { status: response.status, body: await response.json() }
}

describe('Config Routes', () => {
  beforeEach(() => {
    clearGatewayModelCache()
  })

  describe('GET /config', () => {
    it('reflects e2eeEnabled', async () => {
      const disabled = await fetchConfig(createTestSettings({ e2eeEnabled: false }))
      expect(disabled.body.e2eeEnabled).toBe(false)

      const enabled = await fetchConfig(createTestSettings({ e2eeEnabled: true }))
      expect(enabled.body.e2eeEnabled).toBe(true)
    })

    it('exposes builtInAgentEnabled: true by default and false when disabled', async () => {
      const onByDefault = await fetchConfig(createTestSettings())
      expect(onByDefault.body.builtInAgentEnabled).toBe(true)

      const disabled = await fetchConfig(createTestSettings({ disableBuiltInAgent: true }))
      expect(disabled.body.builtInAgentEnabled).toBe(false)
    })

    it('exposes allowCustomAgents', async () => {
      const allowed = await fetchConfig(createTestSettings({ allowCustomAgents: true }))
      expect(allowed.body.allowCustomAgents).toBe(true)

      const forbidden = await fetchConfig(createTestSettings({ allowCustomAgents: false }))
      expect(forbidden.body.allowCustomAgents).toBe(false)
    })

    // The frontend decides which tools to hand the model and cannot see the
    // backend's credentials. Without this flag it offered web search regardless,
    // so a deployment with no EXA_API_KEY failed the tool call mid-answer.
    it('reports both web capabilities from whether a credential is configured', async () => {
      const withKey = await fetchConfig(createTestSettings({ exaApiKey: 'exa-test' }))
      expect(withKey.body.webSearchEnabled).toBe(true)
      expect(withKey.body.webFetchEnabled).toBe(true)

      const withoutKey = await fetchConfig(createTestSettings({ exaApiKey: '' }))
      expect(withoutKey.body.webSearchEnabled).toBe(false)
      expect(withoutKey.body.webFetchEnabled).toBe(false)
    })

    // Reported separately because they are configured separately. A named provider
    // whose credential is missing reports off rather than advertising a tool that
    // would 503 partway through an answer.
    it('reports a capability off when its provider is named without a credential', async () => {
      const { body } = await fetchConfig(createTestSettings({ webSearchProvider: 'exa', exaApiKey: '' }))
      expect(body.webSearchEnabled).toBe(false)
    })

    it('omits minAppVersion when MIN_APP_VERSION is unset', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.minAppVersion).toBeUndefined()
    })

    it('exposes minAppVersion when set', async () => {
      const { body } = await fetchConfig(createTestSettings({ minAppVersion: '0.2.0' }))
      expect(body.minAppVersion).toBe('0.2.0')
    })

    it('does not require authentication', async () => {
      const { status } = await fetchConfig(createTestSettings())
      expect(status).toBe(200)
    })

    it('ships models defaults with their shared version', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    it('leaves models defaults untouched when no inference gateway is configured', async () => {
      const { body } = await fetchConfig(createTestSettings({ thunderboltInferenceModels: 'ignored' }))
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    // The shipped lineup routes to Anthropic / Fireworks / Tinfoil. A self-host
    // holding none of those keys was still advertising all three, so the picker
    // offered models that fail the moment you send to them.
    it('omits shipped models this deployment holds no credentials for', async () => {
      const settings = createTestSettings({
        anthropicApiKey: '',
        fireworksApiKey: '',
        tinfoilApiKey: '',
        thunderboltInferenceUrl: 'https://gateway.example.com/v1',
        thunderboltInferenceApiKey: 'key',
      })
      await ensureGatewayModels(settings, {
        fetchFn: mock(async () => new Response(JSON.stringify({ data: [{ id: 'kimi' }] }), { status: 200 })) as never,
      })
      const { body } = await fetchConfig(settings)

      const ids = body.defaults.models.data.map((m: { model: string }) => m.model)
      expect(ids).toEqual(['kimi'])
      // Out-versions the bundle, so the client adopts it and retires the rest.
      expect(body.defaults.models.version).toBe(defaultModelsVersion + 1)
    })

    it('keeps a shipped model whose provider credential IS configured', async () => {
      const { body } = await fetchConfig(createTestSettings({ anthropicApiKey: 'sk-test' }))
      const ids = body.defaults.models.data.map((m: { model: string }) => m.model)
      // Only the Anthropic credential is set, so the Anthropic-routed model
      // survives and the Tinfoil-routed one is filtered out.
      expect(ids).toContain(bundledModelRoutedTo('anthropic'))
      expect(ids).not.toContain(bundledModelRoutedTo('tinfoil'))
    })

    // An unreachable gateway is transient; retiring every model on every client
    // because of it would be worse than advertising a wrong-but-present lineup.
    it('falls back to the shipped lineup rather than publishing nothing', async () => {
      const { body } = await fetchConfig(
        createTestSettings({ anthropicApiKey: '', fireworksApiKey: '', tinfoilApiKey: '' }),
      )
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    it('appends inference gateway models and out-versions the bundled defaults', async () => {
      const settings = createTestSettings({
        // Credentials for the whole shipped lineup, so this exercises appending
        // rather than the credential filter (covered separately below).
        anthropicApiKey: 'sk-anthropic',
        fireworksApiKey: 'sk-fireworks',
        tinfoilApiKey: 'sk-tinfoil',
        thunderboltInferenceUrl: 'https://gateway.example.com/v1',
        thunderboltInferenceApiKey: 'key',
        thunderboltInferenceModels: 'llama-3.3-70b=Llama 3.3 70B',
      })
      // Models are discovered from the gateway, so prime the cache with a stubbed
      // /models response; the route then reads it without any network access.
      await ensureGatewayModels(settings, {
        fetchFn: mock(
          async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }] }), { status: 200 }),
        ) as never,
      })
      const { body } = await fetchConfig(settings)

      // A higher version is what makes the client prefer this payload over its
      // bundled copy.
      expect(body.defaults.models.version).toBe(defaultModelsVersion + 1)
      expect(body.defaults.models.data).toHaveLength(defaultModels.length + 1)
      expect(body.defaults.models.data.slice(0, defaultModels.length)).toEqual(defaultModels)

      const gatewayModel = body.defaults.models.data.at(-1)
      expect(gatewayModel.name).toBe('Llama 3.3 70B')
      expect(gatewayModel.model).toBe('llama-3.3-70b')
      expect(gatewayModel.provider).toBe('thunderbolt')
      expect(gatewayModel.url).toBeNull()
    })
  })
})
