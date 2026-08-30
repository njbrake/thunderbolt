/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Download, RefreshCw, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { m, AnimatePresence } from 'framer-motion'
import { useDesktopUpdate, type UpdateStatus } from '@/hooks/use-desktop-update'
import { useWebAppUpdate } from '@/hooks/use-web-app-update'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/platform'
import { isServiceWorkerSupported } from '@/lib/service-worker'

const statusConfig: Record<
  UpdateStatus,
  { icon: typeof Download; message: MessageDescriptor | null; showActions: boolean }
> = {
  initial: { icon: CheckCircle, message: null, showActions: false },
  idle: { icon: CheckCircle, message: null, showActions: false },
  checking: { icon: Loader2, message: msg`Checking for updates…`, showActions: false },
  available: { icon: Download, message: msg`A new version is available!`, showActions: true },
  downloading: { icon: Loader2, message: msg`Downloading update…`, showActions: false },
  ready: { icon: RefreshCw, message: msg`Update ready! Restart to apply.`, showActions: true },
  error: { icon: AlertCircle, message: msg`Update failed`, showActions: true },
}

const DesktopUpdateNotification = () => {
  const { i18n, t } = useLingui()
  const { status, update, error, primaryAction } = useDesktopUpdate()
  const updateVersion = update?.version ?? ''
  const [dismissed, setDismissed] = useState(false)

  const isVisible = !dismissed && status !== 'initial' && status !== 'idle' && status !== 'checking'
  const config = statusConfig[status]
  const Icon = config.icon

  const handleDismiss = () => {
    setDismissed(true)
  }

  return (
    <AnimatePresence>
      {isVisible && (
        <m.div
          key="update-notification"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-card border border-border rounded-xl shadow-lg p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <Icon
                  className={`size-5 ${status === 'downloading' ? 'animate-spin' : ''} ${
                    status === 'error' ? 'text-destructive' : 'text-primary'
                  }`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{config.message ? i18n._(config.message) : ''}</p>

                {status === 'available' && update && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <Trans>Version {updateVersion}</Trans>
                  </p>
                )}

                {status === 'error' && error && <p className="text-xs text-destructive mt-1">{error}</p>}

                {config.showActions && (
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" onClick={primaryAction}>
                      {status === 'available' && <Trans>Download</Trans>}
                      {status === 'ready' && <Trans>Restart Now</Trans>}
                      {status === 'error' && <Trans>Retry</Trans>}
                    </Button>

                    {status !== 'error' && (
                      <Button size="sm" variant="ghost" onClick={handleDismiss}>
                        <Trans>Later</Trans>
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={handleDismiss}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label={t`Dismiss`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Web/PWA update prompt.
 *
 * A browser tab has no equivalent of the desktop updater: the new build is
 * already downloaded by the service worker and simply waiting, so there is no
 * download step and no progress — just "reload onto it". Reloading is the user's
 * call rather than automatic, because it discards whatever is on screen.
 */
const WebUpdateNotification = () => {
  const { t } = useLingui()
  const { updateAvailable, dismissed, applyUpdate, dismiss } = useWebAppUpdate()
  const [reloading, setReloading] = useState(false)

  const handleReload = () => {
    setReloading(true)
    applyUpdate()
  }

  return (
    <AnimatePresence>
      {updateAvailable && !dismissed && (
        <m.div
          key="web-update-notification"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          // `bottom-*` uses the safe-area inset so the card clears the iOS home
          // indicator when running as an installed app.
          className="fixed right-4 z-50 max-w-sm"
          style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        >
          <div className="bg-card border border-border rounded-xl shadow-lg p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <RefreshCw className={`size-5 text-primary ${reloading ? 'animate-spin' : ''}`} />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  <Trans>A new version of Thunderbolt is available.</Trans>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {reloading ? (
                    <Trans>Reloading...</Trans>
                  ) : (
                    <Trans>Reload to get the latest features and fixes.</Trans>
                  )}
                </p>

                <div className="flex gap-2 mt-3">
                  <Button size="sm" onClick={handleReload} disabled={reloading}>
                    <Trans>Reload</Trans>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={dismiss} disabled={reloading}>
                    <Trans>Later</Trans>
                  </Button>
                </div>
              </div>

              <button
                onClick={dismiss}
                disabled={reloading}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label={t`Dismiss`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Update prompt for whichever update channel this build actually has: Tauri's
 * updater on desktop, the service worker on the web. Mobile Tauri builds update
 * through the app stores and get neither.
 */
export const UpdateNotification = () => {
  if (isDesktop()) {
    return <DesktopUpdateNotification />
  }
  if (isServiceWorkerSupported()) {
    return <WebUpdateNotification />
  }
  return null
}
