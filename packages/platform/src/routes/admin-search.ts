import type { HttpAdapter } from '@nymbal/types'
import type { OrderService } from '../services/order-service.js'
import type { ProductService } from '../services/product-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminSearchRouteDeps {
  order: OrderService
  product: ProductService
  repos: Repositories
}

export function registerAdminSearchRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminSearchRouteDeps,
): void {
  const { product, repos } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/search',
    requireRole('admin', async (ctx) => {
      try {
        const qRaw = Array.isArray(ctx.query.q) ? ctx.query.q[0] : ctx.query.q
        if (!qRaw?.trim()) {
          return fail('search.invalid', 'q parameter required', 400)
        }
        const q = qRaw.toLowerCase()

        // Orders
        const allOrders = await repos.order.list({ limit: 100 })
        const matchedOrders = allOrders
          .filter(
            (o) =>
              o.orderNumber.toLowerCase().includes(q) ||
              o.email.toLowerCase().includes(q),
          )
          .slice(0, 5)

        // Products
        const allProducts = await product.list({ limit: 200 })
        const matchedProducts = allProducts
          .filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
          .slice(0, 5)

        // Customers — discover via orders
        const allOrdersFull = await repos.order.list({ limit: 500 })
        const customerIdSet = new Set<string>()
        for (const o of allOrdersFull) {
          if (o.customerId) customerIdSet.add(o.customerId)
        }
        const customerResults = await Promise.all(
          [...customerIdSet].map((id) => repos.customer.findById(id)),
        )
        const matchedCustomers = customerResults
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .filter(
            (c) =>
              c.email.toLowerCase().includes(q) ||
              c.firstName.toLowerCase().includes(q) ||
              c.lastName.toLowerCase().includes(q),
          )
          .slice(0, 5)
          .map(({ passwordHash: _pw, ...rest }) => rest)

        return ok({
          orders: matchedOrders,
          products: matchedProducts,
          customers: matchedCustomers,
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
