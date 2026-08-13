/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { isSsoMode } from '@/lib/auth-mode'
import { useSearchParams } from 'react-router'

/** Codes that mean the flow went stale rather than that it can never succeed. */
const staleFlowCodes = new Set([
  'invalid_state',
  'please_restart_the_process',
  'state_mismatch',
  'state_not_found',
  'state_security_mismatch',
])

/**
 * Maps a Better Auth error code to copy that tells the user what to do next.
 * Unmapped codes get generic copy; the code is always rendered alongside it so a
 * support ticket carries the real signal even when the provider also sent a
 * description.
 */
const describeAuthError = (code: string): string => {
  if (staleFlowCodes.has(code)) {
    return 'Your sign-in took too long to complete. Starting over usually fixes this.'
  }
  if (code === 'account_not_linked') {
    return 'This email is already registered with a different sign-in method. Ask your administrator to link the accounts.'
  }
  return 'Sign-in could not be completed. If this keeps happening, contact your administrator.'
}

/**
 * Terminal landing page for auth failures, wired up as Better Auth's
 * `onAPIError.errorURL`. Deliberately does not re-enter the sign-in flow on
 * mount: a persistent failure (unlinked account, IdP misconfiguration) would
 * otherwise bounce between the app and the identity provider forever.
 */
const AuthError = () => {
  const [searchParams] = useSearchParams()
  // Better Auth reports the code as `?error=` on most paths, but a missing state
  // parameter arrives as `?state=state_not_found`.
  const code = searchParams.get('error') || searchParams.get('state') || 'unknown_error'
  const description = searchParams.get('error_description')

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-8 px-6 text-center">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AppLogo size={16} />
          <span>Thunderbolt</span>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Sign-in failed</h1>
          <p className="text-muted-foreground">{describeAuthError(code)}</p>
          {description && <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{description}</p>}
          <p className="text-[length:var(--font-size-xs)] text-muted-foreground">Error code: {code}</p>
        </div>

        <Button onClick={() => window.location.replace(isSsoMode() ? '/sign-in' : '/')}>Try again</Button>
      </div>
    </div>
  )
}

export default AuthError
