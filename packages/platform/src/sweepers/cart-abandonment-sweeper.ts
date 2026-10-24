import { EVT_CART_ABANDONED, type Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { CartRepository } from '../repositories/cart.js'
import type { EventPublisher } from '../events/publisher.js'
import {
  currentCorrelationId,
  newCorrelationId,
  runWithCorrelation,
} from '../events/correlation.js'
import { runAsActor } from '../audit/actor.js'
import { audit, auditedCommand } from '../audit/audit.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

const COMMAND = 'cart.sweepAbandoned'

export interface CartAbandonmentSweeperDeps {
  store: CommandStore
  carts: CartRepository
  publisher: EventPublisher
  logger: Logger
  intervalMs?: number
  inactivityMs?: number
  /** Carts claimed per transaction; a tick runs as many as it takes to reach every due cart. */
  batchSize?: number
  now?: () => Date
}

/**
 * Deletes expired carts, then notifies each cart idle past `inactivityMs` once per inactivity period. The notice is
 * a durable claim on the cart row, committed with its `cart.abandoned` event, so a restart or another replica's
 * sweeper does not notify the same period again; a cart write clears the claim.
 */
export function startCartAbandonmentSweeper(deps: CartAbandonmentSweeperDeps): SweeperHandle {
  const { store, carts, publisher } = deps
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const inactivityMs = deps.inactivityMs ?? 24 * 60 * 60_000
  const batchSize = deps.batchSize ?? 500
  const now = deps.now ?? (() => new Date())
  const logger = deps.logger.child({ sweeper: 'cart-abandonment' })

  async function tick(): Promise<void> {
    try {
      const at = now()
      const window = { at, cutoff: new Date(at.getTime() - inactivityMs) }
      // The run is one command, noted only once it changes a cart. Its subject is the run, never a cart's token: a token
      // is a bearer credential, and an entry is kept for good.
      const noteRun = () =>
        audit.note(COMMAND, [{ type: 'sweep', id: currentCorrelationId() ?? 'cart-abandonment' }])
      // Expired carts go first, so a cart past its expiry is never notified.
      const expired = await store.transaction(async (tx) => {
        const deleted = await carts.deleteExpired(tx, at)
        if (deleted > 0) noteRun()
        return deleted
      })
      let abandoned = 0
      // Pages follow the token order rather than "whatever is still unclaimed", so a pass ends even when another
      // sweeper holds or has taken some of the rows.
      let after: string | undefined
      for (;;) {
        const page = await store.transaction(async (tx) => {
          const tokens = await carts.listAbandoned(tx, window, { after, limit: batchSize })
          for (const token of tokens) {
            const claimed = await carts.claimAbandoned(tx, token, window)
            if (claimed === null) continue
            noteRun()
            await publisher.publish(EVT_CART_ABANDONED, {
              cartId: claimed.token,
              lastActivityAt: claimed.lastActivityAt,
            })
            abandoned += 1
          }
          return tokens
        })
        if (page.length < batchSize) break
        after = page[page.length - 1]
      }
      if (expired > 0 || abandoned > 0) logger.info({ expired, abandoned }, 'carts swept')
    } catch (err) {
      logger.error({ err }, 'cart-abandonment sweep failed')
    }
  }

  // Each run is one operation: its events share an id of their own, and it is one command of the system's.
  const run = () =>
    runWithCorrelation(newCorrelationId('sweep:cart-abandonment'), () =>
      runAsActor({ kind: 'system', id: 'cart-abandonment' }, () =>
        auditedCommand(store, COMMAND, tick),
      ),
    )
  const handle = setInterval(() => void run(), intervalMs)
  return {
    tick: run,
    stop() {
      clearInterval(handle)
    },
  }
}
