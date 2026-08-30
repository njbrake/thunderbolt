/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether this deployment runs turns server-side.
 *
 * Its own module so `GET /config` can answer the question without importing the
 * turn routes, which reach the Pi engine through the harness. A capability flag
 * should not drag an inference engine into the config endpoint's import graph.
 */

import type { Settings } from '@/config/settings'

/**
 * Server-side execution requires reading the conversation in plaintext, which is
 * precisely what a zero-knowledge deployment promises never happens. The two
 * features are mutually exclusive on the same data, so a deployment that has
 * turned encryption on does not get this one. Refusing loudly is the point: a
 * silent client-side fallback would leave an operator believing detached turns
 * work when they never run.
 */
export const serverTurnsAvailable = (settings: Settings): boolean =>
  !settings.e2eeEnabled && !!settings.thunderboltInferenceUrl && !!settings.thunderboltInferenceApiKey
