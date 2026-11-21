import { EVT_CUSTOMER_UPDATED, type Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import { newCorrelationId, runWithCorrelation } from '../events/correlation.js'
import type { EventPublisher } from '../events/publisher.js'
import { toCustomerSnapshot } from '../history/views.js'
import type { CustomerRepository } from '../repositories/customer.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

export interface LegacyPasswordSweeperDeps {
  store: CommandStore
  customers: CustomerRepository
  publisher: EventPublisher
  logger: Logger
  /** `security.auth.legacy.until`; with none, nothing is swept. */
  until?: Date
  intervalMs?: number
}

/**
 * Past the store's sunset date, replaces every imported password hash still held with the no-password marker, so
 * weak hashes are not kept at rest and those customers reset. It runs once at start, so a process that lives less
 * than an interval still sweeps, and then each interval; one conditional update makes concurrent replicas harmless.
 */
export function startLegacyPasswordSweeper(deps: LegacyPasswordSweeperDeps): SweeperHandle {
  const { store, customers, publisher, until } = deps
  const intervalMs = deps.intervalMs ?? 3_600_000
  const logger = deps.logger.child({ sweeper: 'legacy-password' })

  async function tick(): Promise<void> {
    if (until === undefined || new Date() < until) return
    try {
      const swept = await store.transaction(async (tx) => {
        const rows = await customers.sunsetLegacyPasswords(tx, new Date())
        await publisher.publishMany(
          rows.map((customer) => ({
            type: EVT_CUSTOMER_UPDATED,
            payload: { customerId: customer.id, customer: toCustomerSnapshot(customer) },
          })),
        )
        return rows.length
      })
      if (swept > 0) logger.info({ swept }, 'imported password hashes past their sunset removed')
    } catch (err) {
      logger.error({ err }, 'imported password sweep failed; the hashes stay for the next run')
    }
  }

  // Each run is one operation: its events share an id of their own. A tick during a run waits for that run.
  let inFlight: Promise<void> | undefined
  const run = (): Promise<void> => {
    inFlight ??= runWithCorrelation(newCorrelationId('sweep:legacy-passwords'), tick).finally(
      () => {
        inFlight = undefined
      },
    )
    return inFlight
  }
  void run()
  const handle = setInterval(() => void run(), intervalMs)
  handle.unref()
  return {
    tick: run,
    stop() {
      clearInterval(handle)
    },
  }
}
