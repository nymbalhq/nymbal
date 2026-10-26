import {
  OrderConflictError,
  canTransitionOrder,
  type HttpAdapter,
  type Order,
  type OrderPayment,
  type OrderStatus,
} from '@nymbalhq/types'
import type { ReadTx } from '../db/command-store.js'
import type { OrderService } from '../services/order-service.js'
import type { ManualPayments } from '../services/checkout-service.js'
import { orderPayment, type RefundService } from '../services/refund-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { audit } from '../audit/audit.js'
import { idempotencyKeyOf } from '../audit/idempotency.js'
import { requireRole } from './role-middleware.js'
import { answerAsOf, answerHistory, atOf } from '../history/http.js'
import type { HistoryReader, HistorySubject } from '../history/read.js'

export interface NoteEntry {
  body: string
  actor: string
  at: string
}

export interface RegisterAdminOrdersRoutesDeps {
  order: OrderService
  checkout: ManualPayments
  refund: RefundService
  repos: Repositories
  history: HistoryReader
}

/** An order as the admin reads it: with what was actually paid and refunded. */
type AdminOrder = Order & { payment: OrderPayment }

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
  const { order, checkout, refund, repos, history } = deps
  const { store } = repos.order

  async function withPayments(tx: ReadTx, orders: Order[]): Promise<AdminOrder[]> {
    const refunds = await repos.orderRefund.listByOrders(
      tx,
      orders.map((o) => o.id),
    )
    return orders.map((o) => ({ ...o, payment: orderPayment(o, refunds.get(o.id) ?? []) }))
  }

  /** The order a command left, as the admin reads it. */
  async function adminOrder(fresh: Order): Promise<AdminOrder> {
    const [read] = await store.read((tx) => withPayments(tx, [fresh]))
    return read!
  }

  // Try direct id lookup first, then orderNumber
  async function findOrder(tx: ReadTx, idOrNumber: string): Promise<Order | null> {
    return (
      (await repos.order.findById(tx, idOrNumber)) ??
      (await repos.order.findByOrderNumber(tx, idOrNumber))
    )
  }

  /** The order an id or a number names; an id with no row may still have events. */
  async function historySubject(idOrNumber: string): Promise<HistorySubject> {
    const found = await store.read((tx) => findOrder(tx, idOrNumber))
    return { kind: 'order', id: found?.id ?? idOrNumber, live: found !== null }
  }

  const notFound = (idOrNumber: string) => () =>
    fail('orders.not_found', `Order not found: ${idOrNumber}`, 404)

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
        let orders = await store.read((tx) => repos.order.list(tx, listOpts))

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
              (o.customerId ?? '').toLowerCase().includes(lc) || o.email.toLowerCase().includes(lc),
          )
        }
        if (search) {
          const lc = search.toLowerCase()
          orders = orders.filter(
            (o) => o.orderNumber.toLowerCase().includes(lc) || o.email.toLowerCase().includes(lc),
          )
        }

        // Pagination slice
        const page = orders.slice(offset, offset + limit)
        return ok(await store.read((tx) => withPayments(tx, page)))
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
        const at = atOf(ctx)
        if (at !== undefined) {
          return answerAsOf(history, at, () => historySubject(orderNumber), notFound(orderNumber))
        }
        const detail = await store.read(async (tx) => {
          const found = await repos.order.findByOrderNumber(tx, orderNumber)
          if (!found) return null
          const [read] = await withPayments(tx, [found])
          return { ...read!, history: await repos.orderHistory.listByOrder(tx, found.id) }
        })
        if (!detail) return fail('orders.not_found', `Order not found: ${orderNumber}`, 404)
        return ok(detail)
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
        // Only money confirms an order: an unpaid one is confirmed by recording its payment (mark-paid).
        const current = await order.getById(id)
        if (canTransitionOrder(current.status, 'confirmed') && current.capturedMinor === 0) {
          throw new OrderConflictError(
            'order.unpaid',
            `Order ${current.orderNumber} is unpaid: record its payment to confirm it`,
          )
        }
        const fresh = await order.updateStatus(id, 'confirmed', `admin:${ctx.auth!.userId}`)
        return ok(await adminOrder(fresh))
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
        return ok(await adminOrder(fresh))
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
        return ok(await adminOrder(fresh))
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
        const body = ctx.body as { note?: string } | undefined
        const fresh = await checkout.markPaid(id, `admin:${ctx.auth!.userId}`, body?.note)
        return ok(await adminOrder(fresh))
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
        return ok(await adminOrder(fresh))
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
        return ok(await adminOrder(fresh))
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
        const body = ctx.body as { amountMinor: number; reason?: string; requestId?: string }
        // A keyed refund runs outside the key's transaction, so a retry whose first attempt moved money but never
        // recorded its key must still find that refund: the key stands in for a requestId the caller did not send.
        const keyed = idempotencyKeyOf(ctx)
        const requestId = body.requestId ?? ('key' in keyed ? keyed.key : undefined)
        const result = await refund.refund({
          orderId: id,
          amountMinor: body.amountMinor,
          ...(body.reason !== undefined && { reason: body.reason }),
          ...(requestId !== undefined && { requestId }),
          actor: `admin:${ctx.auth!.userId}`,
        })
        return ok(result)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/orders/:id/history
  adapter.registerRoute(
    'GET',
    '/api/admin/orders/:id/history',
    requireRole('admin', async (ctx) => {
      const id = ctx.params.id
      if (!id) return fail('admin.invalid', 'id required', 400)
      return answerHistory(history, ctx, () => historySubject(id), notFound(id))
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
        const history = await store.read(async (tx) => {
          const found = await findOrder(tx, id)
          return found ? repos.orderHistory.listByOrder(tx, found.id) : null
        })
        if (!history) return fail('orders.not_found', `Order not found: ${id}`, 404)
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
        const found = await store.read((tx) => findOrder(tx, id))
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
        const newNote: NoteEntry = {
          body: body.body.trim(),
          actor: `admin:${ctx.auth!.userId}`,
          at: new Date().toISOString(),
        }
        const noted = await store.transaction(async (tx) => {
          const found = await findOrder(tx, id)
          if (!found) return false
          audit.note('order.addNote', [{ type: 'order', id: found.id }])
          const updated = [...parseNotes(found.notes, found.createdAt), newNote]
          await repos.order.setNotes(tx, found.id, JSON.stringify(updated), new Date())
          return true
        })
        if (!noted) return fail('orders.not_found', `Order not found: ${id}`, 404)
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
        // Queued, not yet sent: the email handler sends it, and the relay retries a refused send.
        const queued = await order.resendConfirmation(id)
        return ok({ orderId: queued.id, orderNumber: queued.orderNumber, email: queued.email })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
