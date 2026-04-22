import {
  EVT_CART_ABANDONED,
  type Cart,
  type DocumentStoreAdapter,
  type Logger,
} from '@nymbal/types'
import type { EventPublisher } from '../events/publisher.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

export interface CartAbandonmentSweeperDeps {
  documentStore: DocumentStoreAdapter
  publisher: EventPublisher
  logger: Logger
  intervalMs?: number
  inactivityMs?: number
}

const COLLECTION = 'carts'

export function startCartAbandonmentSweeper(deps: CartAbandonmentSweeperDeps): SweeperHandle {
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const inactivityMs = deps.inactivityMs ?? 24 * 60 * 60_000
  const logger = deps.logger.child({ sweeper: 'cart-abandonment' })
  const notifiedCarts = new Set<string>()

  async function tick(): Promise<void> {
    const cutoff = Date.now() - inactivityMs
    try {
      // In-memory doc store doesn't support range-by-updatedAt; scan all.
      const result = await deps.documentStore.query<Cart>(COLLECTION, {
        partitionKey: { field: 'currency', value: '*' },
        limit: 1000,
      })
      let abandoned = 0
      for (const cart of result.items) {
        if (notifiedCarts.has(cart.token)) continue
        if (!cart.items.length) continue
        const updated = new Date(cart.updatedAt).getTime()
        if (updated < cutoff) {
          await deps.publisher.publish(EVT_CART_ABANDONED, {
            cartId: cart.token,
            lastActivityAt: cart.updatedAt,
          })
          notifiedCarts.add(cart.token)
          abandoned += 1
        }
      }
      if (abandoned > 0) logger.info({ abandoned }, 'abandoned carts detected')
    } catch (err) {
      logger.error({ err }, 'cart-abandonment sweep failed')
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  return {
    stop() {
      clearInterval(handle)
      notifiedCarts.clear()
    },
  }
}
