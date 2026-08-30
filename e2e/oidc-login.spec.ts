/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { loginViaOidc, collectPageErrors } from './helpers'

test.describe('OIDC login flow', () => {
  test('unauthenticated user is redirected through OIDC and lands on chat', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)

    // Should be on an authenticated chat page
    await expect(page).toHaveURL(/\/chats\//)
    expect(errors).toHaveLength(0)
  })

  test('authenticated session persists across navigation', async ({ page }) => {
    await loginViaOidc(page)

    // Navigate to settings
    await page.goto('/settings')
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 })

    // Navigate back to chat
    await page.goto('/chats/new')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 })

    // Should NOT be redirected to OIDC again
    await expect(page).not.toHaveURL(/sign-in/)
  })

  test('page loads without critical JS errors after OIDC login', async ({ page }) => {
    const errors = collectPageErrors(page)

    await loginViaOidc(page)

    // Navigate around to exercise the app
    await page.goto('/settings')
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 })
    await page.goto('/chats/new')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 })

    expect(errors).toHaveLength(0)
  })
})

test.describe('OIDC redirect behavior', () => {
  test('signing in from the sign-in page triggers the OIDC flow', async ({ page }) => {
    // SSO mode renders a sign-in screen and starts the flow on click rather than
    // redirecting on load, so drive the button instead of waiting on navigation.
    const responsePromise = page.waitForResponse(/\/(authorize|openid-connect\/auth)/, {
      timeout: 15_000,
    })

    await page.goto('/')
    await page.getByRole('button', { name: /^sign in with/i }).click()

    const response = await responsePromise
    const url = new URL(response.url())
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('thunderbolt-app')
  })
})
