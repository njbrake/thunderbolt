/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { setAuthToken } from '@/lib/auth-token'
import { http } from '@/lib/http'
import { isTauri } from '@/lib/platform'
import { startSsoFlowLoopback } from '@/lib/sso-loopback'
import { isSafeUrl } from '@/lib/url-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/**
 * Display name for the identity provider, used in the button label.
 *
 * Deployment-specific, so it is a build arg rather than a hardcoded string: this
 * same screen fronts Keycloak, Okta, Entra, Auth0 or any other OIDC/SAML IdP.
 * Defaults to the generic "SSO" when unset.
 */
const providerName = import.meta.env.VITE_SSO_PROVIDER_NAME || 'SSO'

type SignInStatus = 'idle' | 'connecting' | 'error'

/**
 * Sign-in screen for SSO mode (OIDC or SAML).
 *
 * Deliberately waits for a click instead of redirecting on mount. Bouncing
 * straight to the identity provider works, but it means the app's own domain
 * never renders anything: users land on a third-party login form having never
 * seen what they are signing in to, back-navigation lands on a page that
 * immediately re-redirects, and a misconfigured IdP produces a redirect loop with
 * nowhere to show an error.
 *
 * On Tauri desktop this uses the system browser plus a loopback listener rather
 * than navigating the webview, because WKWebView drops cookies across
 * cross-origin redirects. A click is a better fit there too: opening an external
 * browser unprompted is exactly the kind of thing a user should initiate.
 */
const SsoSignIn = () => {
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const authClient = useAuth()
  const analytics = useAnonymousPromotionAnalytics()
  const [status, setStatus] = useState<SignInStatus>('idle')
  const abortRef = useRef<AbortController | null>(null)

  // The flow ends in a full navigation, but an unmount before that (route change,
  // hot reload) must not leave a request in flight.
  useEffect(() => () => abortRef.current?.abort(), [])

  const startSignIn = async () => {
    const abortController = new AbortController()
    abortRef.current = abortController
    setStatus('connecting')

    const baseUrl = cloudUrl.replace(/\/v1$/, '')

    try {
      // Capture the anonymous id before any redirect, so persistForSso() has it.
      await analytics.captureAnonId(authClient)

      // Tauri desktop: system browser + loopback listener (RFC 8252).
      if (isTauri()) {
        analytics.persistForSso()
        const token = await startSsoFlowLoopback(baseUrl)
        if (token) {
          setAuthToken(token)
          window.location.replace('/')
        } else {
          setStatus('error') // timed out waiting for the browser round-trip
        }
        return
      }

      // Web: hand the browser to the IdP.
      const data = await http
        .post(`${baseUrl}/v1/api/auth/sign-in/sso`, {
          json: { providerId: 'sso', callbackURL: window.location.origin + '/' },
          credentials: 'include',
          signal: abortController.signal,
        })
        .json<{ url: string }>()

      if (!isSafeUrl(data.url)) {
        console.error('SSO redirect blocked: unsafe URL', data.url)
        setStatus('error')
        return
      }

      // Persist the anon id to sessionStorage BEFORE the browser navigates away.
      analytics.persistForSso()
      window.location.href = data.url
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      console.error('SSO sign-in failed:', err)
      setStatus('error')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh px-6">
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AppLogo size={16} />
          <span>Thunderbolt</span>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-muted-foreground">Sign in to continue to Thunderbolt.</p>
        </div>

        <div className="flex w-full max-w-xs flex-col items-center gap-3">
          <Button className="w-full" onClick={startSignIn} disabled={status === 'connecting'}>
            {status === 'connecting' ? 'Connecting...' : `Sign in with ${providerName}`}
          </Button>

          {status === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              Couldn't reach {providerName}. Check your connection and try again.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default SsoSignIn
