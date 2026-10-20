/**
 * Development-fork update channel.
 *
 * Upstream npm releases do not contain this fork's compatibility changes.
 * Until this fork publishes its own releases, updates are manual source builds.
 * Keep the lifecycle API so extension activation/deactivation stays unchanged.
 */
import type * as vscode from 'vscode'

const DEVELOPMENT_URL = 'https://github.com/fanny7d/CCursor/blob/fanny7d/cursor-3259-nas/DEVELOPMENT.md'

export function startUpdateCheck(
  _state: vscode.Memento,
  log?: (msg: string) => void,
) {
  log?.(`[UPDATE] Development fork: follow the manual update guide at ${DEVELOPMENT_URL}`)
}

export function stopUpdateCheck() {
  // The development fork schedules no background update requests or timers.
}
