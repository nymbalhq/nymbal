import { NotFoundError, type DocumentStoreAdapter, type HttpAdapter } from '@nymbalhq/types'
import type { OrderDoc } from '../read-models/builders.js'
import type { OrderService } from '../services/order-service.js'
import { ok, fail, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

/**
 * An order as a shopper reads it. The stored document keeps checkout's cart and stock bookkeeping, import provenance,
 * the merchant's notes, the provider's intent id and which staff member moved the order; the admin routes read all of
 * it, a shopper none. Blanked rather than dropped, so the `Order` shape the SDK declares still holds.
 */
export function shopperOrder(doc: OrderDoc) {
  const { partitionKey: _partitionKey, sortKey: _sortKey, history, ...order } = doc
  return {
    ...order,
    metadata: {},
    notes: '',
    paymentIntentId: null,
    ...(history !== undefined && { history: history.map(({ actor: _actor, ...entry }) => entry) }),
  }
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

  adapter.registerRoute('GET', '/api/orders/:orderNumber', async (ctx) => {
    try {
      const orderNumber = ctx.params.orderNumber
      if (!orderNumber) return fail('orders.invalid', 'orderNumber required', 400)
      const doc = await documentStore.get<OrderDoc>('orders', orderNumber)
      if (!doc) throw new NotFoundError('order', orderNumber)
      // For authenticated users, only allow their own orders
      if (ctx.auth?.userId) {
        if (doc.customerId && doc.customerId !== ctx.auth.userId) {
          return fail('auth.forbidden', 'forbidden', 403)
        }
      }
      return ok(shopperOrder(doc))
    } catch (err) {
      return renderError(err)
    }
  })
}
