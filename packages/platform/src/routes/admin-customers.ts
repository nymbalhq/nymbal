import type { HttpAdapter, Customer, Order } from '@nymbal/types'
import type { OrderService } from '../services/order-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface NoteEntry {
  body: string
  actor: string
  at: string
}

export interface CustomerStats {
  orderCount: number
  lifetimeRevenueMinor: number
  avgOrderValueMinor: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export interface RegisterAdminCustomersRoutesDeps {
  order: OrderService
  repos: Repositories
}

function computeStats(orders: Order[]): CustomerStats {
  if (orders.length === 0) {
    return {
      orderCount: 0,
      lifetimeRevenueMinor: 0,
      avgOrderValueMinor: 0,
      firstOrderAt: null,
      lastOrderAt: null,
    }
  }
  const sorted = [...orders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  const paidStatuses = new Set(['confirmed', 'processing', 'shipped', 'delivered', 'partially_refunded'])
  const lifetimeRevenueMinor = orders
    .filter((o) => paidStatuses.has(o.status))
    .reduce((sum, o) => sum + o.totalMinor, 0)
  return {
    orderCount: orders.length,
    lifetimeRevenueMinor,
    avgOrderValueMinor: orders.length > 0 ? Math.round(lifetimeRevenueMinor / orders.length) : 0,
    firstOrderAt: sorted[0]?.createdAt ?? null,
    lastOrderAt: sorted[sorted.length - 1]?.createdAt ?? null,
  }
}

export function registerAdminCustomersRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminCustomersRoutesDeps,
): void {
  const { repos } = deps

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

        // Use order list to discover customers (v0.1 approach)
        const allOrders = await repos.order.list({ limit: 500 })
        const customerIdSet = new Set<string>()
        for (const o of allOrders) {
          if (o.customerId) customerIdSet.add(o.customerId)
        }

        const customerResults = await Promise.all(
          [...customerIdSet].map((id) => repos.customer.findById(id)),
        )
        let customers: Customer[] = customerResults
          .filter((c): c is NonNullable<typeof c> => c !== null)
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
        const raw = await repos.customer.findById(id)
        if (!raw) return fail('customers.not_found', `Customer not found: ${id}`, 404)
        const { passwordHash: _pw, ...customer } = raw
        const orders = await repos.order.listByCustomer(id)
        const stats = computeStats(orders)
        return ok({ customer, stats })
      } catch (err) {
        return renderError(err)
      }
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
        const orders = await repos.order.listByCustomer(id)
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
        const raw = await repos.customer.findById(id)
        if (!raw) return fail('customers.not_found', `Customer not found: ${id}`, 404)

        const existingNotes = (raw.metadata.adminNotes as NoteEntry[] | undefined) ?? []
        const newNote: NoteEntry = {
          body: body.body.trim(),
          actor: `admin:${ctx.auth!.userId}`,
          at: new Date().toISOString(),
        }
        const updatedMeta = {
          ...raw.metadata,
          adminNotes: [...existingNotes, newNote],
        }
        await repos.customer.update(id, {
          metadata: updatedMeta,
          updatedAt: new Date(),
        })
        return ok({ note: newNote })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
