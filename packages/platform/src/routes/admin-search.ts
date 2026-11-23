import type { HttpAdapter } from '@nymbalhq/types'
import type { OrderService } from '../services/order-service.js'
import type { ProductService } from '../services/product-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

/** At most this many of each kind. */
const LIMIT = 5

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
        // An order whose number is the term comes first: `NYM-1042` is held by NYM-10420..10429, all newer.
        const { orders, customers } = await repos.order.store.read(async (tx) => {
          const exact = await repos.order.list(tx, { number: qRaw, limit: LIMIT })
          const holding = await repos.order.list(tx, { q: qRaw, limit: LIMIT + exact.length })
          const exactIds = new Set(exact.map((o) => o.id))
          return {
            orders: [...exact, ...holding.filter((o) => !exactIds.has(o.id))].slice(0, LIMIT),
            customers: await repos.customer.search(tx, { q: qRaw, limit: LIMIT }),
          }
        })

        const matchedProducts = await product.list({ q: qRaw, limit: LIMIT })

        return ok({
          orders,
          products: matchedProducts,
          customers: customers.map(({ passwordHash: _pw, ...rest }) => rest),
        })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
