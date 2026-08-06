/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import SsoSignIn from './sso-sign-in'

// The flow ends in a real navigation, so both are stubbed to observe it.
const mockAssign = mock()
const mockReplace = mock()
Object.defineProperty(window, 'location', {
  value: {
    origin: 'https://app.test',
    get href() {
      return 'https://app.test/sign-in'
    },
    set href(value: string) {
      mockAssign(value)
    },
    replace: mockReplace,
  },
  writable: true,
  configurable: true,
})

const originalFetch = globalThis.fetch

/** Stub the backend's sign-in/sso response with the URL it would hand back. */
const stubSsoEndpoint = (body: unknown, status = 200) => {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as never
}

describe('SsoSignIn', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    mockAssign.mockClear()
    mockReplace.mockClear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const renderComponent = () => render(<SsoSignIn />, { wrapper: createTestProvider() })

  /** The suite runs on a fake clock, so drain pending timers/microtasks rather
   *  than polling with `waitFor` (which calls into jest's timer API). */
  const settle = async () => {
    await act(async () => {
      await getClock().runAllAsync()
    })
  }

  it('renders a sign-in screen with Thunderbolt branding', () => {
    renderComponent()
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByText('Thunderbolt')).toBeInTheDocument()
  })

  it('offers a sign-in button naming the identity provider', () => {
    renderComponent()
    // VITE_SSO_PROVIDER_NAME is unset under test, so the generic label applies.
    expect(screen.getByRole('button', { name: /^sign in with/i })).toBeInTheDocument()
  })

  // The point of this screen: the old component redirected from a useEffect, so
  // the app's own domain never rendered anything and a misconfigured IdP produced
  // a redirect loop with nowhere to show the error.
  it('does not contact the identity provider until the button is clicked', async () => {
    const fetchSpy = mock(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = fetchSpy as never

    renderComponent()
    await settle()

    expect(screen.getByRole('button', { name: /^sign in with/i })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockAssign).not.toHaveBeenCalled()
  })

  it('navigates to the URL the backend returns when clicked', async () => {
    stubSsoEndpoint({ url: 'https://idp.test/realms/x/protocol/openid-connect/auth?client_id=y' })

    renderComponent()
    fireEvent.click(screen.getByRole('button', { name: /^sign in with/i }))
    await settle()

    expect(mockAssign).toHaveBeenCalledWith('https://idp.test/realms/x/protocol/openid-connect/auth?client_id=y')
  })

  it('refuses to navigate to an unsafe URL', async () => {
    // A compromised or misconfigured backend must not be able to turn this button
    // into an open redirect to a javascript: URL.
    stubSsoEndpoint({ url: 'javascript:alert(1)' })

    renderComponent()
    fireEvent.click(screen.getByRole('button', { name: /^sign in with/i }))
    await settle()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(mockAssign).not.toHaveBeenCalled()
  })

  it('surfaces an error and stays on the page when the backend is unreachable', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('network down')
    }) as never

    renderComponent()
    fireEvent.click(screen.getByRole('button', { name: /^sign in with/i }))
    await settle()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(mockAssign).not.toHaveBeenCalled()
    // Recoverable without a reload: the button is live again.
    expect(screen.getByRole('button', { name: /^sign in with/i })).not.toBeDisabled()
  })
})
