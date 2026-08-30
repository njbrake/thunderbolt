/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Boot-time reconciliation for detached turns.
 *
 * A restart is the normal case here, not an exceptional one: every deploy ends a
 * process that may have been mid-turn. The guarantee this preserves is that a
 * turn either finishes or visibly fails, and never just stops existing.
 */

import { serverTurnsAvailable } from './routes'
import { drainQueuedRuns, type TurnRunnerDeps } from './runner'
import { recoverInterruptedRuns } from './store'

/**
 * Requeue turns stranded by the previous process, then start what is waiting.
 *
 * Never throws: a failure here must not stop the server from booting, since the
 * rest of the API is unaffected by whether detached turns recover.
 */
export const recoverAndDrainTurnRuns = async (deps: TurnRunnerDeps): Promise<void> => {
  if (!serverTurnsAvailable(deps.settings)) {
    return
  }
  try {
    const { requeued, abandoned } = await recoverInterruptedRuns(deps.database)
    if (requeued.length > 0 || abandoned.length > 0) {
      deps.logger?.info(
        { event: 'turn_runs_recovered', requeued: requeued.length, abandoned: abandoned.length },
        'Recovered turn runs interrupted by a restart',
      )
    }
    const started = await drainQueuedRuns(deps)
    if (started > 0) {
      deps.logger?.info({ event: 'turn_runs_drained', started }, 'Started queued turn runs')
    }
  } catch (error) {
    deps.logger?.error(
      { event: 'turn_run_recovery_failed', error: error instanceof Error ? error.message : String(error) },
      'Turn run recovery failed; queued turns will wait for the next boot',
    )
  }
}
