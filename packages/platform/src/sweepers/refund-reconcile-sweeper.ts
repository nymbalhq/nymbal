import type { Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { OrderRefundRepository } from '../repositories/order-refund.js'
import { RECONCILE_MIN_AGE_MS, type RefundService } from '../services/refund-service.js'
import { newCorrelationId, runWithCorrelation } from '../events/correlation.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

const BATCH_LIMIT = 50

export interface RefundReconcileSweeperDeps {
  store: CommandStore
  refunds: OrderRefundRepository
  service: Pick<RefundService, 'reconcileOrder'>
  logger: Logger
  intervalMs?: number
}

/** Gives every pending refund its exit: the provider's list settles it, or it fails when the provider never had it. */
export function startRefundReconcileSweeper(deps: RefundReconcileSweeperDeps): SweeperHandle {
  const intervalMs = deps.intervalMs ?? 300_000
  const logger = deps.logger.child({ sweeper: 'refund-reconcile' })
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const before = new Date(Date.now() - RECONCILE_MIN_AGE_MS)
      const orderIds = await deps.store.read((tx) =>
        deps.refunds.pendingOrderIds(tx, before, BATCH_LIMIT),
      )
      for (const orderId of orderIds) {
        // Each order is its own command, so one that changes nothing writes no audit entry.
        await auditedCommand(deps.store, 'order.reconcileRefunds', () =>
          deps.service.reconcileOrder(orderId),
        ).catch((err) => {
          logger.error({ err, orderId }, 'failed to reconcile the order’s pending refunds')
        })
      }
    } catch (err) {
      logger.error({ err }, 'refund reconcile sweep failed; pending rows stay for the next run')
    } finally {
      running = false
    }
  }

  // Each run is one operation: its events share an id of their own, and its commands are the system's.
  const run = () =>
    runWithCorrelation(newCorrelationId('sweep:refund-reconcile'), () =>
      runAsActor({ kind: 'system', id: 'refund-reconcile' }, tick),
    )
  const handle = setInterval(() => void run(), intervalMs)
  handle.unref()
  return {
    tick: run,
    stop() {
      clearInterval(handle)
    },
  }
}
