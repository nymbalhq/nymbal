import {
  NotFoundError,
  type DocumentStoreAdapter,
  type HttpAdapter,
} from '@nymbal/types'
import type { OrderService } from '../services/order-service.js'
import { ok, fail, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

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
        const result = await documentStore.query('orders-by-customer', {
          partitionKey: { field: 'partitionKey', value: `customer:${customerId}` },
          limit: 50,
        })
        return ok(result.items, { nextCursor: result.nextCursor })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute('GET', '/api/orders/:orderNumber', async (ctx) => {
    try {
      const orderNumber = ctx.params.orderNumber
      if (!orderNumber) return fail('orders.invalid', 'orderNumber required', 400)
      const doc = await documentStore.get('orders', orderNumber)
      if (!doc) throw new NotFoundError('order', orderNumber)
      // For authenticated users, only allow their own orders
      if (ctx.auth?.userId) {
        const o = doc as { customerId?: string }
        if (o.customerId && o.customerId !== ctx.auth.userId) {
          return fail('auth.forbidden', 'forbidden', 403)
        }
      }
      return ok(doc)
    } catch (err) {
      return renderError(err)
    }
  })
}
