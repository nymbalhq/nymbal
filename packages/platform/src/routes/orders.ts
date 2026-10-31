import {
  NotFoundError,
  ORDER_EMAIL_HEADER,
  ORDER_KEY_HEADER,
  type DocumentStoreAdapter,
  type HttpAdapter,
  type RequestContext,
  type ResponseEnvelope,
  type ShopperOrder,
} from '@nymbalhq/types'
import type { OrderDoc } from '../read-models/builders.js'
import type { OrderService } from '../services/order-service.js'
import { orderEmailMatches } from '../order-access-key.js'
import { ok, fail, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

/**
 * An order as its key holder reads it: what the confirmation page shows, and the shipping address without its phone or
 * company. A key travels in a URL that can be forwarded, so it opens none of the customer's contact details, the
 * billing address, the store's internal ids or the payment's capture.
 */
export function keyedOrder(doc: OrderDoc): ShopperOrder {
  const { phone: _phone, company: _company, ...shippingAddress } = doc.shippingAddress
  return {
    orderNumber: doc.orderNumber,
    status: doc.status,
    timeline: doc.timeline,
    lineItems: doc.lineItems,
    subtotalMinor: doc.subtotalMinor,
    taxTotalMinor: doc.taxTotalMinor,
    shippingTotalMinor: doc.shippingTotalMinor,
    discountTotalMinor: doc.discountTotalMinor,
    totalMinor: doc.totalMinor,
    currency: doc.currency,
    createdAt: doc.createdAt,
    shippingAddress,
  }
}

/**
 * An order as its signed-in owner reads it: the account pages' fields, both addresses and the email. The stored
 * document also keeps checkout's cart and stock bookkeeping, import provenance, the merchant's notes, the provider's
 * intent id, the capture and the status history with its staff actors; the admin routes read all of it.
 */
export function ownerOrder(doc: OrderDoc): ShopperOrder {
  return {
    id: doc.id,
    orderNumber: doc.orderNumber,
    status: doc.status,
    timeline: doc.timeline,
    lineItems: doc.lineItems,
    subtotalMinor: doc.subtotalMinor,
    taxTotalMinor: doc.taxTotalMinor,
    shippingTotalMinor: doc.shippingTotalMinor,
    discountTotalMinor: doc.discountTotalMinor,
    totalMinor: doc.totalMinor,
    refundedMinor: doc.refundedMinor,
    currency: doc.currency,
    email: doc.email,
    billingAddress: doc.billingAddress,
    shippingAddress: doc.shippingAddress,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** The answer to a link request whatever it found: the route never says whether an order matched. */
const LINK_ANSWER = { sent: 'if-matched' } as const

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
        return ok(result.items.map(ownerOrder), { nextCursor: result.nextCursor })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  /**
   * The order to its owner's session, to an unexpired key, or to an expired key beside the order's email; anyone else
   * gets the answer a number no order has, so the route never says an order exists. The one exception is the order's
   * own expired key with no email: only a holder of that key learns it has expired, so the page can ask for the email.
   */
  async function readOrder(ctx: RequestContext): Promise<ResponseEnvelope> {
    try {
      const orderNumber = ctx.params.orderNumber
      if (!orderNumber) return fail('orders.invalid', 'orderNumber required', 400)
      const doc = await documentStore.get<OrderDoc>('orders', orderNumber)
      if (!doc) throw new NotFoundError('order', orderNumber)
      const userId = ctx.auth?.userId
      if (doc.customerId !== null && userId !== undefined && doc.customerId === userId) {
        return ok(ownerOrder(doc))
      }
      const key = ctx.headers[ORDER_KEY_HEADER]
      const state = typeof key === 'string' ? await orders.keyState(doc.id, key) : 'none'
      if (state === 'open') return ok(keyedOrder(doc))
      if (state === 'expired') {
        const email = ctx.headers[ORDER_EMAIL_HEADER]
        if (email === undefined) {
          return fail(
            'orders.key_expired',
            "This order link has expired: give the order's email to open it",
            404,
          )
        }
        if (typeof email === 'string' && orderEmailMatches(doc.email, email)) {
          return ok(keyedOrder(doc))
        }
      }
      throw new NotFoundError('order', orderNumber)
    } catch (err) {
      return renderError(err)
    }
  }

  // No shared cache may answer a keyless request with what a keyed one was served.
  adapter.registerRoute('GET', '/api/orders/:orderNumber', async (ctx) => ({
    ...(await readOrder(ctx)),
    headers: { 'Cache-Control': 'no-store' },
  }))

  adapter.registerRoute('POST', '/api/orders/link', async (ctx) => {
    try {
      const { orderNumber, email } = ctx.body as { orderNumber: string; email: string }
      await orders.requestLink(orderNumber, email)
      return ok(LINK_ANSWER, undefined, 202)
    } catch (err) {
      return renderError(err)
    }
  })
}
