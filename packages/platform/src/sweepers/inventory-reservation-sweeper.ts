import type { Logger } from '@nymbalhq/types'
import type { InventoryService } from '../services/inventory-service.js'
import type { InventoryReservationRepository } from '../repositories/inventory-reservation.js'

export interface SweeperHandle {
  /** One sweep, awaited; the interval calls it. */
  tick(): Promise<void>
  stop(): void
}

export interface InventoryReservationSweeperDeps {
  inventoryService: InventoryService
  reservationRepo: InventoryReservationRepository
  logger: Logger
  intervalMs?: number
}

export function startInventoryReservationSweeper(
  deps: InventoryReservationSweeperDeps,
): SweeperHandle {
  const intervalMs = deps.intervalMs ?? 60_000
  const logger = deps.logger.child({ sweeper: 'inventory-reservation' })
  let running = false
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const { store } = deps.reservationRepo
      const now = new Date()
      const expired = await store.read((tx) => deps.reservationRepo.findExpiredBefore(tx, now))
      if (expired.length > 0) {
        logger.info({ count: expired.length }, 'releasing expired reservations')
      }
      for (const r of expired) {
        // releaseReservation deletes the row and restores its stock in one transaction; one that a commit or another
        // release already took is a no-op.
        await deps.inventoryService.releaseReservation(r.reservationId, 'expired').catch((err) => {
          logger.error({ err, reservationId: r.reservationId }, 'failed to release')
        })
      }
    } finally {
      running = false
    }
  }
  const handle = setInterval(() => {
    void tick()
  }, intervalMs)
  return {
    tick,
    stop() {
      clearInterval(handle)
    },
  }
}
