/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router'
import AuthError from './auth-error'

const replace = mock(() => {})
const originalLocation = window.location

const setLocation = (value: Location | (Location & { replace: typeof replace })) =>
  Object.defineProperty(window, 'location', { value, writable: true, configurable: true })

const renderAt = (query: string) =>
  render(
    <MemoryRouter initialEntries={[`/auth-error${query}`]}>
      <Routes>
        <Route path="/auth-error" element={<AuthError />} />
      </Routes>
    </MemoryRouter>,
  )

describe('AuthError', () => {
  beforeAll(() => {
    setLocation({ ...originalLocation, replace })
  })

  // The stub is global, so leaving it in place would follow this worker into
  // every later test file.
  afterAll(() => {
    setLocation(originalLocation)
  })

  afterEach(() => {
    replace.mockClear()
  })

  it('does not re-enter the sign-in flow on mount', () => {
    // The whole point of the route: a persistent failure has to stop here rather
    // than bounce back through /sso-redirect and the identity provider forever.
    renderAt('?error=account_not_linked')

    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('explains a stale flow as retryable', () => {
    renderAt('?error=state_security_mismatch')

    expect(screen.getByText(/took too long to complete/)).toBeInTheDocument()
  })

  it('reads the code from the state param when there is no error param', () => {
    // Better Auth reports a missing state parameter as `?state=state_not_found`.
    renderAt('?state=state_not_found')

    expect(screen.getByText(/took too long to complete/)).toBeInTheDocument()
    expect(screen.getByText('Error code: state_not_found')).toBeInTheDocument()
  })

  it('surfaces an unmapped code so support has the real signal', () => {
    renderAt('?error=idp_exploded')

    expect(screen.getByText(/contact your administrator/)).toBeInTheDocument()
    expect(screen.getByText('Error code: idp_exploded')).toBeInTheDocument()
  })

  it('shows the provider description alongside the code, not instead of it', () => {
    renderAt('?error=invalid_request&error_description=Client+not+registered')

    expect(screen.getByText('Client not registered')).toBeInTheDocument()
    expect(screen.getByText('Error code: invalid_request')).toBeInTheDocument()
  })

  it('retries from a link the user chooses to click', () => {
    renderAt('?error=state_mismatch')
    screen.getByRole('button', { name: 'Try again' }).click()

    expect(replace).toHaveBeenCalled()
  })
})
