import type { HttpAdapter, OrderLineItem, OrderStatus } from '@nymbal/types'
import type { OrderService } from '../services/order-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface NoteEntry {
  body: string
  actor: string
  at: string
}

export interface RegisterAdminOrdersRoutesDeps {
  order: OrderService
  repos: Repositories
}

function parseNotes(rawNotes: string, createdAt: string): NoteEntry[] {
  if (!rawNotes) return []
  try {
    const parsed = JSON.parse(rawNotes) as unknown
    if (Array.isArray(parsed)) return parsed as NoteEntry[]
    // old plain-string format
    return [{ body: rawNotes, actor: 'system', at: createdAt }]
  } catch {
    return [{ body: rawNotes, actor: 'system', at: createdAt }]
  }
}

export function registerAdminOrdersRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminOrdersRoutesDeps,
): void {
  const { order, repos } = deps

  // GET /api/admin/orders
  adapter.registerRoute(
    'GET',
    '/api/admin/orders',
    requireRole('admin', async (ctx) => {
      try {
        const q = ctx.query
        const statusRaw = Array.isArray(q.status) ? q.status[0] : q.status
        const dateFrom = Array.isArray(q.dateFrom) ? q.dateFrom[0] : q.dateFrom
        const dateTo = Array.isArray(q.dateTo) ? q.dateTo[0] : q.dateTo
        const customer = Array.isArray(q.customer) ? q.customer[0] : q.customer
        const search = Array.isArray(q.q) ? q.q[0] : q.q
        const limitRaw = Array.isArray(q.limit) ? q.limit[0] : q.limit
        const offsetRaw = Array.isArray(q.offset) ? q.offset[0] : q.offset

        const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 50, 200) : 50
        const offset = offsetRaw ? parseInt(offsetRaw, 10) || 0 : 0

        const listOpts: { status?: OrderStatus; limit?: number; offset?: number } = {
          limit: limit + offset + 200, // over-fetch for in-memory filtering
          offset: 0,
        }
        if (statusRaw) listOpts.status = statusRaw as OrderStatus
        let orders = await repos.order.list(listOpts)

        // In-memory filters
        if (dateFrom) {
          const from = new Date(dateFrom)
          orders = orders.filter((o) => new Date(o.createdAt) >= from)
        }
        if (dateTo) {
          const to = new Date(dateTo)
          orders = orders.filter((o) => new Date(o.createdAt) <= to)
        }
        if (customer) {
          const lc = customer.toLowerCase()
          orders = orders.filter(
            (o) =>
              (o.customerId ?? '').toLowerCase().includes(lc) ||
              o.email.toLowerCase().includes(lc),
          )
        }
        if (search) {
          const lc = search.toLowerCase()
          orders = orders.filter(
            (o) =>
              o.orderNumber.toLowerCase().includes(lc) ||
              o.email.toLowerCase().includes(lc),
          )
        }

        // Pagination slice
        const page = orders.slice(offset, offset + limit)
        return ok(page)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/orders/:orderNumber
  adapter.registerRoute(
    'GET',
    '/api/admin/orders/:orderNumber',
    requireRole('admin', async (ctx) => {
      try {
        const orderNumber = ctx.params.orderNumber
        if (!orderNumber) return fail('admin.invalid', 'orderNumber required', 400)
        const found = await repos.order.findByOrderNumber(orderNumber)
        if (!found) return fail('orders.not_found', `Order not found: ${orderNumber}`, 404)
        const history = await repos.orderHistory.listByOrder(found.id)
        return ok({ ...found, history })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/confirm
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/confirm',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const fresh = await order.updateStatus(id, 'confirmed', `admin:${ctx.auth!.userId}`)
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/process — confirmed → processing
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/process',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const fresh = await order.updateStatus(id, 'processing', `admin:${ctx.auth!.userId}`)
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/cancel
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/cancel',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { reason?: string } | undefined
        const reason = body?.reason ?? 'Cancelled by admin'
        const fresh = await order.cancel(id, reason, `admin:${ctx.auth!.userId}`)
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/mark-paid
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/mark-paid',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as {
          paymentIntentId?: string
          amountMinor?: number
          currency?: string
        } | undefined
        if (!body?.paymentIntentId) {
          return fail('orders.invalid', 'paymentIntentId required', 400)
        }
        if (body.amountMinor == null) {
          return fail('orders.invalid', 'amountMinor required', 400)
        }
        if (!body.currency) {
          return fail('orders.invalid', 'currency required', 400)
        }
        const fresh = await order.markPaid(
          id,
          body.paymentIntentId,
          body.amountMinor,
          body.currency,
        )
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/mark-delivered
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/mark-delivered',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const fresh = await order.markDelivered(id, `admin:${ctx.auth!.userId}`)
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/ship
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/ship',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { trackingNumber?: string; carrier?: string } | undefined
        if (!body?.trackingNumber || !body.carrier) {
          return fail('orders.invalid', 'trackingNumber and carrier required', 400)
        }
        const fresh = await order.markShipped(
          id,
          body.trackingNumber,
          body.carrier,
          `admin:${ctx.auth!.userId}`,
        )
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/refund
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/refund',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { amountMinor?: number; reason?: string } | undefined
        if (!body?.amountMinor) return fail('orders.invalid', 'amountMinor required', 400)
        const fresh = await order.refund(
          id,
          body.amountMinor,
          body.reason ?? 'admin refund',
          `admin:${ctx.auth!.userId}`,
        )
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/partial-refund
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/partial-refund',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as {
          amountMinor?: number
          reason?: string
          lineItems?: OrderLineItem[]
        } | undefined
        if (body?.amountMinor == null) {
          return fail('orders.invalid', 'amountMinor required', 400)
        }
        const fresh = await order.partialRefund(
          id,
          body.amountMinor,
          body.lineItems ?? [],
          body.reason ?? 'partial refund',
          `admin:${ctx.auth!.userId}`,
        )
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/orders/:id/timeline
  adapter.registerRoute(
    'GET',
    '/api/admin/orders/:id/timeline',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        // Try direct id lookup first, then orderNumber
        let found = await repos.order.findById(id)
        if (!found) found = await repos.order.findByOrderNumber(id)
        if (!found) return fail('orders.not_found', `Order not found: ${id}`, 404)
        const history = await repos.orderHistory.listByOrder(found.id)
        return ok(history)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/orders/:id/notes
  adapter.registerRoute(
    'GET',
    '/api/admin/orders/:id/notes',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        let found = await repos.order.findById(id)
        if (!found) found = await repos.order.findByOrderNumber(id)
        if (!found) return fail('orders.not_found', `Order not found: ${id}`, 404)
        const notes = parseNotes(found.notes, found.createdAt)
        return ok(notes)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/notes
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/notes',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { body?: string } | undefined
        if (!body?.body?.trim()) {
          return fail('orders.invalid', 'note body required', 400)
        }
        let found = await repos.order.findById(id)
        if (!found) found = await repos.order.findByOrderNumber(id)
        if (!found) return fail('orders.not_found', `Order not found: ${id}`, 404)

        const existing = parseNotes(found.notes, found.createdAt)
        const newNote: NoteEntry = {
          body: body.body.trim(),
          actor: `admin:${ctx.auth!.userId}`,
          at: new Date().toISOString(),
        }
        const updated = [...existing, newNote]
        const now = new Date()
        await repos.order.setNotes(found.id, JSON.stringify(updated), now)
        return ok({ note: newNote })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/orders/:id/resend-confirmation
  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/resend-confirmation',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        return ok({ sent: true, orderId: id })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
