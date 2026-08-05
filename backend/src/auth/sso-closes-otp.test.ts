/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * In `oidc`/`saml` mode the identity provider is the only intended way in, so the
 * consumer passwordless funnel must be refused outright.
 *
 * This is the regression guard for a real hole in a public deployment: closing
 * self-registration in the Keycloak realm does nothing about these endpoints,
 * which are mounted regardless of `AUTH_MODE`. They were only *incidentally*
 * closed -- an unknown email lands in the waitlist as `pending`, and self-hosted
 * stacks tend to have no mail sender wired up -- and setting
 * `WAITLIST_AUTO_APPROVE_DOMAINS` or configuring email would have silently
 * reopened a second route to an account that the IdP never approved.
 */
describe('SSO mode closes the consumer OTP funnel', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  }, 60_000)

  afterAll(async () => {
    await cleanup?.().catch(() => {})
  }, 60_000)

  afterEach(() => {
    getSettingsSpy?.mockRestore()
  })

  const appFor = async (authMode: 'consumer' | 'oidc' | 'saml') => {
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({
        logLevel: 'ERROR',
        posthogHost: '',
        authMode,
        ...(authMode === 'oidc' && {
          oidcIssuer: 'https://oidc.test',
          oidcClientId: 'thunderbolt-app',
          oidcClientSecret: 'secret',
        }),
        ...(authMode === 'saml' && {
          samlEntryPoint: 'https://idp.test/sso',
          samlEntityId: 'thunderbolt-saml-sp',
          samlIdpIssuer: 'https://idp.test',
          samlCert: 'Zm9v',
        }),
      }),
    )
    const { createAuth } = await import('./auth')
    return new Elysia({ prefix: '/v1' }).mount(createAuth(db).handler)
  }

  const post = (app: Elysia, path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost/v1/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  for (const mode of ['oidc', 'saml'] as const) {
    it(`refuses the OTP request endpoint in ${mode} mode`, async () => {
      const app = await appFor(mode)
      const res = await post(app, '/email-otp/send-verification-otp', {
        email: 'stranger@example.com',
        type: 'sign-in',
      })
      expect(res.status).toBe(404)
    })

    it(`refuses OTP redemption in ${mode} mode`, async () => {
      const app = await appFor(mode)
      const res = await post(app, '/sign-in/email-otp', {
        email: 'stranger@example.com',
        otp: '12345678',
      })
      expect(res.status).toBe(404)
    })
  }

  // The gate must be scoped to SSO, or it would break the consumer product.
  it('leaves the OTP endpoints reachable in consumer mode', async () => {
    const app = await appFor('consumer')
    const res = await post(app, '/sign-in/email-otp', {
      email: 'stranger@example.com',
      otp: '12345678',
    })
    // 401 is the existing challenge-token guard: reachable, and still protected.
    expect(res.status).not.toBe(404)
    expect(res.status).toBe(401)
  })
})
