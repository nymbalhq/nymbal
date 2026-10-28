import {
  NotFoundError,
  ORDER_KEY_HEADER,
  type DocumentStoreAdapter,
  type HttpAdapter,
  type RequestContext,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import type { OrderDoc } from '../read-models/builders.js'
import type { OrderService } from '../services/order-service.js'
import { ok, fail, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

/**
 * An order as a shopper reads it. The stored document keeps checkout's cart and stock bookkeeping, import provenance,
 * the merchant's notes, the provider's intent id and the status history with its staff actors and free-text notes;
 * the admin routes read all of it, a shopper none and `timeline` in place of the history. `metadata`, `notes` and
 * `paymentIntentId` are blanked rather than dropped, so the `Order` shape the SDK declares still holds.
 */
export function shopperOrder(doc: OrderDoc) {
  const { partitionKey: _partitionKey, sortKey: _sortKey, history: _history, ...order } = doc
  return { ...order, metadata: {}, notes: '', paymentIntentId: null }
}

export function registerOrderRoutes(
  adapter: HttpAdapter,
  orders: OrderService,
  documentStore: DocumentStoreAdapter,
): void {
  adapter.registerRoute(
    'GET',
    '/api/orders',
    requireAuth(async (ctx) => {
      try {
        const customerId = ctx.auth!.userId!
        const result = await documentStore.query<OrderDoc>('orders-by-customer', {
          partitionKey: { field: 'partitionKey', value: `customer:${customerId}` },
          limit: 50,
        })
        return ok(result.items.map(shopperOrder), { nextCursor: result.nextCursor })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  /**
   * The order to its owner's session or to a key that opens it; to anyone else, the answer a number no order has gets,
   * so the route never says an order exists.
   */
  async function readOrder(ctx: RequestContext): Promise<ResponseEnvelope> {
    try {
      const orderNumber = ctx.params.orderNumber
      if (!orderNumber) return fail('orders.invalid', 'orderNumber required', 400)
      const doc = await documentStore.get<OrderDoc>('orders', orderNumber)
      if (!doc) throw new NotFoundError('order', orderNumber)
      const userId = ctx.auth?.userId
      const owner = doc.customerId !== null && userId !== undefined && doc.customerId === userId
      const key = ctx.headers[ORDER_KEY_HEADER]
      if (!owner && !(typeof key === 'string' && (await orders.keyOpens(doc.id, key)))) {
        throw new NotFoundError('order', orderNumber)
      }
      return ok(shopperOrder(doc))
    } catch (err) {
      return renderError(err)
    }
  }

  // No shared cache may answer a keyless request with what a keyed one was served.
  adapter.registerRoute('GET', '/api/orders/:orderNumber', async (ctx) => ({
    ...(await readOrder(ctx)),
    headers: { 'Cache-Control': 'no-store' },
  }))
}
