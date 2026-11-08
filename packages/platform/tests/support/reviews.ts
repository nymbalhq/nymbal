import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { OrderLineItem, OrderStatus, Review } from '@nymbalhq/types'
import { address, type Kernel } from './kernel.js'
import type { RawReader } from './raw.js'
import { primedShopper } from './security.js'
import type { ShopResponse } from './shopper.js'
import { unaudited } from './write-audit.js'

// A shopper who reviews over HTTP against a served kernel, the review rows and events as a second connection reads
// them, and orders written straight to the command store (a review reads what the customer bought, not how).

export const ROUTE = '/api/reviews'
export const SUBMITTED = 'review.submitted.v1'
const PASSWORD = 'reviews-correct-horse'

/** The order statuses that may verify a review; a fully refunded order never does, at any of them. */
export const PAID: readonly OrderStatus[] = [
  'confirmed',
  'processing',
  'shipped',
  'delivered',
]

export const ALL_STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]

export interface ReviewRow {
  id: string
  productId: string
  customerId: string | null
  orderId: string | null
  rating: number
  moderationStatus: string
}

export interface Reviewer {
  id: string
  email: string
  firstName: string
  lastName: string
  token: string
  /** `POST /api/reviews` with this reviewer's bearer and CSRF pair. */
  submit(body: unknown): Promise<ShopResponse<{ review: Review }>>
}

/** A customer registered over HTTP (with a name, which the review's author is read from), holding its bearer. */
export async function reviewer(baseUrl: string): Promise<Reviewer> {
  const shop = await primedShopper(baseUrl)
  const email = `reviewer-${randomUUID()}@reviews.test`
  const firstName = 'Ada'
  const lastName = `Reviewer${randomUUID().slice(0, 6)}`
  const registered = await shop.call<{ customer: { id: string }; accessToken: string }>(
    'POST',
    '/api/auth/register',
    { email, password: PASSWORD, firstName, lastName },
  )
  if (registered.status !== 201) throw new Error(`register: ${JSON.stringify(registered.body)}`)
  const token = registered.body.data!.accessToken
  return {
    id: registered.body.data!.customer.id,
    email,
    firstName,
    lastName,
    token,
    submit: (body) =>
      shop.call<{ review: Review }>('POST', ROUTE, body, {
        headers: { authorization: `Bearer ${token}` },
      }),
  }
}

/** `POST /api/reviews` with a CSRF pair and no session. */
export async function anonymousSubmit(baseUrl: string, body: unknown) {
  const shop = await primedShopper(baseUrl)
  return shop.call<{ review: Review }>('POST', ROUTE, body)
}

/** `POST /api/reviews` with the reviewer's bearer and no CSRF cookie or header. */
export async function submitWithoutCsrf(
  baseUrl: string,
  who: Reviewer,
  body: unknown,
): Promise<{ status: number; code: string | undefined }> {
  const res = await fetch(new URL(ROUTE, baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${who.token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const parsed = (text === '' ? {} : JSON.parse(text)) as { error?: { code?: string } }
  return { status: res.status, code: parsed.error?.code }
}

/** The `reviews` rows, as a second connection sees them, for one product (and one customer when given). */
export async function reviewRows(
  raw: RawReader,
  productId: string,
  customerId?: string,
): Promise<ReviewRow[]> {
  const rows = await raw.rows<{
    id: string
    product_id: string
    customer_id: string | null
    order_id: string | null
    rating: number | string
    moderation_status: string
  }>(
    `SELECT id, product_id, customer_id, order_id, rating, moderation_status FROM reviews WHERE product_id = ?${
      customerId === undefined ? '' : ' AND customer_id = ?'
    } ORDER BY id`,
    customerId === undefined ? [productId] : [productId, customerId],
  )
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    customerId: r.customer_id,
    orderId: r.order_id,
    rating: Number(r.rating),
    moderationStatus: r.moderation_status,
  }))
}

/** A product of the test's own in `status`, with one variant. */
export async function productIn(
  k: Pick<Kernel, 'services'>,
  status: 'active' | 'draft' | 'archived',
): Promise<string> {
  const tag = randomUUID()
  const product = await k.services.product.create({
    slug: `reviewed-${status}-${tag}`,
    name: `Reviewed ${status} ${tag.slice(0, 6)}`,
    description: '',
    status,
    variants: [{ sku: `REV-${tag}`, name: 'Default', priceMinor: 1500, stock: 10, options: [] }],
  })
  return product.id
}

function lineOf(productId: string): OrderLineItem {
  return {
    variantId: `variant-of-${productId}`,
    productId,
    productName: 'Reviewed product',
    variantName: 'Default',
    sku: `SKU-${productId}`,
    qty: 1,
    unitPriceMinor: 1500,
    lineSubtotalMinor: 1500,
    lineTaxMinor: 0,
    lineTotalMinor: 1500,
    imageUrl: '',
  }
}

export interface OrderSpec {
  customerId: string | null
  status: OrderStatus
  productIds: string[]
  createdAt: Date
  /** What was captured and refunded; nothing when absent. */
  capturedMinor?: number
  refundedMinor?: number
}

/** Writes `orders` in one transaction, in the given order, outside the write audit; returns their ids in that order. */
export async function writeOrders(
  k: Pick<Kernel, 'store' | 'repos'>,
  orders: OrderSpec[],
): Promise<string[]> {
  const ids = orders.map(() => uuidv7())
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      for (const [i, spec] of orders.entries()) {
        const lineItems = spec.productIds.map(lineOf)
        const total = lineItems.reduce((n, l) => n + l.lineTotalMinor, 0)
        const sequence = await k.repos.orderSequence.nextSequence(tx)
        await k.repos.order.insert(tx, {
          id: ids[i]!,
          orderNumber: `REV-${randomUUID().slice(0, 12)}`,
          sequence,
          customerId: spec.customerId,
          status: spec.status,
          email: 'buyer@reviews.test',
          billingAddress: address,
          shippingAddress: address,
          lineItems,
          subtotalMinor: total,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor: total,
          currency: 'GBP',
          notes: '',
          metadata: {},
          paymentIntentId: null,
          ...((spec.capturedMinor ?? 0) > 0 && {
            capture: {
              amountMinor: spec.capturedMinor!,
              method: 'import' as const,
              at: spec.createdAt,
              refundedMinor: spec.refundedMinor ?? 0,
            },
          }),
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt,
        })
      }
    }),
  )
  return ids
}

/** The review an order list makes verified: the newest order holding the product in a paid status, else null. */
export function expectedOrderId(
  orders: Array<OrderSpec & { id: string }>,
  customerId: string,
  productId: string,
): string | null {
  const holding = orders
    .filter(
      (o) =>
        o.customerId === customerId && PAID.includes(o.status) && o.productIds.includes(productId),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  return holding[0]?.id ?? null
}

export interface SubmittedEvent {
  seq: number
  payload: Record<string, unknown>
}

/** The `review.submitted.v1` rows of the log above `afterSeq`, oldest first, with their payloads. */
export async function submittedEvents(raw: RawReader, afterSeq = 0): Promise<SubmittedEvent[]> {
  const rows = await raw.rows<{ seq: number | string; envelope: string | { payload: unknown } }>(
    'SELECT seq, envelope FROM events WHERE type = ? AND seq > ? ORDER BY seq',
    [SUBMITTED, afterSeq],
  )
  return rows.map((r) => {
    const envelope = (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) as {
      payload: Record<string, unknown>
    }
    return { seq: Number(r.seq), payload: envelope.payload }
  })
}
