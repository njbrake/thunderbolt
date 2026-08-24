/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { clearGatewayModelCache } from '@/inference/gateway-models'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { createConfigRoutes } from './config'

const fetchConfig = async (
  settings: Parameters<typeof createConfigRoutes>[0],
  options: Parameters<typeof createConfigRoutes>[1] = {},
) => {
  const app = new Elysia().use(createConfigRoutes(settings, options))
  const response = await app.handle(new Request('http://localhost/config'))
  return { status: response.status, body: await response.json() }
}

/** Stub of an OpenAI-compatible `GET /models` response. */
const modelsResponse = (ids: string[]) =>
  mock(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }))

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
      expect(body.defaults.gatewayModels).toEqual([])
    })

    it('leaves models defaults untouched when no inference gateway is configured', async () => {
      const { body } = await fetchConfig(createTestSettings({ thunderboltInferenceModels: 'ignored' }))
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
      expect(body.defaults.gatewayModels).toEqual([])
    })

    it('publishes gateway models in a separate, non-version-gated field', async () => {
      const settings = createTestSettings({
        thunderboltInferenceUrl: 'https://gateway.example.com/v1',
        thunderboltInferenceApiKey: 'key',
        thunderboltInferenceModels: 'llama-3.3-70b=Llama 3.3 70B',
      })
      // Discovery runs through the route's own injected fetch — the route, not
      // the test, exercises the `/models` call.
      const { body } = await fetchConfig(settings, { fetchFn: modelsResponse(['llama-3.3-70b']) as never })

      // The version-gated models channel is untouched: gateway models no longer
      // ride it (that hid them behind a synthetic version bump).
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)

      expect(body.defaults.gatewayModels).toHaveLength(1)
      const gatewayModel = body.defaults.gatewayModels[0]
      expect(gatewayModel.name).toBe('Llama 3.3 70B')
      expect(gatewayModel.model).toBe('llama-3.3-70b')
      expect(gatewayModel.provider).toBe('thunderbolt')
      expect(gatewayModel.url).toBeNull()
    })
  })
})
