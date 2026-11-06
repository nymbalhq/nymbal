import type { Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { RefreshTokenRepository } from '../repositories/refresh-token.js'
import { REFRESH_REUSE_WINDOW_MS } from '../services/auth-service.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

export interface RefreshTokenSweeperDeps {
  store: CommandStore
  refreshTokens: RefreshTokenRepository
  logger: Logger
  intervalMs?: number
}

/**
 * Deletes expired refresh tokens and rotated ones whose reuse window has ended, so the table holds about one row per
 * session. A purged rotated token still reads as a replay: `refresh` treats a signed token with no row as one.
 */
export function startRefreshTokenSweeper(deps: RefreshTokenSweeperDeps): SweeperHandle {
  const intervalMs = deps.intervalMs ?? 600_000
  const logger = deps.logger.child({ sweeper: 'refresh-token' })
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const now = new Date()
      const rotatedBefore = new Date(now.getTime() - REFRESH_REUSE_WINDOW_MS)
      const deleted = await deps.store.transaction(async (tx) => ({
        expired: await deps.refreshTokens.purgeExpired(tx, now),
        rotated: await deps.refreshTokens.purgeRotated(tx, rotatedBefore),
      }))
      if (deleted.expired > 0 || deleted.rotated > 0) {
        logger.info(deleted, 'deleted expired and rotated refresh tokens')
      }
    } catch (err) {
      logger.error({ err }, 'refresh token sweep failed; undeleted rows stay for the next run')
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  handle.unref()
  return {
    tick,
    stop() {
      clearInterval(handle)
    },
  }
}
