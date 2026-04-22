import type { Logger } from '@nymbal/types'
import type { InventoryService } from '../services/inventory-service.js'
import type { InventoryReservationRepository } from '../repositories/inventory-reservation.js'

export interface SweeperHandle {
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
      const expired = await deps.reservationRepo.deleteExpiredBefore(new Date())
      if (expired.length > 0) {
        logger.info({ count: expired.length }, 'releasing expired reservations')
      }
      for (const r of expired) {
        // Individually release — avoids touching the tx mid-scan.
        await deps.inventoryService
          .releaseReservation(r.reservationId, 'expired')
          .catch((err) => {
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
    stop() {
      clearInterval(handle)
    },
  }
}
