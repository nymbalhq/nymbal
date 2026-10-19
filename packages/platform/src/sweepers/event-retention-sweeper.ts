import type { Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { EventLogRepository } from '../repositories/event-log.js'
import type { ProcessedEventRepository } from '../repositories/processed-event.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

export interface EventRetentionSweeperDeps {
  store: CommandStore
  eventLog: EventLogRepository
  processedEvents: ProcessedEventRepository
  logger: Logger
  retentionDays?: number
  intervalMs?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Deletes delivered events and processed-event records older than the window; undelivered and dead events stay. */
export function startEventRetentionSweeper(deps: EventRetentionSweeperDeps): SweeperHandle {
  const retentionDays = deps.retentionDays ?? 30
  const intervalMs = deps.intervalMs ?? 3_600_000
  const logger = deps.logger.child({ sweeper: 'event-retention' })
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS)
      const deleted = await deps.store.transaction(async (tx) => ({
        events: await deps.eventLog.deleteDeliveredBefore(tx, cutoff),
        processed: await deps.processedEvents.deleteBefore(tx, cutoff),
      }))
      if (deleted.events > 0 || deleted.processed > 0) {
        logger.info({ ...deleted, cutoff: cutoff.toISOString() }, 'deleted expired event records')
      }
    } catch (err) {
      logger.error({ err }, 'event retention sweep failed')
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
