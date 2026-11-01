import { NotFoundError, type HttpAdapter, type Customer } from '@nymbalhq/types'
import type { OrderService } from '../services/order-service.js'
import type { CustomerNote, CustomerService } from '../services/customer-service.js'
import type { Repositories } from '../repositories/index.js'
import type { CustomerOrderTotals } from '../repositories/order.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'
import { answerAsOf, answerHistory, atOf } from '../history/http.js'
import type { HistoryReader, HistorySubject } from '../history/read.js'

export type NoteEntry = CustomerNote

export interface CustomerStats {
  orderCount: number
  lifetimeRevenueMinor: number
  avgOrderValueMinor: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export interface RegisterAdminCustomersRoutesDeps {
  order: OrderService
  customer: CustomerService
  repos: Repositories
  history: HistoryReader
}

function statsOf(totals: CustomerOrderTotals): CustomerStats {
  return {
    orderCount: totals.orderCount,
    lifetimeRevenueMinor: totals.keptMinor,
    // Over the orders that took money: an abandoned pending order does not pull the average down.
    avgOrderValueMinor:
      totals.capturedCount > 0 ? Math.round(totals.keptMinor / totals.capturedCount) : 0,
    firstOrderAt: totals.firstAt,
    lastOrderAt: totals.lastAt,
  }
}

export function registerAdminCustomersRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminCustomersRoutesDeps,
): void {
  const { repos, history } = deps
  const { store } = repos.customer

  async function historySubject(id: string): Promise<HistorySubject> {
    const found = await store.read((tx) => repos.customer.findById(tx, id))
    return { kind: 'customer', id, live: found !== null }
  }

  const notFound = (id: string) => () =>
    fail('customers.not_found', `Customer not found: ${id}`, 404)

  // GET /api/admin/customers
  adapter.registerRoute(
    'GET',
    '/api/admin/customers',
    requireRole('admin', async (ctx) => {
      try {
        const q = ctx.query
        const search = Array.isArray(q.q) ? q.q[0] : q.q
        const sortRaw = Array.isArray(q.sort) ? q.sort[0] : q.sort
        const limitRaw = Array.isArray(q.limit) ? q.limit[0] : q.limit
        const offsetRaw = Array.isArray(q.offset) ? q.offset[0] : q.offset

        const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 50, 200) : 50
        const offset = offsetRaw ? parseInt(offsetRaw, 10) || 0 : 0

        // Every shopper account, ordered or not; staff accounts share the table and are not customers.
        const rows = await store.read((tx) => repos.customer.list(tx))
        let customers: Customer[] = rows
          .filter((c) => c.roles.includes('customer'))
          .map(({ passwordHash: _pw, ...rest }) => rest)

        // q filter
        if (search) {
          const lc = search.toLowerCase()
          customers = customers.filter(
            (c) =>
              c.email.toLowerCase().includes(lc) ||
              c.firstName.toLowerCase().includes(lc) ||
              c.lastName.toLowerCase().includes(lc),
          )
        }

        // Sort
        const sortField = sortRaw?.split(':')[0] ?? 'totalSpentMinor'
        const sortDir = sortRaw?.split(':')[1] ?? 'desc'
        customers.sort((a, b) => {
          const aVal = (a as unknown as Record<string, unknown>)[sortField]
          const bVal = (b as unknown as Record<string, unknown>)[sortField]
          const aNum = typeof aVal === 'number' ? aVal : 0
          const bNum = typeof bVal === 'number' ? bVal : 0
          return sortDir === 'asc' ? aNum - bNum : bNum - aNum
        })

        const page = customers.slice(offset, offset + limit)
        return ok({ customers: page })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/customers/:id
  adapter.registerRoute(
    'GET',
    '/api/admin/customers/:id',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const at = atOf(ctx)
        if (at !== undefined) return answerAsOf(history, at, () => historySubject(id), notFound(id))
        const found = await store.read(async (tx) => {
          const raw = await repos.customer.findById(tx, id)
          return raw ? { raw, totals: await repos.order.totalsByCustomer(tx, id) } : null
        })
        if (!found) return fail('customers.not_found', `Customer not found: ${id}`, 404)
        const { passwordHash: _pw, ...customer } = found.raw
        return ok({ customer, stats: statsOf(found.totals) })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/customers/:id/history
  adapter.registerRoute(
    'GET',
    '/api/admin/customers/:id/history',
    requireRole('admin', async (ctx) => {
      const id = ctx.params.id
      if (!id) return fail('admin.invalid', 'id required', 400)
      return answerHistory(history, ctx, () => historySubject(id), notFound(id))
    }),
  )

  // GET /api/admin/customers/:id/orders
  adapter.registerRoute(
    'GET',
    '/api/admin/customers/:id/orders',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const orders = await store.read((tx) => repos.order.listByCustomer(tx, id))
        return ok(orders)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/customers/:id/notes
  adapter.registerRoute(
    'POST',
    '/api/admin/customers/:id/notes',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { body?: string } | undefined
        if (!body?.body?.trim()) {
          return fail('customers.invalid', 'note body required', 400)
        }
        const newNote: NoteEntry = {
          body: body.body.trim(),
          actor: `admin:${ctx.auth!.userId}`,
          at: new Date().toISOString(),
        }
        try {
          await deps.customer.addNote(id, newNote)
        } catch (err) {
          if (err instanceof NotFoundError) return notFound(id)()
          throw err
        }
        return ok({ note: newNote })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
